import { describe, expect, test } from 'claude-code/testing'
import type { CommandRunInput, RenderPropsOf } from 'claude-code'

import { localHref, parseRemote, parseSteps, parseWorktrees, slashes, worktreeOf } from '../hooks/register'

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

describe('finding the worktree that holds a file', () => {
  const PORCELAIN = [
    'worktree C:/Users/j/Docs/Code/Web/nzenergy-portal', 'HEAD 6cd36c4', 'branch refs/heads/feature/addinvoices', '',
    'worktree C:/Users/j/Docs/Code/Web/nzenergy-portal/.claude/worktrees/x', 'HEAD 1111111', 'branch refs/heads/feature/x', '',
    'worktree C:/Users/j/Code/NZE-Worktrees/supplier-invoice-list', 'HEAD 00d4615', 'branch refs/heads/feature/supplier-invoice-list-improvements', '',
    'worktree C:/Users/j/Code/NZE-Worktrees/finishedtasks', 'HEAD 9cfe980', 'detached', '',
  ].join('\r\n')

  test('reads branches from git worktree list --porcelain and skips detached ones', async () => {
    const w = parseWorktrees(PORCELAIN)
    expect(w.map(x => x.branch)).toEqual(['feature/addinvoices', 'feature/x', 'feature/supplier-invoice-list-improvements'])
    expect(w[2]?.root).toBe('C:/Users/j/Code/NZE-Worktrees/supplier-invoice-list')
  })

  test('an absolute Windows path names its worktree, the deepest one when worktrees nest, whatever the slashes or case', async () => {
    const w = parseWorktrees(PORCELAIN)
    const a = worktreeOf(slashes('C:\\Users\\j\\Code\\NZE-Worktrees\\supplier-invoice-list\\supabase\\preflight_130_checks.sql'), w)
    expect(a?.worktree.branch).toBe('feature/supplier-invoice-list-improvements')
    expect(a?.rel).toBe('supabase/preflight_130_checks.sql')
    const b = worktreeOf('c:/users/j/docs/code/web/nzenergy-portal/.claude/worktrees/x/src/a.js', w)
    expect(b?.worktree.branch).toBe('feature/x')
    expect(b?.rel).toBe('src/a.js')
    expect(worktreeOf('D:/elsewhere/a.sql', w)).toBe(undefined)
  })

  test('local links are proper file URLs', async () => {
    expect(localHref('C:/Users/j/Code/a b/x.sql')).toBe('file:///C:/Users/j/Code/a%20b/x.sql')
    expect(localHref('/home/j/x.sql')).toBe('file:///home/j/x.sql')
    expect(slashes('.\\supabase\\x.sql')).toBe('supabase/x.sql')
  })
})
