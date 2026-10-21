import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ALL_SURFACES, SQL, TERMINAL_AND_DESKTOP, answered, band, boot, buttonKeys, finishTurn, pane, reading, reply, rowKey, stepButton, type Setup } from './support'
import { FLASH_MS } from '../hooks/lib/progress'

const REPLY = reply(
  'Run supabase/migrations/0042_invoices.sql in the SQL editor:',
  '```sql',
  SQL,
  '```',
  'Then open a PR for feat/invoices, and tell me whether to drop the legacy table. I can run the tests when you say.',
)

const STEPS = [
  { group: 'you', kind: 'sql', title: 'Run the invoices migration', why: 'Adds the table the new page reads from.', copy: SQL, language: 'sql', path: 'supabase/migrations/0042_invoices.sql' },
  { group: 'decision', kind: 'action', title: 'Approve dropping the legacy invoices table' },
  { group: 'you', kind: 'pr', title: 'Open a PR for feat/invoices' },
  { group: 'claude', kind: 'check', title: 'Run the test suite' },
  { group: 'optional', kind: 'action', title: 'Rename the helper to match the new table' },
]

const GIT = {
  'worktree list --porcelain': 'worktree C:/Users/j/Code/app\nHEAD abc\nbranch refs/heads/feat/invoices\n',
  'cat-file -e HEAD:supabase/migrations/0042_invoices.sql': '',
  'cat-file -e refs/remotes/origin/feat/invoices:supabase/migrations/0042_invoices.sql': '',
}

async function ready($: Engine, on: On, over: Setup = {}) {
  const world = await boot($, on, { model: [answered(reading(STEPS))], git: GIT, ...over })
  await finishTurn($, world, REPLY)

  return world
}

describe('the taskbar', () => {
  test('says what is pending and what is next, in less room as the window narrows', async ($, on) => {
    await ready($, on)

    for (const surface of TERMINAL_AND_DESKTOP) {
      const wide = await $.ui.mount(band(surface, { bodyColumns: 120 }))
      const text = (await wide.find({ type: 'Text', text: /Next steps/ }))?.text ?? ''
      expect(text).toContain('Next steps · 3 pending')
      expect(text).toContain('Next steps · 3 pending · 1 for Claude · 1 optional')
      expect(text).toContain('Run the invoices migration')
      expect(await buttonKeys(wide)).toEqual(['done', 'open'])
      await wide.unmount()

      const mid = await $.ui.mount(band(surface, { bodyColumns: 70 }))
      const midText = (await mid.find({ type: 'Text', text: /Next steps/ }))?.text ?? ''
      expect(midText).toContain('Next steps · 3 pending')
      expect(midText).not.toContain('optional')
      expect(await buttonKeys(mid)).toEqual(['done', 'open'])
      await mid.unmount()

      const narrow = await $.ui.mount(band(surface, { bodyColumns: 45 }))
      const narrowText = (await narrow.find({ type: 'Text', text: /pending/ }))?.text ?? ''
      expect(narrowText).toContain('3 pending')
      expect(narrowText).not.toContain('Next steps')
      expect(await buttonKeys(narrow)).toEqual(['open'])
      await narrow.unmount()

      const tiny = await $.ui.mount(band(surface, { bodyColumns: 28 }))
      expect((await tiny.find({ type: 'Text', text: /Run the invoices/ }))?.text).toContain('3')
      expect(await buttonKeys(tiny)).toEqual(['open'])
      await tiny.unmount()
    }
  })

  test('steps aside for a survey, for the panel once it is open, and when nothing is waiting', async ($, on) => {
    await ready($, on)
    const survey = await $.ui.mount(band('terminal', { hasSurvey: true }))
    expect(await survey.find({ type: 'Text', text: /^engine$/ })).toBeDefined()
    await survey.unmount()

    const ui = await $.ui.mount(band('terminal'))
    await ui.press({ key: 'open' })
    expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeDefined() // the panel is open: the taskbar would only repeat it
    await ui.unmount()
  })

  test('says nothing at all when there is nothing for anyone to do', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading([{ group: 'optional', kind: 'action', title: 'Maybe rename a helper' }]))] })
    await finishTurn($, world, reply('Optionally, rename the helper.'))
    const ui = await $.ui.mount(band('desktop'))
    expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeDefined()
    await ui.unmount()
  })

  test('Done closes the step in front and the next one takes its place', async ($, on) => {
    const world = await ready($, on)
    for (const surface of TERMINAL_AND_DESKTOP) {
      const ui = await $.ui.mount(band(surface))
      const title = (await ui.find({ type: 'Text', text: /Next steps/ }))?.text ?? ''
      await ui.press({ key: 'done' })
      // The finished step lingers a moment on the bar, then the next one takes its place.
      const moment = (await ui.find({ type: 'Text', text: /✓ Done · / }))?.text ?? ''
      expect(title).toContain(moment.replace('✓ Done · ', ''))
      await world.clock.advance(FLASH_MS)
      expect(await ui.find({ type: 'Text', text: /✓ Done · / })).toBeUndefined()
      await ui.unmount()
    }
    // Two presses, two steps closed: the migration, then the approval. No toast for either: the bar says it.
    expect(world.calls.toast).toEqual([])
    const ui = await $.ui.mount(band('terminal'))
    const text = (await ui.find({ type: 'Text', text: /Next steps/ }))?.text ?? ''
    expect(text).toContain('1 pending')
    expect(text).toContain('Open a PR for feat/invoices')
    await ui.unmount()
  })

  test('when only Claude has something to do, the taskbar offers to hand it over', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading([{ group: 'claude', kind: 'check', title: 'Run the test suite' }]))] })
    await finishTurn($, world, reply('I can run the test suite whenever you like.'))
    const ui = await $.ui.mount(band('terminal'))
    expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain('1 for Claude')
    expect(await buttonKeys(ui)).toEqual(['ask', 'open'])
    await ui.press({ key: 'ask' })
    expect(world.calls.fills).toEqual(['Please go ahead with this next step: Run the test suite'])
    await ui.unmount()
  })

  test('a failed read is shown with a way to try again', async ($, on) => {
    const world = await boot($, on, { model: [answered('not json')] })
    await finishTurn($, world, reply('A long reply the model could not make sense of.'))
    await world.clock.advance(2000)
    const ui = await $.ui.mount(band('terminal'))
    expect(await buttonKeys(ui)).toEqual(['retry', 'open'])
    await ui.unmount()
  })
})

