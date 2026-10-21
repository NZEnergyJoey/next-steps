import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Step } from '../types'
import { FLASH_MS, DONE_WINDOW_MS, kindLabel, liveFlash, newSince, progressOf, railText } from '../hooks/lib/progress'
import { summarise } from '../hooks/lib/select'
import { pulseSvg, railSvg, ringSvg } from '../hooks/ui/svg'
import { ringGlyph } from '../hooks/ui/taskbar'
import { SQL, answered, band, boot, finishTurn, pane, reading, reply, stepButton } from './support'

/** The redesign: one step in the spotlight, a rail that fills, a moment for each finished step, no pop-ups. */

const T0 = 1_700_000_000_000
const step = (id: string, over: Partial<Step> = {}): Step => ({
  id,
  kind: 'action',
  group: 'you',
  status: 'open',
  title: `Step ${id}`,
  key: id,
  firstSeen: T0,
  lastSeen: T0,
  missed: 0,
  ...over,
})

describe('progress through the round', () => {
  test('counts what was finished since the oldest open step appeared, and which one is current', () => {
    const steps = [
      step('a', { status: 'done', closedAt: T0 + 10, firstSeen: T0 - 5 }),
      step('old', { status: 'done', closedAt: T0 - 999, firstSeen: T0 - 2000 }), // finished before this round began
      step('b', { firstSeen: T0 }),
      step('c', { firstSeen: T0 + 1 }),
      step('claude', { group: 'claude' }), // Claude's steps are not the reader's round
    ]
    const p = progressOf(steps, summarise(steps), T0 + 20)
    expect(p.segments.map(s => `${s.id}:${s.state}`)).toEqual(['a:done', 'b:current', 'c:todo'])
    expect([p.done, p.total, p.position]).toEqual([1, 3, 2])
    expect(railText(p)).toBe('▰▣▱')
  })

  test('with nothing left open, the round just finished still shows as all done, then lets go', () => {
    const steps = [step('a', { status: 'done', closedAt: T0 }), step('b', { status: 'skipped', closedAt: T0 + 1 })]
    const p = progressOf(steps, summarise(steps), T0 + 60_000)
    expect([p.done, p.total, p.position]).toEqual([2, 2, 0])
    expect(p.segments.map(s => s.state)).toEqual(['done', 'skipped'])
    expect(progressOf(steps, summarise(steps), T0 + DONE_WINDOW_MS + 10).total).toBe(0)
  })

  test('"new" means arrived since the panel was last open; a flash lasts its moment', () => {
    const steps = [step('a', { firstSeen: T0 + 5 }), step('b', { firstSeen: T0 - 5 })]
    expect(newSince(summarise(steps), T0)).toBe(1)
    const f = { id: 'a', title: 'A', at: T0, by: 'you' as const }
    expect(liveFlash(f, T0 + FLASH_MS - 1)).toBe(f)
    expect(liveFlash(f, T0 + FLASH_MS)).toBeNull()
    expect(liveFlash(null, T0)).toBeNull()
  })

  test('chips name the kind of step; a decision is a decision whatever its kind', () => {
    expect(kindLabel({ kind: 'sql', group: 'you' })).toBe('SQL')
    expect(kindLabel({ kind: 'command', group: 'you' })).toBe('Run')
    expect(kindLabel({ kind: 'sql', group: 'decision' })).toBe('Decision')
  })
})

describe('the drawn accents', () => {
  test('the rail has a segment per step, and only the current one shimmers', () => {
    const svg = railSvg({ segments: [{ id: 'a', state: 'done' }, { id: 'b', state: 'current' }, { id: 'c', state: 'todo' }] })
    expect((svg.match(/<rect /g) ?? []).length).toBe(3)
    expect((svg.match(/<animate /g) ?? []).length).toBe(1)
    expect(svg).toContain('preserveAspectRatio="none"')
    expect(svg).not.toMatch(/<script|on[a-z]+=/i)
  })

  test('the ring fills, circles while syncing, and closes green with a check when all is done', () => {
    expect(ringSvg({ ratio: 0.5, total: 4, position: 3 }, false)).toContain('stroke-dashoffset')
    expect(ringSvg({ ratio: 0.5, total: 4, position: 3 }, true)).toContain('animateTransform')
    const done = ringSvg({ ratio: 1, total: 2, position: 0 }, false)
    expect(done).toContain('<path')
    expect(done).toContain('#22C55E')
    expect(pulseSvg()).toContain('<animate')
    expect([ringGlyph({ ratio: 0, total: 3, position: 1 }), ringGlyph({ ratio: 0.5, total: 4, position: 3 }), ringGlyph({ ratio: 1, total: 2, position: 0 })]).toEqual(['○', '◑', '✓'])
  })
})

