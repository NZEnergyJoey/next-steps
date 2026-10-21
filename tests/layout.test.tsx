import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import type { Step } from '../types'
import { summarise } from '../hooks/lib/select'
import { breakable } from '../hooks/lib/text'
import { tabCounts, viewOf } from '../hooks/ui/panel'
import { TABS, TONES, toneOf, type Tone } from '../hooks/ui/tone'
import { ALL_SURFACES, answered, band, boot, finishTurn, pane, reading, reply, stepButton } from './support'

/** The coloured states and tabs, and the layout rules that keep every word inside its box at any width. */

const BREAK = String.fromCharCode(0x200b)
/** Spaces, and the zero-width ones breakable() adds: where a line may break. */
const SPACES = new RegExp(`[\\s${BREAK}]+`)
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

describe('states and tabs', () => {
  test('every state has its own colour, glyph and word, so none rests on colour alone', () => {
    const tones = Object.keys(TONES) as Tone[]
    expect(new Set(tones.map(t => TONES[t].label)).size).toBe(tones.length)
    // Optional and Earlier share a glyph but not a colour; Earlier and Skipped share a colour but not a glyph.
    expect(new Set(tones.map(t => `${TONES[t].glyph}|${TONES[t].color}`)).size).toBe(tones.length)
    expect(TONES.now.color).toBe('suggestion')
    expect(TONES.done.color).toBe('success')
  })

  test('a step is in exactly one state', () => {
    expect(toneOf(step('a'), true)).toBe('now')
    expect(toneOf(step('a'))).toBe('next')
    expect(toneOf(step('a', { group: 'decision' }))).toBe('decide')
    expect(toneOf(step('a', { group: 'claude' }), true)).toBe('claude')
    expect(toneOf(step('a', { group: 'optional' }))).toBe('optional')
    expect(toneOf(step('a', { missed: 9 }))).toBe('earlier')
    expect(toneOf(step('a', { status: 'done' }), true)).toBe('done')
    expect(toneOf(step('a', { status: 'skipped', missed: 9 }))).toBe('skipped')
  })

  test('the tabs count their steps, and an empty tab falls back to To do', () => {
    const s = summarise([step('a'), step('b', { group: 'claude' }), step('c', { group: 'optional' }), step('d', { status: 'done', closedAt: T0 })])
    expect(tabCounts(s)).toEqual({ todo: 2, optional: 1, earlier: 0, done: 1 })
    expect(viewOf('done', s)).toBe('done')
    expect(viewOf('earlier', s)).toBe('todo')
    expect(TABS.map(t => t.hotkey)).toEqual(['t', 'o', 'e', 'h'])
  })
})

describe('long words get places to break', () => {
  test('paths, identifiers and hashes break; ordinary words and short tokens are left alone', () => {
    const path = 'supabase/migrations/134_purchasing_notes_both_invoice_and_po.sql'
    const out = breakable(`Run ${path} now`)
    expect(out.split(BREAK).join('')).toBe(`Run ${path} now`)
    for (const word of out.split(SPACES)) expect(word.length).toBeLessThanOrEqual(24)
    expect(breakable('Open a PR for feat/invoices')).toBe('Open a PR for feat/invoices')
    const hash = 'a'.repeat(60)
    expect(breakable(hash).split(BREAK).every(part => part.length <= 24)).toBe(true)
  })
})

// ── Layout: nothing may run past the edge of its box ─────────────────────────────────────────────

const PATH = 'supabase/migrations/134_purchasing_notes_both_invoice_and_po.sql'
const SQL = 'alter table purchasing_notes add column purchase_order_id uuid references purchase_orders(id) on delete cascade;'
const LONG = [
  { group: 'you', kind: 'sql', title: 'Run migration 134_purchasing_notes_both_invoice_and_po.sql on the NZE and PAW Supabase projects before the release', why: 'Lets a purchasing note sit on both an invoice and its purchase order.', copy: SQL, language: 'sql', path: PATH, targets: ['HKL', 'NZE/PAW'], asksBack: true },
  {
    group: 'decision',
    kind: 'action',
    title: 'Approve merging feat/purchasing-notes-on-invoices-and-purchase-orders into main once CI is green',
    options: ['Merge now and watch the three production deploys', 'Wait until the migration verifier has passed on every database'],
  },
  { group: 'you', kind: 'pr', title: 'Open a PR for feat/next-steps-redesign-with-coloured-status-tabs' },
  { group: 'you', kind: 'deploy', title: 'Deploy the purchasing-notes edge function once the PR is merged', after: 3 },
  { group: 'claude', kind: 'check', title: 'Run the full test suite and the type-check across hooks, tests and types' },
  { group: 'optional', kind: 'action', title: 'Rename purchasingNotesBothInvoiceAndPurchaseOrderHelper to match the new table name' },
]
const LONG_REPLY = reply(`Run ${PATH} in the SQL editor on HKL, then NZE/PAW:`, '```sql', SQL, '```', 'Then open the PR and approve the merge; I can run the tests.')

type Node = RenderElement & { type: string; props?: Record<string, unknown>; children?: Array<Node | string> }

const propsOf = (n: Node): Record<string, unknown> => n.props ?? {}

/** The text a node shows, its labels included where a Button has no children. */
function shownText(n: Node | string): string {
  if (typeof n === 'string') return n
  const kids = (n.children ?? []).map(shownText).join('')
  if (n.type === 'Link') return String(propsOf(n).label ?? propsOf(n).href ?? '')
  if (n.type === 'Button' && kids === '') return String(propsOf(n).label ?? '')
  return kids
}