describe('the status line', () => {
  test('is used where there is no band, and only there', async ($, on) => {
    const editor = await ready($, on, { surfaces: ['vscode'] })
    expect(editor.calls.status.at(-1)).toBe('Next steps · 3 pending · Run the invoices migration')
  })

  test('is cleared where a terminal draws the band', async ($, on) => {
    const world = await ready($, on, { surfaces: ['terminal'] })
    expect(world.calls.status.at(-1)).toBeUndefined()
  })
})

describe('the panel', () => {
  test('opens the step in front, and keeps the rest to one line each', async ($, on) => {
    await ready($, on)
    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain('3 pending')
      // The step in front shows why, the file, the code and its actions; the others only their title.
      expect(await ui.find({ type: 'Text', text: /Adds the table the new page reads from/ })).toBeDefined()
      expect(await ui.find({ type: 'Code' })).toBeDefined()
      // The step in front sits in the spotlight card; the rest are listed under "Up next".
      expect(await ui.find({ type: 'Text', text: /^Now · step 1 of 3$/ })).toBeDefined()
      const heading = await ui.find({ type: 'Text', text: /^Up next$/ })
      expect(heading?.props.color).toBe('text')
      expect(heading?.props.weight).toBe('semibold')
      expect(await buttonKeys(ui)).toEqual(
        expect.arrayContaining(['tick-1700000000000-0', 'copy', 'path', 'done', 'skip', 'refresh', 'tab-optional']),
      )
      expect(await ui.find({ type: 'Text', text: /^Needs your decision/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /Rename the helper/ })).toBeUndefined() // optional: folded away
      await ui.unmount()
    }
  })

  test('links the file to the branch that has it, and a PR step to its compare page', async ($, on) => {
    await ready($, on)
    const ui = await $.ui.mount(pane('terminal'))
    const links = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
    expect(links).toContain('https://github.com/acme/app/blob/feat/invoices/supabase/migrations/0042_invoices.sql')
    await ui.press({ key: await rowKey(ui, 'Open a PR for feat/invoices') })
    const after = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
    expect(after).toContain('https://github.com/acme/app/compare/feat/invoices?expand=1')
    await ui.unmount()
  })

  test('pressing a step opens it and folds the one before; pressing it again folds it', async ($, on) => {
    await ready($, on)
    const ui = await $.ui.mount(pane('terminal'))
    const decision = await rowKey(ui, 'Approve dropping the legacy invoices table')
    await ui.press({ key: decision })
    expect(await ui.find({ type: 'Text', text: /Needs your decision · to do/ })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await buttonKeys(ui)).toEqual(expect.arrayContaining(['approve', 'decline']))

    await ui.press({ key: decision })
    expect(await ui.find({ type: 'Text', text: /Needs your decision · to do/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a decision is answered by filling the prompt, never by sending anything', async ($, on) => {
    const world = await ready($, on)
    const ui = await $.ui.mount(pane('desktop'))
    await ui.press({ key: await rowKey(ui, 'Approve dropping the legacy invoices table') })
    await ui.press({ key: 'approve' })
    await ui.press({ key: 'decline' })
    expect(world.calls.fills).toEqual([
      'Decision on "Approve dropping the legacy invoices table": approved.',
      'Decision on "Approve dropping the legacy invoices table": declined.',
    ])
    await ui.unmount()
  })

  test('Claude\'s steps are listed apart, with a way to hand them over', async ($, on) => {
    const world = await ready($, on)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Text', text: /^Claude can do$/ })).toBeDefined()
    await ui.press({ key: await rowKey(ui, 'Run the test suite') })
    expect(await ui.find({ type: 'Text', text: /Claude can do this · to do/ })).toBeDefined()
    await ui.press({ key: 'ask' })
    expect(world.calls.fills).toEqual(['Please go ahead with this next step: Run the test suite'])
    await ui.unmount()
  })

  test('optional steps stay folded until asked for', async ($, on) => {
    await ready($, on)
    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.find({ type: 'Button', key: 'tab-optional' }))?.props.label).toContain('Optional · 1')
    await ui.press({ key: 'tab-optional' })
    expect(await stepButton(ui, /Rename the helper/)).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'tab-optional' }))?.text).toContain('●')
    await ui.unmount()
  })

  test('ticking a step closes it into Done; ticking it there brings it back', async ($, on) => {
    await ready($, on)
    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.find({ type: 'Button', key: 'tick-1700000000000-0' }))?.props.label).toBe('Done')
    await ui.press({ key: 'tick-1700000000000-0' })
    expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain('2 pending')
    expect((await ui.find({ type: 'Button', key: 'tab-done' }))?.props.label).toContain('Done · 1')

    await ui.press({ key: 'tab-done' })
    expect(await stepButton(ui, /Run the invoices migration/)).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'tick-1700000000000-0' }))?.props.label).toBe('Reopen')
    await ui.press({ key: 'tick-1700000000000-0' })
    expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain('3 pending')
    await ui.unmount()
  })

  test('skipping sets a step aside and says so', async ($, on) => {
    await ready($, on)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'skip' })
    await ui.press({ key: 'tab-done' })
    const skipped = await ui.find({ type: 'Text', text: /Skipped/ })
    expect(skipped).toBeDefined()
    await ui.unmount()
  })

  test('copy buttons put exactly the SQL and the path on the clipboard', async ($, on) => {
    const world = await ready($, on)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'copy' })
    await ui.press({ key: 'path' })
    expect(world.calls.copies).toEqual([SQL, 'supabase/migrations/0042_invoices.sql'])
    expect(world.calls.toast).toEqual(expect.arrayContaining(['Copied SQL', 'Copied path']))
    await ui.unmount()
  })

  test('refresh reads the last reply again', async ($, on) => {
    const world = await ready($, on)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'refresh' })
    await world.clock.advance(1)
    expect(world.calls.model).toBe(2)
    await ui.unmount()
  })

  test('key hints show only while the panel holds the keyboard', async ($, on) => {
    await ready($, on)
    for (const isFocused of [false, true]) {
      const ui = await $.ui.mount(pane('terminal', { isFocused }))
      expect(Boolean(await ui.find({ type: 'Text', text: /Esc returns to the prompt/ }))).toBe(isFocused)
      await ui.unmount()
    }
  })

  test('the first nine steps answer to the digits 1 to 9', async ($, on) => {
    await ready($, on)
    const ui = await $.ui.mount(pane('terminal'))
    const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('row-'))
    expect(rows.map(r => r.props.hotkey)).toEqual(['1', '2', '3', '4'])
    await ui.unmount()
  })

  test('copes with a very narrow panel and a very long title', async ($, on) => {
    const long = 'Ask the platform team to rotate the shared deployment credentials before the next release window opens on Friday'
    const world = await boot($, on, { model: [answered(reading([{ group: 'you', kind: 'action', title: long }]))] })
    await finishTurn($, world, reply(long))
    const ui = await $.ui.mount(pane('mobile', { bodyColumns: 24 }))
    // The step in the spotlight is never cut: its whole title wraps inside the card.
    const row = await stepButton(ui, /Ask the platform/)
    expect(row?.props.label).toBe(long)
    expect(await ui.find({ type: 'Text', text: long })).toBeDefined()
    await ui.unmount()
  })

  test('says what it is for when empty, and that nothing waits when everything is done', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading([{ group: 'you', kind: 'action', title: 'Log in to the portal' }]))] })
    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: /No next steps yet/ })).toBeDefined()
      await ui.unmount()
    }
    await finishTurn($, world, reply('Log in to the portal when you are ready.'))
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'done' })
    expect(await ui.find({ type: 'Text', text: /Nothing is waiting on you/ })).toBeDefined()
    await ui.unmount()
  })
})
