import { describe, expect, test } from 'claude-code/testing'

import { answered, band, boot, buttonKeys, finishTurn, pane, reading, reply, stepButton } from './support'

const ROOT = 'C:/Users/j/Code/app'
const KEY = 'scope:c:/users/j/code/app'
const NOW = 1_700_000_000_000
const DAY = 24 * 3600_000

const saved = (over: object = {}) => ({
  id: 's1',
  kind: 'action',
  group: 'you',
  status: 'open',
  title: 'Run the migration',
  firstSeen: 1,
  lastSeen: 1,
  missed: 0,
  ...over,
})
const record = (steps: object[], over: object = {}) => ({ v: 1, root: ROOT, steps, updatedAt: NOW - 5000, touched: NOW - 5000, ...over })

const bandText = async ($: Parameters<typeof boot>[0]) => {
  const ui = await $.ui.mount(band('terminal'))
  const text = (await ui.find({ type: 'Text', text: /Next steps|^engine$/ }))?.text
  await ui.unmount()

  return text
}

describe('keeping the list between sessions', () => {
  test('a new session in the same worktree starts with the list it left, reading nothing', async ($, on) => {
    const world = await boot($, on, { store: { [KEY]: record([saved(), saved({ id: 's2', title: 'Open a PR' })]) } })
    expect(await bandText($)).toContain('Run the migration   Next steps · 2 pending')
    expect(world.calls.model).toBe(0)
  })

  test('the same worktree is found however its path is spelled', async ($, on) => {
    await boot($, on, { root: 'C:/Users/J/Code/APP', store: { [KEY]: record([saved()]) } })
    expect(await bandText($)).toContain('1 pending')
  })

  test('another repository, or another worktree of this one, sees none of it', async ($, on) => {
    await boot($, on, {
      store: {
        'scope:c:/users/j/code/other-repo': record([saved({ title: 'Other repo task' })], { root: 'C:/Users/j/Code/other-repo' }),
        'scope:c:/users/j/code/app/.claude/worktrees/x': record([saved({ title: 'Worktree task' })]),
      },
    })
    expect(await bandText($)).toBe('engine')
  })

  test('ticks, skips and the time they happened survive', async ($, on) => {
    await boot($, on, {
      store: {
        [KEY]: record([
          saved({ id: 'a', title: 'Run the migration' }),
          saved({ id: 'b', title: 'Deploy the function', status: 'done', closedAt: NOW - 1000, closedBy: 'you' }),
          saved({ id: 'c', title: 'Tidy the docs', status: 'skipped', closedAt: NOW - 900, closedBy: 'you' }),
        ]),
      },
    })
    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.find({ type: 'Button', key: 'tab-done' }))?.props.label).toContain('Done · 2')
    expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain('1 pending')
    await ui.unmount()
  })

  test('what is read, ticked or cleared is written to the store as it happens', async ($, on) => {
    const sql = 'select 1;'
    const world = await boot($, on, {
      model: [answered(reading([{ group: 'you', kind: 'sql', title: 'Run the check', copy: sql }, { group: 'you', kind: 'action', title: 'Tell the team' }]))],
    })
    await finishTurn($, world, reply('Run this:', sql, 'Then tell the team.'))

    const afterRead = (world.store.get(KEY)) as { v: number; steps: Array<{ title: string; copy?: string; status: string }> }
    expect(afterRead.v).toBe(1)
    expect(afterRead.steps.map(s => [s.title, s.status])).toEqual([['Run the check', 'open'], ['Tell the team', 'open']])
    expect(afterRead.steps[0]?.copy).toBe(sql) // an open step keeps its pasteable text

    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'done' })
    await ui.unmount()
    const afterTick = (world.store.get(KEY)) as { steps: Array<{ status: string; closedBy?: string; copy?: string }> }
    expect(afterTick.steps[0]).toMatchObject({ status: 'done', closedBy: 'you' })
    expect(afterTick.steps[0]?.copy).toBeUndefined() // a closed step does not keep its text

    await $.command.run({ command: 'next-steps', args: 'clear', presentation: { isFullscreen: false, columns: 80 } } as never)
    expect((world.store.get(KEY) as { steps: unknown[] }).steps).toEqual([])
  })

  test('a record that is damaged, from another version or hand-edited is not trusted', async ($, on) => {
    await boot($, on, {
      store: {
        [KEY]: record([
          saved({ id: 'ok', title: 'A fine step', url: 'https://example.com/ok' }),
          saved({ id: 'bad-url', title: 'Link step', url: 'javascript:alert(1)' }),
          saved({ id: 'bad-kind', title: 'Odd kind', kind: 'toString', group: '__proto__' }),
          saved({ id: 'no-title', title: '' }),
          'not an object' as never,
          saved({ id: 'bad-file', title: 'File step', path: 'a.sql', file: { href: 'file:///etc/passwd', label: 'x', copy: 'x' } }),
          saved({ id: 'bad-file-2', title: 'File step 2', path: 'b.sql', file: { href: 'https://evil.example/x', label: 'x', copy: 'x' } }),
        ]),
      },
    })
    const ui = await $.ui.mount(pane('terminal'))
    const links = (await ui.findAll({ type: 'Link' })).map(l => String(l.props.href))
    expect(links.some(h => h.startsWith('javascript:'))).toBe(false)
    expect(links.some(h => h.includes('evil.example'))).toBe(false)
    expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain('5 pending')
    await ui.unmount()
  })

  test('a record from a different version is ignored, not guessed at', async ($, on) => {
    await boot($, on, { store: { [KEY]: { ...record([saved()]), v: 2 } } })
    expect(await bandText($)).toBe('engine')
  })

  test('housekeeping drops old worktrees and all but the thirty most recent, and leaves other keys alone', async ($, on) => {
    const store: Record<string, unknown> = { settings: { keep: true } }
    for (let i = 0; i < 34; i++) store[`scope:/repos/r${i}`] = record([saved()], { touched: NOW - (i + 1) * 1000 })
    store['scope:/repos/ancient'] = record([saved()], { touched: NOW - 100 * DAY })
    const world = await boot($, on, { store })

    const keys = [...world.store.keys()]
    expect(keys).toContain('settings')
    expect(keys).not.toContain('scope:/repos/ancient')
    expect(keys.filter(k => k.startsWith('scope:')).length).toBe(30)
    expect(keys).toContain('scope:/repos/r0') // the most recent stay
    expect(keys).not.toContain('scope:/repos/r33') // the least recent go
  })
})

