import { describe, expect, test } from 'claude-code/testing'
import type { CommandRunInput } from 'claude-code'

import type { Step } from '../types'
import { parseExtraction, reviveSteps } from '../hooks/lib/extract'
import { reconcile, setStatus, setTarget, targetsLeft } from '../hooks/lib/merge'
import { buildPrompt } from '../hooks/lib/model'
import { contains } from '../hooks/lib/text'
import { prHref } from '../hooks/lib/git'
import { progressOf } from '../hooks/lib/progress'
import { railSvg } from '../hooks/ui/svg'
import { statusText, summarise, waitingOn } from '../hooks/lib/select'
import { scopeKey } from '../hooks/lib/store'
import { everywhere } from '../hooks/register'
import { answered, band, boot, finishTurn, pane, reading, reply, stepButton } from './support'

/**
 * The workflows this mod is used for most: one migration run on several databases in turn (HKL, then NZE/PAW),
 * results pasted back to Claude, decisions that offer their own answers, and steps that must wait for another.
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

  test('a step that only copies text hands it to the step that uses it', () => {
    const sql = 'select 1;'
    const out = parseExtraction(
      JSON.stringify({
        steps: [
          { title: 'Copy the preflight script to the clipboard', kind: 'command', copy: sql },
          { title: 'Run the preflight on HKL and NZE/PAW', kind: 'sql', targets: ['HKL', 'NZE/PAW'], asksBack: true },
          { title: 'Apply migration 97', kind: 'sql', after: 2 },
        ],
      }),
      `Run this on HKL, then NZE/PAW: ${sql}`,
    )
    expect(out?.steps.map(s => [s.title, s.copy, s.after])).toEqual([
      ['Run the preflight on HKL and NZE/PAW', sql, undefined],
      ['Apply migration 97', undefined, 0],
    ])
  })

  test('a project id in brackets is not part of the name of a place', () => {
    const out = parseExtraction(
      JSON.stringify({ steps: [{ title: 'Run the preflight', kind: 'sql', targets: ['HKL (toxsylietzenosymsipx)', 'NZE/PAW (imleiihuudgxldnewbfy)'] }] }),
      'Run it on HKL (toxsylietzenosymsipx), then NZE/PAW (imleiihuudgxldnewbfy).',
    )
    expect(out?.steps[0]?.targets).toEqual(['HKL', 'NZE/PAW'])
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

    expect((await ui.find({ type: 'Button', key: 'done' }))?.text).toBe('✓ NZE/PAW') // the panel's d ticks the next place too, as the bar's does
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
describe('steps that wait for another', () => {
  test('a step may wait only for an earlier step of the same reply', () => {
    const out = parseExtraction(JSON.stringify({ steps: [{ title: 'Apply 97' }, { title: 'Merge', after: 1 }, { title: 'Odd', after: 3 }, { title: 'Self', after: 0 }] }))
    expect(out?.steps.map(s => s.after)).toEqual([undefined, 0, undefined, undefined])
  })

  test('it never leads while what it waits for is open, and takes its place once that is done', () => {
    const incoming = [
      { kind: 'pr' as const, group: 'you' as const, title: 'Merge PR 76', key: 't:76 merge pr', after: 1 },
      { kind: 'sql' as const, group: 'you' as const, title: 'Apply migration 97', key: 't:97 apply migration' },
    ]
    const { steps } = reconcile([], incoming, [], T0)
    const merge = steps.find(s => s.title === 'Merge PR 76')
    const apply = steps.find(s => s.title === 'Apply migration 97')
    expect(merge?.after).toBe(apply?.id)
    expect(summarise(steps).next?.title).toBe('Apply migration 97') // listed second, but the merge waits for it
    expect(waitingOn(merge!, steps)?.id).toBe(apply?.id)
    const after = setStatus(steps, apply?.id ?? '', 'done', T0 + 1)
    expect(summarise(after).next?.title).toBe('Merge PR 76')
    expect(waitingOn(after.find(s => s.title === 'Merge PR 76')!, after)).toBeUndefined()
  })

  test('the panel greys a waiting step and says what it waits for', async ($, on) => {
    const world = await boot($, on, {
      model: [answered(reading([{ group: 'you', kind: 'sql', title: 'Apply migration 97' }, { group: 'you', kind: 'pr', title: 'Merge PR 76', after: 1 }]))],
    })
    await finishTurn($, world, reply('Apply migration 97, and only after it is verified, merge PR 76.'))
    const ui = await $.ui.mount(pane('desktop'))
    expect(await ui.find({ type: 'Text', text: /^after 1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ Waiting $/ })).toBeDefined()
    await ui.press({ key: (await stepButton(ui, /^Merge PR 76$/))?.key ?? '' })
    expect(await ui.find({ type: 'Text', text: /^Waits for: Apply migration 97$/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('every worktree at once', () => {
  test('lists each worktree with something open, newest first, with what waits on the reader', () => {
    const text = everywhere(
      [
        { root: 'C:/Code/NZE-Worktrees/po-numbering', updatedAt: T0, steps: [step('a', { title: 'Apply migration 133', targets: ['HKL', 'NZE/PAW'], doneTargets: ['HKL'] }), step('b', { group: 'claude', title: 'Run the tests' })] },
        { root: 'C:/Code/NZE-Worktrees/invoice-notes', updatedAt: T0 - 3 * 3600_000, steps: [step('c', { group: 'decision', title: 'Approve merging PR 154' })] },
        { root: 'C:/Code/NZE-Worktrees/done-already', updatedAt: T0, steps: [step('d', { status: 'done', closedAt: T0 })] },
      ],
      'C:/Code/NZE-Worktrees/po-numbering',
      T0 + 60_000,
    )
    expect(text.split('\n')).toEqual([
      'Next steps in 2 worktrees: 2 waiting on you.',
      '',
      'po-numbering (this one) · 1 for you, 1 for Claude · updated 1m ago',
      '  ○ Apply migration 133 (NZE/PAW to go)',
      '',
      'invoice-notes · 1 for you · updated 3h ago',
      '  ◇ Approve merging PR 154',
    ])
    expect(everywhere([], 'x', T0)).toBe('Nothing is open in any worktree.')
  })

  test('/next-steps all reads this worktree live and the others from the store', async ($, on) => {
    const other = 'C:/Code/NZE-Worktrees/invoice-notes'
    const world = await boot($, on, {
      model: [answered(reading(STEPS))],
      store: { [scopeKey(other)]: { v: 1, root: other, updatedAt: T0, touched: T0, steps: [step('c', { group: 'decision', title: 'Approve merging PR 154' })] } },
    })
    await finishTurn($, world, REPLY)
    const out = (await $.command.run({ command: 'next-steps', args: 'all', presentation: { isFullscreen: false, columns: 100 } } as unknown as CommandRunInput)) as { text?: string }
    expect(out.text).toContain('Next steps in 2 worktrees: 4 waiting on you.')
    expect(out.text).toContain('app (this one) · 3 for you')
    expect(out.text).toContain('  ○ Run the read-only preflight (HKL, NZE/PAW to go)')
    expect(out.text).toContain('invoice-notes · 1 for you')
  })
})

describe('a reply that finishes one place', () => {
  test('"id@place" ticks that place; the last place closes the step as Claude finishing it', () => {
    const list = [step('a', { targets: ['HKL', 'NZE/PAW'] })]
    const once = reconcile(list, [], ['a@hkl', 'a@Mars', 'nope@HKL'], T0 + 1)
    expect([once.steps[0]?.status, once.steps[0]?.doneTargets, once.resolved]).toEqual(['open', ['HKL'], []])
    const twice = reconcile(once.steps, [], ['a@NZE/PAW'], T0 + 2)
    expect([twice.steps[0]?.status, twice.steps[0]?.closedBy, twice.resolved.map(s => s.id)]).toEqual(['done', 'reply', ['a']])
  })

  test('the model is told which places each open step still has to go', () => {
    const prompt = buildPrompt('reply', [step('a', { title: 'Apply 97', targets: ['HKL', 'NZE/PAW'], doneTargets: ['HKL'] })])
    expect(prompt).toContain('a | you | Apply 97 | places to go: NZE/PAW')
  })

  test('pasting the HKL results and hearing it is clean ticks HKL in the panel', async ($, on) => {
    const world = await boot($, on, {
      model: (call, prompt) => {
        if (call === 1) return answered(reading(STEPS))
        const id = /(\S+) \| you \| Run the read-only preflight/.exec(prompt)?.[1] ?? ''

        return answered(reading([], [`${id}@HKL`]))
      },
    })
    await finishTurn($, world, REPLY)
    await finishTurn($, world, reply('Thanks, the HKL preflight is clean: every row says PASS. Now run the same query on NZE/PAW and paste that too.'))
    const ui = await $.ui.mount(pane('desktop'))
    expect(await ui.find({ type: 'Text', text: /^1\/2$/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'done' }))?.text).toBe('✓ NZE/PAW')
    await ui.unmount()
  })
})

describe('the real loop, as the model answered it', () => {
  test('HKL confirmed and the preflight relisted for NZE/PAW: one step, HKL still ticked, nothing duplicated', () => {
    // The model's own answer to "the HKL preflight is clean, now run it on NZE/PAW" (a real run, kinds and all).
    const before = [
      step('pre', { kind: 'sql', title: 'Run the read-only preflight', key: 't:only preflight read run', targets: ['HKL', 'NZE/PAW'] }),
      step('app', { kind: 'sql', title: 'Apply migration 97', key: 'p:sql:supabase/97_hs_submission_amendments.sql', path: 'supabase/97_hs_submission_amendments.sql', targets: ['HKL', 'NZE/PAW'] }),
      step('pr', { kind: 'pr', title: 'Merge PR #76', key: 't:76 merge pr' }),
    ]
    const answer = JSON.stringify({
      steps: [
        { group: 'you', kind: 'check', title: 'Run the read-only preflight on NZE/PAW and paste the output', asksBack: true },
        { group: 'you', kind: 'sql', title: 'Apply migration 97 on HKL, then NZE/PAW, and run the verifier on each', path: 'supabase/97_hs_submission_amendments.sql', targets: ['HKL', 'NZE/PAW'], after: 1 },
        { group: 'you', kind: 'pr', title: 'Merge PR #76 once both verifiers pass', after: 2 },
      ],
      resolved: ['pre@HKL'],
    })
    const said = 'HKL is clear. Run the same preflight on NZE/PAW and paste it. Then apply supabase/97_hs_submission_amendments.sql on HKL first, then NZE/PAW. Merge PR #76 once both verifiers pass.'
    const out = parseExtraction(answer, said)
    const { steps } = reconcile(before, out?.steps ?? [], out?.resolved ?? [], T0 + 5)
    expect(steps.map(s => s.id)).toEqual(['pre', 'app', 'pr'])
    const pre = steps[0]!
    expect([pre.status, pre.targets, pre.doneTargets, pre.asksBack, pre.missed]).toEqual(['open', ['HKL', 'NZE/PAW'], ['HKL'], true, 0])
    expect(steps.find(s => s.id === 'app')?.after).toBe('pre')
    expect(summarise(steps).next?.id).toBe('pre')
  })
})

describe('the same step, said with more words', () => {
  test('a title that says all of another, with more, is the same step; short titles are never swallowed', () => {
    expect(contains('Merge PR #76', 'Merge PR #76 once both verifiers pass')).toBe(true)
    expect(contains('Merge PR #76', 'Merge PR #77 once CI is green')).toBe(false)
    expect(contains('Run the tests', 'Run the tests on staging and production')).toBe(false) // two words of meaning
    expect(contains('Unrelated chore number 1', 'Unrelated chore number 2')).toBe(false)
  })
})

describe('pull requests', () => {
  test('a step that names a PR by number links to it; one that opens a PR links to the compare page', () => {
    const repo = { owner: 'NZEnergyJoey', name: 'nzenergy-portal', branch: 'feat/po-numbering' }
    expect(prHref(repo, { kind: 'pr', title: 'Merge PR #76 once both verifiers pass' })).toBe('https://github.com/NZEnergyJoey/nzenergy-portal/pull/76')
    expect(prHref(repo, { kind: 'review', title: 'Review pull request #165' })).toBe('https://github.com/NZEnergyJoey/nzenergy-portal/pull/165')
    expect(prHref(repo, { kind: 'pr', title: 'Open a PR for feat/po-numbering' })).toBe('https://github.com/NZEnergyJoey/nzenergy-portal/compare/feat/po-numbering?expand=1')
    expect(prHref(repo, { kind: 'sql', title: 'Run migration 134 for issue #155' })).toBeUndefined()
    expect(prHref(null, { kind: 'pr', title: 'Merge PR #76' })).toBeUndefined()
  })
})
describe('the bar links the pull request in front', () => {
  test('a step that names a PR shows "#76 ↗" on the bar, linked to it', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading([{ group: 'you', kind: 'pr', title: 'Merge PR #76 once both verifiers pass' }]))] })
    await finishTurn($, world, reply('Both verifiers pass, so merge PR #76 whenever you are ready.'))
    for (const surface of ['terminal', 'desktop'] as const) {
      const bar = await $.ui.mount(band(surface, { bodyColumns: 120 }))
      const link = await bar.find({ type: 'Link' })
      expect([link?.props.href, link?.props.label]).toEqual(['https://github.com/acme/app/pull/76', '#76 ↗'])
      await bar.unmount()
    }
  })
})

describe('waiting ends when the conversation moves on', () => {
  test('a step waiting on one the replies stopped mentioning no longer waits', () => {
    const steps = [step('pre', { missed: 9 }), step('merge', { kind: 'pr', after: 'pre' })]
    expect(waitingOn(steps[1]!, steps)).toBeUndefined()
    expect(summarise(steps).next?.id).toBe('merge')
  })
})

describe('progress counts places', () => {
  test('one of two databases ticked fills half the current segment, and half a step of the ring', () => {
    const steps = [step('a', { targets: ['HKL', 'NZE/PAW'], doneTargets: ['HKL'] }), step('b')]
    const p = progressOf(steps, summarise(steps), T0)
    expect(p.segments).toEqual([{ id: 'a', state: 'current', part: 0.5 }, { id: 'b', state: 'todo' }])
    expect(p.ratio).toBe(0.25)
    const svg = railSvg(p)
    expect((svg.match(/<rect /g) ?? []).length).toBe(4) // track, shimmer and solid for the current step; one for the next
    expect((svg.match(/<animate /g) ?? []).length).toBe(1)
  })
})

describe('the status line', () => {
  test('names the next place where there is no bar to show it', () => {
    const steps = [step('a', { title: 'Apply migration 105', targets: ['HKL', 'NZE/PAW'], doneTargets: ['HKL'] })]
    expect(statusText(summarise(steps))).toBe('Next steps · 1 pending · Apply migration 105 (NZE/PAW next)')
  })
})

describe('a decision on the bar', () => {
  test('is answered, not ticked: the bar offers Answer, which opens the panel', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading([STEPS[2]!]))] })
    await finishTurn($, world, REPLY)
    const bar = await $.ui.mount(band('desktop', { bodyColumns: 120 }))
    expect(await bar.find({ type: 'Button', key: 'done' })).toBeUndefined()
    await bar.press({ key: 'answer' })
    expect(world.calls.opens).toBe(1)
    await bar.unmount()
  })
})

describe('handing several steps back at once', () => {
  test('"Ask for all" puts every step Claude offered in one prompt, sending nothing', async ($, on) => {
    const world = await boot($, on, {
      model: [answered(reading([{ group: 'you', kind: 'pr', title: 'Merge PR #76' }, { group: 'claude', kind: 'check', title: 'Run the tests' }, { group: 'claude', kind: 'action', title: 'Update the vault notes' }]))],
    })
    await finishTurn($, world, reply('Merge PR #76. I can run the tests and update the vault notes if you like.'))
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'ask-all' })
    expect(world.calls.fills).toEqual(['Please go ahead with these next steps:\n- Run the tests\n- Update the vault notes'])
    await ui.unmount()
  })
})