/** Every rule a drawn tree breaks, by path; empty when it keeps every word inside its box. */
function overflows(root: Node, rich: boolean): string[] {
  const out: string[] = []
  const walk = (n: Node | string, path: string, wrap: string) => {
    if (typeof n === 'string') {
      // A long unbroken word cannot wrap where a surface breaks at spaces: on those it must have been given breaks.
      const longest = Math.max(0, ...n.split(SPACES).map(w => w.length))
      if (rich && wrap === 'wrap' && longest > 24) out.push(`${path}: unbreakable word of ${longest} characters`)
      return
    }
    const here = `${path}/${n.type}${propsOf(n).key ? `[${String(propsOf(n).key)}]` : ''}`
    // A desktop draws a Button's label in place of its children, so a Button never names itself apart from them.
    const kids = (n.children ?? []).map(shownText).join('')
    if (n.type === 'Button' && kids !== '' && propsOf(n).label !== undefined && propsOf(n).label !== kids) out.push(`${here}: a Button's label differs from what it shows; a desktop would draw the label`)
    if (n.type === 'Button' && shownText(n).length > 24) out.push(`${here}: a Button holds ${shownText(n).length} characters, and buttons do not wrap`)
    if (n.type === 'Box' && propsOf(n).flexDirection === 'row' && propsOf(n).flexWrap !== 'wrap') {
      for (const child of n.children ?? []) {
        if (typeof child === 'string') continue
        const long = shownText(child).length > 40
        if (long && child.type === 'Box' && propsOf(child).minWidth !== 0) out.push(`${here}: a row's child Box with long text cannot shrink (no minWidth 0)`)
        // A Text that cuts itself short with an ellipsis is the one long thing a row may hold directly.
        const isCut = child.type === 'Text' && String(propsOf(child).wrap ?? '').startsWith('truncate')
        if (long && child.type !== 'Box' && !isCut) out.push(`${here}: a row holds ${child.type} with long text directly`)
      }
    }
    if (n.type === 'Link' && rich) walk(String(propsOf(n).label ?? ''), here, wrap)
    const next = n.type === 'Text' ? String(propsOf(n).wrap ?? (wrap === '' ? 'wrap' : wrap)) : wrap
    if (n.type !== 'Code') for (const c of n.children ?? []) walk(c, here, next)
  }
  walk(root, '', '')
  return out
}

async function longList($: Engine, on: On) {
  const world = await boot($, on, { model: [answered(reading(LONG))] })
  await finishTurn($, world, LONG_REPLY)
  return world
}

describe('layout at any width', () => {
  test('the panel keeps every title, path and label inside its box, on every surface and width', async ($, on) => {
    await longList($, on)
    for (const surface of ALL_SURFACES) {
      for (const bodyColumns of [120, 60, 36, 24]) {
        const ui = await $.ui.mount(pane(surface, { bodyColumns }))
        const rich = surface !== 'terminal'
        expect({ surface, bodyColumns, problems: overflows((await ui.drawn()) as Node, rich) }).toEqual({ surface, bodyColumns, problems: [] })
        // Open a long row too: its story must fit as well.
        const decision = await stepButton(ui, /^Approve merging/)
        await ui.press({ key: decision?.key ?? '' })
        expect({ surface, bodyColumns, problems: overflows((await ui.drawn()) as Node, rich) }).toEqual({ surface, bodyColumns, problems: [] })
        await ui.press({ key: 'tab-optional' })
        expect({ surface, bodyColumns, problems: overflows((await ui.drawn()) as Node, rich) }).toEqual({ surface, bodyColumns, problems: [] })
        await ui.press({ key: 'tab-todo' })
        await ui.unmount()
      }
    }
  })

  test('the panel fills the width the desktop gives it, rather than a count of cells that may be stale', async ($, on) => {
    await longList($, on)
    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount(pane(surface, { bodyColumns: 50 }))
      expect(propsOf((await ui.drawn()) as Node).width).toBe(surface === 'terminal' ? 48 : '100%')
      await ui.unmount()
    }
  })

  test('the taskbar never wraps: it shortens the title and keeps its buttons whole', async ($, on) => {
    await longList($, on)
    for (const surface of ['terminal', 'desktop'] as const) {
      for (const bodyColumns of [140, 64, 30]) {
        const ui = await $.ui.mount(band(surface, { bodyColumns }))
        const tree = (await ui.drawn()) as Node
        expect(overflows(tree, surface !== 'terminal')).toEqual([])
        expect(propsOf(tree).width).toBe(surface === 'terminal' ? bodyColumns : '100%')
        expect((await ui.find({ type: 'Text', text: /Run migration 134/ }))?.props.wrap).toBe('truncate-end')
        await ui.unmount()
      }
    }
  })

  test('every step wears its state: Now in the card, then Next, Decide, Claude and Waiting in colour', async ($, on) => {
    await longList($, on)
    const ui = await $.ui.mount(pane('desktop', { bodyColumns: 100 }))
    for (const tone of ['next', 'decide', 'claude', 'waiting'] as const) {
      const pill = await ui.find({ type: 'Text', text: new RegExp(`^ ${TONES[tone].label} $`) })
      expect(pill?.props.color).toBe(TONES[tone].color)
      expect(pill?.props.backgroundColor).toBe(TONES[tone].tint)
    }
    expect(await ui.find({ type: 'Text', text: /^Now · step 1 of 4$/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'tab-todo' }))?.text).toContain('To do 5')
    expect((await ui.find({ type: 'Button', key: 'tab-optional' }))?.text).toContain('Optional 1')
    await ui.unmount()
  })
})