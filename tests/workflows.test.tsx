import { describe, expect, test } from 'claude-code/testing'

import type { Step } from '../types'
import { parseExtraction, reviveSteps } from '../hooks/lib/extract'
import { reconcile, setTarget, targetsLeft } from '../hooks/lib/merge'
import { answered, band, boot, finishTurn, pane, reading, reply, stepButton } from './support'

/**
 * The workflows this mod is used for most: one migration run on several databases in turn (HKL, then NZE/PAW),
 * results pasted back to Claude, and decisions that offer their own answers.
 */

const T0 = 1_700_000_000_000
const step = (id: string, over: Partial<Step> = {}): Step => ({
  id,
  kind: 'sql',
  group: 'you',
  status: 'open',
  title: `Step ${id}`,
  key: id,
  firstSeen: T0,
  lastSeen: T0,
  missed: 0,
  ...over,
})

const REPLY = reply(
  'Step 1: run the read-only preflight on HKL and NZE/PAW, then paste the results back to me.',
  'Step 2: run supabase/97_hs_submission_amendments.sql on HKL first, then on NZE/PAW.',
  'Decision: should backdated rates be allowed, or only future-dated ones?',
)
const STEPS = [
  { group: 'you', kind: 'sql', title: 'Run the read-only preflight', targets: ['HKL', 'NZE/PAW'], asksBack: true },
  { group: 'you', kind: 'sql', title: 'Apply migration 97', path: 'supabase/97_hs_submission_amendments.sql', targets: ['HKL', 'NZE/PAW'] },
  { group: 'decision', kind: 'action', title: 'Choose whether rates may be backdated', options: ['Allow backdating', 'Future-dated only'] },
]

describe('reading places, answers and results', () => {
  test('targets are kept only when the reply names them, and only as a list of two or more', () => {
    const out = parseExtraction(
      JSON.stringify({
        steps: [
          { title: 'Apply 97', kind: 'sql', targets: ['HKL', 'NZE/PAW', 'Mars', 'hkl'] },
          { title: 'Apply 98', kind: 'sql', targets: ['HKL'] },
          { title: 'Apply 99', kind: 'sql', targets: 'HKL' },
        ],
      }),
      'run 97 on HKL then NZE/PAW; 98 and 99 on HKL',
    )
    expect(out?.steps.map(s => s.targets)).toEqual([['HKL', 'NZE/PAW'], undefined, undefined])
  })

  test('only a decision has options; asking for something back is a flag', () => {
    const out = parseExtraction(
      JSON.stringify({
        steps: [
          { title: 'Pick one', group: 'decision', options: ['Yes', 'No', 'Later', 'Never', 'Maybe'] },
          { title: 'Do it', group: 'you', options: ['A', 'B'], asksBack: true },
          { title: 'One choice is no choice', group: 'decision', options: ['Only'] },
        ],
      }),
    )
    expect(out?.steps.map(s => [s.options, s.asksBack])).toEqual([
      [['Yes', 'No', 'Later', 'Never'], undefined],
      [undefined, true],
      [undefined, undefined],
    ])
  })
})

describe('ticking places off', () => {
  test('each place is ticked on its own; the last one closes the step, and unticking opens it again', () => {
    let list = [step('a', { targets: ['HKL', 'NZE/PAW'] })]
    list = setTarget(list, 'a', 'HKL', true, T0 + 1)
    expect([list[0]?.status, targetsLeft(list[0]!)]).toEqual(['open', ['NZE/PAW']])
    list = setTarget(list, 'a', 'NZE/PAW', true, T0 + 2)
    expect([list[0]?.status, list[0]?.closedAt, list[0]?.closedBy]).toEqual(['done', T0 + 2, 'you'])
    list = setTarget(list, 'a', 'HKL', false, T0 + 3)
    expect([list[0]?.status, targetsLeft(list[0]!)]).toEqual(['open', ['HKL']])
    expect(setTarget(list, 'a', 'Mars', true, T0 + 4)).toEqual(list) // a place the step does not have changes nothing
  })

  test('a later reply about the same step keeps the places already ticked, if it still names them', () => {
    const before = [step('a', { title: 'Apply migration 97', key: 't:97 apply migration', targets: ['HKL', 'NZE/PAW'], doneTargets: ['HKL'] })]
    const incoming = [{ kind: 'sql' as const, group: 'you' as const, title: 'Apply migration 97', key: 't:97 apply migration', targets: ['HKL', 'NZE/PAW', 'Staging'] }]
    const after = reconcile(before, incoming, [], T0 + 10).steps
    expect(after[0]?.doneTargets).toEqual(['HKL'])
    expect(targetsLeft(after[0]!)).toEqual(['NZE/PAW', 'Staging'])
  })

  test('ticks are saved with the step and read back', () => {
    const saved = JSON.parse(JSON.stringify([step('a', { targets: ['HKL', 'NZE/PAW'], doneTargets: ['HKL'], asksBack: true })])) as unknown
    const [back] = reviveSteps(saved)
    expect([back?.targets, back?.doneTargets, back?.asksBack]).toEqual([['HKL', 'NZE/PAW'], ['HKL'], true])
  })
})

describe('in the panel and on the bar', () => {
  test('a migration for two databases: tick each in the panel or from the bar; the last tick closes it', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading(STEPS))] })
    await finishTurn($, world, REPLY)
    const ui = await $.ui.mount(pane('desktop', { bodyColumns: 90 }))
    const bar = await $.ui.mount(band('desktop', { bodyColumns: 120 }))

    expect(await ui.find({ type: 'Button', key: 'target-1700000000000-0-0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^0\/2$/ })).toBeDefined()
    expect((await bar.find({ type: 'Button', key: 'done' }))?.text).toBe('✓ HKL') // the bar ticks the next place, not the step

    await ui.press({ key: 'target-1700000000000-0-0' })
    expect(await ui.find({ type: 'Text', text: /^1\/2$/ })).toBeDefined()
    expect((await bar.find({ type: 'Button', key: 'done' }))?.text).toBe('✓ NZE/PAW')

    await bar.press({ key: 'done' })
    expect(await ui.find({ type: 'Text', text: /✓ Done · Run the read-only preflight/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Now · step 2 of 3$/ })).toBeDefined()
    await ui.unmount()
    await bar.unmount()
  })

  test('a step that wants its result back starts that reply in the prompt, for the reader to paste into', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading(STEPS))] })
    await finishTurn($, world, REPLY)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'result' })
    expect(world.calls.fills).toEqual(['Result of "Run the read-only preflight": '])
    expect(world.calls.toast.at(-1)).toContain('Paste the result')
    await ui.unmount()
  })

  test('a decision offers its own answers, each filling the prompt and sending nothing', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading(STEPS))] })
    await finishTurn($, world, REPLY)
    const ui = await $.ui.mount(pane('desktop'))
    await ui.press({ key: (await stepButton(ui, /^Choose whether rates may be backdated$/))?.key ?? '' })
    expect(await ui.find({ type: 'Button', key: 'approve' })).toBeUndefined()
    await ui.press({ key: 'option-1' })
    expect(world.calls.fills).toEqual(['Decision on "Choose whether rates may be backdated": Future-dated only.'])
    await ui.unmount()
  })
})