describe('a new reply adds to the list; it does not replace it', () => {
  const FIRST = [
    { group: 'you', kind: 'action', title: 'Run the invoices migration' },
    { group: 'you', kind: 'action', title: 'Open a PR for feat/invoices' },
  ]

  test('steps that come round again stay one step, and what you ticked stays ticked', async ($, on) => {
    const world = await boot($, on, {
      model: [
        answered(reading(FIRST)),
        answered(reading([{ group: 'you', kind: 'action', title: 'Run the invoices migration' }, { group: 'you', kind: 'action', title: 'Update the staging env vars' }])),
      ],
    })
    await finishTurn($, world, reply('first hand-off'))
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tick-1700000000000-0' }) // the migration is done
    await finishTurn($, world, reply('second hand-off, which mentions the migration again'))

    // Three steps in all: the migration (still done), the PR (not mentioned this time, still open) and the new one.
    expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain('2 pending')
    expect(await stepButton(ui, /Open a PR for feat\/invoices/)).toBeDefined()
    expect(await stepButton(ui, /Update the staging env vars/)).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'tab-done' }))?.props.label).toContain('Done · 1')
    await ui.press({ key: 'tab-done' })
    expect(await stepButton(ui, /Run the invoices migration/)).toBeDefined()
    await ui.unmount()
  })

  test('the model is shown what is open, and can say a reply finished a step', async ($, on) => {
    const world = await boot($, on, {
      model: [answered(reading(FIRST)), answered(reading([], ['1700000000000-0']))],
    })
    await finishTurn($, world, reply('first hand-off'))
    await finishTurn($, world, reply('I ran the invoices migration for you, it applied cleanly.'))

    expect(world.prompts[1]).toContain('1700000000000-0 | you | Run the invoices migration')
    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain('1 pending')
    await ui.press({ key: 'tab-done' })
    await ui.press({ key: 'row-1700000000000-0' })
    expect(await ui.find({ type: 'Text', text: /done \(Claude says so\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('a step the next few replies leave out moves to "Earlier" and stops counting', async ($, on) => {
    const other = (n: number) => answered(reading([{ group: 'you', kind: 'action', title: `Unrelated chore number ${n}` }]))
    const world = await boot($, on, { model: [answered(reading([FIRST[0]!])), other(1), other(2), other(3)] })
    await finishTurn($, world, reply('first'))
    await finishTurn($, world, reply('second'))
    await finishTurn($, world, reply('third'))
    expect((await (async () => {
      const ui = await $.ui.mount(band('terminal'))
      const t = (await ui.find({ type: 'Text', text: /Next steps/ }))?.text
      await ui.unmount()

      return t
    })())).toContain('3 pending')
    await finishTurn($, world, reply('fourth'))

    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain('3 pending') // the three newer chores
    expect((await ui.find({ type: 'Button', key: 'tab-earlier' }))?.props.label).toContain('Earlier · 1')
    await ui.unmount()
  })

  test('opening the panel is never done for you', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading(FIRST))] })
    await finishTurn($, world, reply('hand-off'))
    expect(world.calls.opens).toBe(0)
    expect(await buttonKeys(await $.ui.mount(band('terminal')))).toContain('open')
  })
})