const STEPS = [
  { group: 'you', kind: 'sql', title: 'Run the invoices migration', why: 'Adds the table the new page reads from.', copy: SQL, language: 'sql' },
  { group: 'you', kind: 'pr', title: 'Open a PR for feat/invoices' },
  { group: 'decision', kind: 'action', title: 'Approve dropping the legacy invoices table' },
]
const REPLY = reply('Run this in the SQL editor:', '```sql', SQL, '```', 'Then open a PR for feat/invoices, and tell me whether to drop the legacy table.')

async function ready($: Engine, on: On) {
  const world = await boot($, on, { model: [answered(reading(STEPS))] })
  await world.clock.advance(1)
  await finishTurn($, world, REPLY)

  return world
}

describe('the highlight follows the work', () => {
  test('the desktop draws the accents; the terminal draws the same in text', async ($, on) => {
    await ready($, on)
    const desk = await $.ui.mount(pane('desktop'))
    const drawn = await desk.findAll({ type: 'Svg' })
    expect(drawn.length).toBeGreaterThanOrEqual(2) // the live beacon and the rail (and the spotlight's beacon)
    expect(await desk.find({ type: 'Text', text: /^Now · step 1 of 3$/ })).toBeDefined()
    await desk.unmount()

    const term = await $.ui.mount(pane('terminal'))
    expect(await term.findAll({ type: 'Svg' })).toEqual([])
    expect(await term.find({ type: 'Text', text: /^▣▱▱$/ })).toBeDefined()
    expect(await term.find({ type: 'Text', text: /Step 1 of 3 · 0 done/ })).toBeDefined()
    await term.unmount()
  })

  test('marking the spotlight done: it lingers a moment, the rail fills, the next step takes the spotlight', async ($, on) => {
    const world = await ready($, on)
    const ui = await $.ui.mount(pane('desktop'))
    await ui.press({ key: 'done' })

    expect(await ui.find({ type: 'Text', text: /✓ Done · Run the invoices migration/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Now · step 2 of 3$/ })).toBeDefined()
    expect(await stepButton(ui, /^Open a PR for feat\/invoices$/)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Step 2 of 3 · 1 done/ })).toBeDefined()

    await world.clock.advance(FLASH_MS)
    expect(await ui.find({ type: 'Text', text: /✓ Done · / })).toBeUndefined()
    expect(world.calls.toast).toEqual([])
    await ui.unmount()
  })

  test('a step Claude says it finished moves the highlight the same way, saying who finished it', async ($, on) => {
    const world = await boot($, on, {
      model: (call, prompt) => {
        if (call === 1) return answered(reading(STEPS))
        const id = /(\S+) \| you \| Run the invoices migration/.exec(prompt)?.[1] ?? ''

        return answered(reading([], [id]))
      },
    })
    await world.clock.advance(1)
    await finishTurn($, world, REPLY)
    await finishTurn($, world, reply('I ran the invoices migration for you; it is applied. Nothing else changed in the database.'))

    const ui = await $.ui.mount(band('desktop', { bodyColumns: 120 }))
    expect(await ui.find({ type: 'Text', text: /✓ Claude finished · Run the invoices migration/ })).toBeDefined()
    await world.clock.advance(FLASH_MS)
    expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain('Open a PR for feat/invoices')
    await ui.unmount()
  })

  test('a reopened step stops its moment at once', async ($, on) => {
    const world = await ready($, on)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'done' })
    expect(await ui.find({ type: 'Text', text: /✓ Done · / })).toBeDefined()
    await ui.press({ key: 'tab-done' })
    const tick = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('tick-') && b.text === '✓')
    expect(tick).toBeDefined()
    await ui.press({ key: tick?.key ?? '' })
    expect(await ui.find({ type: 'Text', text: /✓ Done · / })).toBeUndefined()
    expect(world.calls.toast).toEqual([])
    await ui.unmount()
  })

  test('new steps wait as "+n new" on the bar, which clears once the panel has been opened', async ($, on) => {
    const world = await ready($, on)
    const bar = await $.ui.mount(band('terminal', { bodyColumns: 120 }))
    expect(await bar.find({ type: 'Text', text: /\+3 new/ })).toBeDefined()
    await bar.press({ key: 'open' })
    await bar.unmount()
    expect(world.calls.opens).toBe(1)
  })
})
