import { describe, expect, test } from 'claude-code/testing'
import type { CommandRunInput, RenderPropsOf } from 'claude-code'

import { parseRemote, parseSteps } from '../hooks/register'

const PANE = { plugin: 'next-steps', component: 'Pane', requestId: 'next-steps', props: {} as RenderPropsOf['Pane'] } as const

const REPLY = `Here you go:
[
 {"kind":"sql","title":"Run the invoices migration","path":"supabase/migrations/0042_invoices.sql"},
 {"kind":"command","title":"Install deps","copy":"npm ci","language":"bash"},
 {"kind":"pr","title":"Open a PR for feat/invoices","url":"https://github.com/o/r/compare/feat/invoices?expand=1"},
 {"kind":"bogus","title":"Tell the team"},
 {"kind":"pr","title":"bad url","url":"javascript:alert(1)"},
 {"title":""}
]`

describe('parsing', () => {
  test('keeps steps in order and drops junk', async () => {
    const steps = parseSteps(REPLY, 7)
    expect(steps.map(s => s.kind)).toEqual(['sql', 'command', 'pr', 'action', 'pr'])
    expect(steps[0]?.path).toBe('supabase/migrations/0042_invoices.sql')
    expect(steps[1]?.copy).toBe('npm ci')
    expect(steps[4]?.url).toBe(undefined)
    expect(steps[0]?.id).toBe('7-0')
  })

  test('answers nothing for prose or broken JSON', async () => {
    expect(parseSteps('No next steps.', 1)).toEqual([])
    expect(parseSteps('[ {"title": ', 1)).toEqual([])
  })

  test('reads owner and repo from remotes', async () => {
    expect(parseRemote('git@github.com:nzenergyjoey/nzenergy-portal.git')).toEqual({ owner: 'nzenergyjoey', name: 'nzenergy-portal' })
    expect(parseRemote('http://proxy@127.0.0.1:1234/git/nzenergyjoey/nzenergy-portal')).toEqual({ owner: 'nzenergyjoey', name: 'nzenergy-portal' })
  })
})

test('the empty pane says what it is for, on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /No next steps yet/ })).toBeDefined()
    await ui.unmount()
  }
})

test('refresh with no reply yet explains itself', async $ => {
  const r = await $.command.run({ command: 'next-steps', args: 'refresh' } as CommandRunInput)
  expect(JSON.stringify(r)).toContain('No reply to summarise yet')
})
