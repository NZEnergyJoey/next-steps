import { describe, expect, test } from 'claude-code/testing'

import type { Repo, Step } from '../types'
import { MAX_PER_REPLY, parseExtraction, parseSteps, reviveSteps, stepKey } from '../hooks/lib/extract'
import { fileHref, locateFile, parseRemote, prHref, readRepo, relativeTo, type GitRun } from '../hooks/lib/git'
import { MAX_CLOSED, MAX_OPEN, REOPEN_AFTER_MS, STALE_AFTER, prune, reconcile, setStatus } from '../hooks/lib/merge'
import { buildPrompt } from '../hooks/lib/model'
import { effectiveSelection, extras, isStale, lead, ordered, statusText, summarise, tagOf } from '../hooks/lib/select'
import { revive, save, scopeKey, slim } from '../hooks/lib/store'
import { clip, fnv, similarity } from '../hooks/lib/text'

const T0 = 1_700_000_000_000
const MIN = 60_000

const step = (over: Partial<Step> = {}): Step => {
  const base = { id: 'x', kind: 'action' as const, group: 'you' as const, status: 'open' as const, title: 'Do a thing', firstSeen: T0, lastSeen: T0, missed: 0, ...over }

  return { ...base, key: over.key ?? stepKey(base) }
}
const inc = (title: string, over: Record<string, unknown> = {}) => {
  const base = { kind: 'action' as const, group: 'you' as const, title, ...over }

  return { ...base, key: stepKey(base) }
}

describe('reading the model\'s answer', () => {
  test('reads steps with their group, and the ids the reply finished', () => {
    const out = parseExtraction(
      JSON.stringify({
        steps: [
          { group: 'you', kind: 'sql', title: 'Run it', why: 'Because.' },
          { group: 'decision', title: 'Approve the drop' },
          { group: 'claude', kind: 'check', title: 'Run the tests' },
          { group: 'optional', title: 'Rename a helper' },
        ],
        resolved: ['a', 7, 'b'],
      }),
    )
    expect(out?.steps.map(s => [s.group, s.kind])).toEqual([['you', 'sql'], ['decision', 'action'], ['claude', 'check'], ['optional', 'action']])
    expect(out?.steps[0]?.why).toBe('Because.')
    expect(out?.resolved).toEqual(['a', 'b'])
  })

  test('accepts the older bare array, and the older "detail" for "why"', () => {
    const out = parseExtraction('[{"kind":"command","title":"Install deps","detail":"Needed first","copy":"npm ci"}]')
    expect(out?.steps[0]).toMatchObject({ group: 'you', kind: 'command', why: 'Needed first', copy: 'npm ci' })
    expect(parseSteps('[{"title":"x"}]', 9)[0]).toMatchObject({ id: '9-0', status: 'open', firstSeen: 9 })
  })

  test('finds the JSON in a code fence or among prose', () => {
    expect(parseExtraction('```json\n{"steps":[{"title":"A"}],"resolved":[]}\n```')?.steps).toHaveLength(1)
    expect(parseExtraction('Sure! Here you go: {"steps":[{"title":"A"}]} Hope that helps.')?.steps).toHaveLength(1)
  })

  test('an unreadable answer is not the same as a reply that asks nothing', () => {
    expect(parseExtraction('No next steps.')).toBeUndefined()
    expect(parseExtraction('{"steps": [ {"title": ')).toBeUndefined()
    expect(parseExtraction('{"steps": "nope"}')).toBeUndefined()
    expect(parseExtraction('{"steps": [], "resolved": []}')).toEqual({ steps: [], resolved: [] })
    expect(parseExtraction('[]')).toEqual({ steps: [], resolved: [] })
  })

  test('words the model might use for a group are understood; names that are not words are not', () => {
    const groups = ['User', 'approve', 'Assistant', 'suggestion', 'constructor', '__proto__', 'toString', 42, null].map(g => parseExtraction(JSON.stringify([{ title: 't', group: g }]))?.steps[0]?.group)
    expect(groups).toEqual(['you', 'decision', 'claude', 'optional', 'you', 'you', 'you', 'you', 'you'])
    const kinds = ['sql', 'toString', 'constructor', '__proto__', 7].map(k => parseExtraction(JSON.stringify([{ title: 't', kind: k }]))?.steps[0]?.kind)
    expect(kinds).toEqual(['sql', 'action', 'action', 'action', 'action'])
  })

  test('keeps at most twelve steps, and one of each', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `Chore ${String.fromCharCode(97 + i)} alpha-${i}`, path: undefined }))
    expect(parseExtraction(JSON.stringify(many))?.steps).toHaveLength(MAX_PER_REPLY)
    expect(parseExtraction(JSON.stringify([{ title: 'Same', copy: 'npm ci' }, { title: 'Also same', copy: 'npm  ci' }]))?.steps).toHaveLength(1)
  })
})

describe('the safety rules for SQL, commands, paths and URLs', () => {
  const REPLY = 'Run `supabase/migrations/0042_invoices.sql`:\n\n    select\n      1;\n\nThen see https://github.com/acme/app/pull/12 .'

  test('only http and https links are kept', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'ftp://x/y', '//evil.example/x', 'not a url']) {
      expect(parseExtraction(JSON.stringify([{ title: 't', url: bad }]))?.steps[0]?.url).toBeUndefined()
    }
    expect(parseExtraction(JSON.stringify([{ title: 't', url: 'https://x.example/a' }]))?.steps[0]?.url).toBe('https://x.example/a')
  })

  test('code, paths and links must really be in the reply, or they are dropped', () => {
    const out = parseExtraction(
      JSON.stringify([
        { title: 'real', copy: 'select\n1;', path: 'supabase/migrations/0042_invoices.sql', url: 'https://github.com/acme/app/pull/12' },
        { title: 'invented', copy: 'drop table invoices;', path: 'supabase/migrations/9999_secret.sql', url: 'https://github.com/acme/app/pull/99' },
      ]),
      REPLY,
    )
    expect(out?.steps[0]).toMatchObject({ copy: 'select\n1;', path: 'supabase/migrations/0042_invoices.sql', url: 'https://github.com/acme/app/pull/12' })
    expect(out?.steps[1]?.copy).toBeUndefined()
    expect(out?.steps[1]?.path).toBeUndefined()
    expect(out?.steps[1]?.url).toBeUndefined()
    expect(out?.steps[1]?.title).toBe('invented') // the step stays; only what could not be checked goes
  })

  test('a folder the reply names is joined to the path, as the prompt asks for', () => {
    const out = parseExtraction(JSON.stringify([{ title: 't', path: 'C:/Users/j/Code/app/supabase/0042_invoices.sql' }]), REPLY)
    expect(out?.steps[0]?.path).toBe('C:/Users/j/Code/app/supabase/0042_invoices.sql')
  })

  test('indentation and line breaks do not stop a real snippet from being recognised', () => {
    expect(parseExtraction(JSON.stringify([{ title: 't', copy: 'select\n  1;' }]), REPLY)?.steps[0]?.copy).toBe('select\n  1;')
  })

  test('line breaks matter: a flattened or re-joined version of the reply\'s code is not the code', () => {
    const reply = '-- cleanup\nDROP TABLE x;'
    expect(parseExtraction(JSON.stringify([{ title: 't', copy: '-- cleanup DROP TABLE x;' }]), reply)?.steps[0]?.copy).toBeUndefined()
    expect(parseExtraction(JSON.stringify([{ title: 't', copy: '-- cleanup\n  DROP TABLE x;' }]), reply)?.steps[0]?.copy).toBe('-- cleanup\n  DROP TABLE x;')
  })

  test('a path that climbs out of the folder is left out even if its file name is in the reply', () => {
    expect(parseExtraction(JSON.stringify([{ title: 't', path: '../../x/0042_invoices.sql' }]), 'see 0042_invoices.sql')?.steps[0]?.path).toBeUndefined()
  })

  test('code is never cut short: too long means left out', () => {
    const long = `select ${'x, '.repeat(5000)}1;`
    expect(long.length).toBeGreaterThan(12000)
    expect(parseExtraction(JSON.stringify([{ title: 't', copy: long }]))?.steps[0]?.copy).toBeUndefined()
    const fits = `select ${'x, '.repeat(100)}1;`
    expect(parseExtraction(JSON.stringify([{ title: 't', copy: fits }]))?.steps[0]?.copy).toBe(fits)
  })

  test('paths with line breaks or control characters are left out', () => {
    expect(parseExtraction(JSON.stringify([{ title: 't', path: 'a.sql\nrm -rf /' }]))?.steps[0]?.path).toBeUndefined()
    expect(parseExtraction(JSON.stringify([{ title: 't', path: 'a\u0000.sql' }]))?.steps[0]?.path).toBeUndefined()
  })

  test('prose is cleaned of control characters and long text is cut with an ellipsis', () => {
    const out = parseExtraction(JSON.stringify([{ title: `Line one\u0007\nline two ${'z'.repeat(300)}` }]))
    expect(out?.steps[0]?.title.includes('\u0007')).toBe(false)
    expect(out?.steps[0]?.title.endsWith('…')).toBe(true)
    expect(out?.steps[0]?.title.length).toBeLessThanOrEqual(200)
  })

  test('what was saved is held to the same rules when it is read back', () => {
    const out = reviveSteps([
      { id: 'a', title: 'Fine', url: 'javascript:alert(1)', copy: 'ok', kind: 'toString', group: 'constructor' },
      { id: 'b', title: 'Bad file', file: { href: 'https://evil.example/x', label: 'l', copy: 'c' } },
      { id: '', title: 'No id' },
      { id: 'c', title: '' },
      null,
      'x',
    ])
    expect(out.map(s => s.id)).toEqual(['a', 'b'])
    expect(out[0]).toMatchObject({ url: undefined, copy: 'ok', kind: 'action', group: 'you', status: 'open' })
    expect(out[1]?.file).toBeUndefined()
    expect(reviveSteps('nonsense')).toEqual([])
  })
})

describe('recognising the same step again', () => {
  test('the same code, link or file is the same step; the same words are too', () => {
    expect(stepKey({ kind: 'sql', title: 'a', copy: 'select\n 1;' })).toBe(stepKey({ kind: 'sql', title: 'b', copy: 'select 1;' }))
    expect(stepKey({ kind: 'pr', title: 'a', url: 'https://x.example/p/1/' })).toBe(stepKey({ kind: 'pr', title: 'b', url: 'https://x.example/p/1' }))
    expect(stepKey({ kind: 'file', title: 'a', path: 'A\\b.sql' })).toBe(stepKey({ kind: 'file', title: 'b', path: 'a/B.sql' }))
    expect(stepKey({ kind: 'action', title: 'Run the Migration!' })).toBe(stepKey({ kind: 'action', title: 'run migration' }))
    expect(stepKey({ kind: 'action', title: 'Review PR 1' })).not.toBe(stepKey({ kind: 'action', title: 'Review PR 2' }))
  })

  test('title similarity', () => {
    expect(similarity('Run the database migration', 'Run database migration 0042')).toBeGreaterThanOrEqual(0.7)
    expect(similarity('Run the migration', 'Open a pull request')).toBeLessThan(0.3)
    expect(similarity('Chore 1', 'Chore 2')).toBeLessThan(0.7)
    expect(similarity('', 'x')).toBe(0)
  })
})

describe('merging a new reply into the list', () => {
  test('the first reply makes open steps with their own ids', () => {
    const r = reconcile([], [inc('A step'), inc('Another step')], [], T0)
    expect(r.steps.map(s => [s.id, s.status, s.missed])).toEqual([['1700000000000-0', 'open', 0], ['1700000000000-1', 'open', 0]])
    expect(r.added).toHaveLength(2)
  })

  test('a step that comes round again is the same step, refreshed, with its place and id kept', () => {
    const first = reconcile([], [inc('Run the migration'), inc('Open a PR')], [], T0).steps
    const again = reconcile(first, [inc('Open a PR', { why: 'New reason' }), inc('Run the migration')], [], T0 + MIN)
    expect(again.steps.map(s => s.id)).toEqual(first.map(s => s.id))
    expect(again.steps[1]?.why).toBe('New reason')
    expect(again.steps.every(s => s.lastSeen === T0 + MIN)).toBe(true)
    expect(again.added).toHaveLength(0)
  })

  test('steps the reply leaves out are kept, and count the replies that left them out', () => {
    let list = reconcile([], [inc('Run the migration')], [], T0).steps
    const chores = ['Deploy the function', 'Review the dashboard', 'Rotate the signing keys']
    for (let i = 1; i <= STALE_AFTER; i++) {
      list = reconcile(list, [inc(chores[i - 1]!)], [], T0 + i * MIN).steps
      expect(list.find(s => s.title === 'Run the migration')?.missed).toBe(i)
    }
    const old = list.find(s => s.title === 'Run the migration')
    expect(old).toBeDefined()
    expect(old && isStale(old)).toBe(true)
    expect(summarise(list).earlier.map(s => s.title)).toEqual(['Run the migration'])
    expect(summarise(list).pending).toBe(STALE_AFTER)
  })

  test('reading the same reply again (Refresh) does not age the older steps', () => {
    let list = reconcile([], [inc('Run the migration')], [], T0).steps
    list = reconcile(list, [inc('Deploy the function')], [], T0 + MIN).steps
    for (let i = 2; i < 8; i++) list = reconcile(list, [inc('Deploy the function')], [], T0 + i * MIN, false).steps
    expect(list.find(s => s.title === 'Run the migration')?.missed).toBe(1)
  })

  test('a reply with no steps changes nothing and ages nothing', () => {
    const list = reconcile([], [inc('Run the migration')], [], T0).steps
    const after = reconcile(list, [], [], T0 + MIN)
    expect(after.steps).toEqual(list)
  })

  test('mentioning a step again brings it back from "earlier"', () => {
    const list = reconcile([], [inc('Run the migration')], [], T0).steps.map(s => ({ ...s, missed: STALE_AFTER }))
    expect(summarise(list).earlier).toHaveLength(1)
    const back = reconcile(list, [inc('Run the migration')], [], T0 + MIN).steps
    expect(summarise(back).todo).toHaveLength(1)
  })

  test('steps a reply says are done are closed for you, and only open ones that exist', () => {
    const list = reconcile([], [inc('Run the migration'), inc('Open a PR')], [], T0).steps
    const r = reconcile(list, [], ['1700000000000-0', 'no-such-id'], T0 + MIN)
    expect(r.resolved.map(s => s.title)).toEqual(['Run the migration'])
    expect(r.steps[0]).toMatchObject({ status: 'done', closedBy: 'reply', closedAt: T0 + MIN })
    expect(r.steps[1]?.status).toBe('open')
    expect(reconcile(r.steps, [], ['1700000000000-0'], T0 + 2 * MIN).resolved).toHaveLength(0) // already closed
  })

  test('what you closed stays closed when Claude, not having heard, lists it again soon after', () => {
    let list = reconcile([], [inc('Run the migration')], [], T0).steps
    list = setStatus(list, '1700000000000-0', 'done', T0 + MIN)
    const again = reconcile(list, [inc('Run the migration')], [], T0 + 2 * MIN)
    expect(again.steps).toHaveLength(1)
    expect(again.steps[0]?.status).toBe('done')
    expect(again.added).toHaveLength(0)
  })

  test('long after, the same step is a new occurrence (run the tests again) and replaces its old record', () => {
    let list = reconcile([], [inc('Run the tests', { copy: 'npm test' })], [], T0).steps
    list = setStatus(list, '1700000000000-0', 'done', T0 + MIN)
    const later = reconcile(list, [inc('Run the tests', { copy: 'npm test' })], [], T0 + MIN + REOPEN_AFTER_MS + 1)
    expect(later.added).toHaveLength(1)
    expect(later.steps.filter(s => s.title === 'Run the tests')).toHaveLength(1)
    expect(later.steps[0]?.status).toBe('open')
  })

  test('a step closed by a reply comes back if a later reply asks for it again', () => {
    const list = reconcile([], [inc('Run the migration')], [], T0).steps
    const closed = reconcile(list, [], ['1700000000000-0'], T0 + MIN).steps
    const back = reconcile(closed, [inc('Run the migration')], [], T0 + 2 * MIN).steps
    expect(back[0]).toMatchObject({ status: 'open', closedBy: undefined })
  })

  test('titles that are alike, for the same kind of step, are one step; for another kind they are not', () => {
    const list = reconcile([], [inc('Run the database migration', { kind: 'sql' })], [], T0).steps
    expect(reconcile(list, [inc('Run database migration 0042', { kind: 'sql' })], [], T0 + MIN).steps).toHaveLength(1)
    expect(reconcile(list, [inc('Run database migration 0042', { kind: 'check' })], [], T0 + MIN).steps).toHaveLength(2)
  })

  test('the same step twice in one reply is added once', () => {
    expect(reconcile([], [inc('Same'), inc('Same')], [], T0).steps).toHaveLength(1)
  })

  test('the list is kept to its caps: suggestions and the long ignored go first, then the oldest closed', () => {
    const many = Array.from({ length: MAX_OPEN + 5 }, (_, i) => step({ id: `o${i}`, title: `Chore ${i}`, group: i < 5 ? 'optional' : 'you', lastSeen: T0 + i }))
    const kept = prune(many)
    expect(kept).toHaveLength(MAX_OPEN)
    expect(kept.filter(s => s.group === 'optional')).toHaveLength(0)

    const closed = Array.from({ length: MAX_CLOSED + 4 }, (_, i) => step({ id: `c${i}`, status: 'done', closedAt: T0 + i, title: `Closed ${i}` }))
    const left = prune(closed)
    expect(left).toHaveLength(MAX_CLOSED)
    expect(left.map(s => s.id)).not.toContain('c0')
  })

  test('setStatus closes, skips and reopens one step and no other', () => {
    const list = [step({ id: 'a' }), step({ id: 'b' })]
    const done = setStatus(list, 'a', 'done', T0)
    expect(done[0]).toMatchObject({ status: 'done', closedBy: 'you', closedAt: T0 })
    expect(done[1]).toBe(list[1])
    expect(setStatus(done, 'a', 'open', T0 + 1)[0]).toMatchObject({ status: 'open', closedAt: undefined, closedBy: undefined })
    expect(setStatus(list, 'b', 'skipped', T0)[1]?.status).toBe('skipped')
  })
})

describe('reading the list', () => {
  const list = [
    step({ id: '1', group: 'optional', title: 'Nice to have' }),
    step({ id: '2', group: 'claude', title: 'Run the tests' }),
    step({ id: '3', group: 'decision', title: 'Approve the drop' }),
    step({ id: '4', group: 'you', title: 'Run the migration' }),
    step({ id: '5', group: 'you', title: 'Old thing', missed: STALE_AFTER }),
    step({ id: '6', group: 'you', title: 'Finished', status: 'done', closedAt: T0 + 5 }),
    step({ id: '7', group: 'you', title: 'Set aside', status: 'skipped', closedAt: T0 + 9 }),
  ]

  test('what is for you comes first, in the order given, and the next step is the first of it', () => {
    const s = summarise(list)
    expect(s.todo.map(x => x.id)).toEqual(['3', '4'])
    expect(s.claude.map(x => x.id)).toEqual(['2'])
    expect(s.optional.map(x => x.id)).toEqual(['1'])
    expect(s.earlier.map(x => x.id)).toEqual(['5'])
    expect(s.closed.map(x => x.id)).toEqual(['7', '6'])
    expect(s.next?.id).toBe('3')
    expect(s.pending).toBe(2)
    expect(s.attention).toBe('you')
    expect(ordered(s).map(x => x.id)).toEqual(['3', '4', '2', '1'])
  })

  test('when nothing is for you, the next step is Claude\'s; suggestions are never "next"', () => {
    const onlyClaude = summarise([step({ id: 'c', group: 'claude' }), step({ id: 'o', group: 'optional' })])
    expect(onlyClaude.next?.id).toBe('c')
    expect(onlyClaude.attention).toBe('claude')
    const onlyOptional = summarise([step({ id: 'o', group: 'optional' })])
    expect(onlyOptional.next).toBeUndefined()
    expect(onlyOptional.attention).toBe('optional')
    expect(summarise([]).attention).toBe('clear')
  })

  test('the words for the one-line summary', () => {
    const s = summarise(list)
    expect(lead(s)).toBe('2 pending')
    expect(extras(s)).toBe('1 for Claude · 1 optional')
    expect(statusText(s)).toBe('Next steps · 2 pending · Approve the drop')
    expect(lead(summarise([step({ group: 'claude' })]))).toBe('1 for Claude')
    expect(statusText(summarise([step({ group: 'optional' })]))).toBeUndefined()
    expect(tagOf(step({ group: 'you' }))).toBe('')
    expect(tagOf(step({ group: 'decision' }))).toBe('decision')
    expect(tagOf(step({ status: 'skipped' }))).toBe('skipped')
  })

  test('which step the panel has open', () => {
    const s = summarise(list)
    const rows = [...s.todo, ...s.claude]
    expect(effectiveSelection(null, s, rows)).toBe('3') // follows the next step
    expect(effectiveSelection('2', s, rows)).toBe('2') // the reader's pick
    expect(effectiveSelection('', s, rows)).toBeUndefined() // folded on purpose
    expect(effectiveSelection('gone', s, rows)).toBe('3') // a pick that no longer exists
  })
})

describe('asking the model', () => {
  test('lists the open steps by id so the model can say which a reply finished', () => {
    const p = buildPrompt('the reply', [step({ id: 'a', title: 'Run it' }), step({ id: 'b', status: 'done', title: 'Done already' })])
    expect(p).toContain('a | you | Run it')
    expect(p).not.toContain('Done already')
    expect(buildPrompt('r', [])).toContain('There are no open steps yet.')
  })

  test('sends the end of a very long reply', () => {
    const p = buildPrompt(`HEAD${'x'.repeat(50_000)}TAIL`, [])
    expect(p).toContain('TAIL')
    expect(p).not.toContain('HEAD')
  })
})

describe('git: which branch and worktree hold a file', () => {
  const REPO: Repo = { owner: 'acme', name: 'app', branch: 'main' }
  const fake = (answers: Record<string, string>, log: string[] = []): GitRun => async (cwd, args) => {
    const line = args.join(' ')
    log.push(`${cwd ?? '.'}> ${line}`)
    const out = answers[`${cwd ?? '.'}> ${line}`] ?? answers[line]

    return out === undefined ? { ok: false, out: '' } : { ok: true, out }
  }
  const WORKTREES = [
    'worktree C:/code/app', 'HEAD 1', 'branch refs/heads/main', '',
    'worktree C:/code/wt/invoices', 'HEAD 2', 'branch refs/heads/feat/invoices', '',
    'worktree C:/code/wt/newer', 'HEAD 3', 'branch refs/heads/feat/newer', '',
  ].join('\n')

  test('reads the repository, branch and top level, with fallbacks', async () => {
    const run = fake({ 'remote get-url origin': 'https://github.com/acme/app.git', 'rev-parse --abbrev-ref HEAD': 'main', 'rev-parse --show-toplevel': 'C:/code/app' })
    expect(await readRepo(run, async () => '/cwd')).toEqual({ repo: { owner: 'acme', name: 'app', branch: 'main' }, root: 'C:/code/app' })
    expect(await readRepo(fake({}), async () => '/cwd')).toEqual({ repo: null, root: '/cwd' })
    expect(parseRemote('git@github.com:acme/app.git')).toEqual({ owner: 'acme', name: 'app' })
  })

  test('a file in the session\'s own pushed branch links to GitHub, with the branch left unsaid', async () => {
    const run = fake({
      'worktree list --porcelain': WORKTREES,
      'C:/code/app> cat-file -e HEAD:src/a.sql': '',
      'C:/code/app> cat-file -e refs/remotes/origin/main:src/a.sql': '',
    })
    expect(await locateFile(run, 'C:/code/app', REPO, 'src/a.sql')).toEqual({ href: 'https://github.com/acme/app/blob/main/src/a.sql', label: 'src/a.sql', branch: undefined, copy: 'src/a.sql' })
  })

  test('a file that was never pushed links to the local file and says so', async () => {
    const run = fake({ 'worktree list --porcelain': WORKTREES, 'C:/code/app> cat-file -e HEAD:src/a.sql': '' })
    expect(await locateFile(run, 'C:/code/app', REPO, 'src/a.sql')).toEqual({ href: 'file:///C:/code/app/src/a.sql', label: 'src/a.sql', branch: 'main, not on GitHub yet', copy: 'src/a.sql' })
  })

  test('a file only another worktree has is found there; the newest commit wins among several', async () => {
    const run = fake({
      'worktree list --porcelain': WORKTREES,
      'C:/code/wt/invoices> cat-file -e HEAD:src/b.sql': '',
      'C:/code/wt/newer> cat-file -e HEAD:src/b.sql': '',
      'C:/code/wt/invoices> log -1 --format=%ct HEAD -- src/b.sql': '100',
      'C:/code/wt/newer> log -1 --format=%ct HEAD -- src/b.sql': '200',
      'C:/code/wt/newer> cat-file -e refs/remotes/origin/feat/newer:src/b.sql': '',
    })
    expect(await locateFile(run, 'C:/code/app', REPO, 'src/b.sql')).toEqual({
      href: 'https://github.com/acme/app/blob/feat/newer/src/b.sql',
      label: 'src/b.sql',
      branch: 'feat/newer',
      copy: 'C:/code/wt/newer/src/b.sql', // another worktree: copy the whole path
    })
  })

  test('an absolute path names its worktree outright; a path in no worktree, or no worktrees at all, is left alone', async () => {
    const run = fake({ 'worktree list --porcelain': WORKTREES })
    expect((await locateFile(run, 'C:/code/app', REPO, 'C:\\code\\wt\\invoices\\src\\c.sql'))?.branch).toBe('feat/invoices, not on GitHub yet')
    expect(await locateFile(run, 'C:/code/app', REPO, 'D:/elsewhere/c.sql')).toBeUndefined()
    expect(await locateFile(fake({}), 'C:/code/app', REPO, 'src/a.sql')).toBeUndefined()
  })

  test('paths and links the panel falls back on', () => {
    expect(relativeTo('C:/code/app', 'C:\\Code\\App\\src\\a.sql')).toBe('src/a.sql')
    expect(relativeTo('C:/code/app', './src/a.sql')).toBe('src/a.sql')
    expect(fileHref('C:/code/app', REPO, 'src/a b.sql')).toBe('https://github.com/acme/app/blob/main/src/a%20b.sql')
    expect(fileHref('C:/code/app', null, 'src/a b.sql')).toBe('file:///C:/code/app/src/a%20b.sql')
    expect(prHref(REPO, { kind: 'pr', title: 'Open a PR for feat/x' })).toBe('https://github.com/acme/app/compare/main?expand=1')
    expect(prHref(REPO, { kind: 'pr', title: 'Review the PR' })).toBeUndefined()
    expect(prHref(null, { kind: 'pr', title: 'Open a PR' })).toBeUndefined()
    expect(prHref(REPO, { kind: 'pr', title: 'Open a PR', url: 'https://x.example/pr/1' })).toBe('https://x.example/pr/1')
  })
})

describe('the store', () => {
  const fakeStore = (fail = false) => {
    const set: Array<[string, unknown]> = []
    const $ = { store: { set: async (k: string, v: unknown) => { if (fail) throw new Error('full'); set.push([k, v]) } } }

    return { $: $ as never, set }
  }

  test('each worktree has its own key, however its path is spelled', () => {
    expect(scopeKey('C:\\Users\\J\\Code\\App\\')).toBe('scope:c:/users/j/code/app')
    expect(scopeKey('/home/j/app')).not.toBe(scopeKey('/home/j/other'))
  })

  test('only a record of this version is read back', () => {
    expect(revive({ v: 1, steps: [{ id: 'a', title: 'T' }], updatedAt: 5, touched: 6 }, '/r')?.steps).toHaveLength(1)
    expect(revive({ v: 2, steps: [] }, '/r')).toBeUndefined()
    expect(revive('junk', '/r')).toBeUndefined()
    expect(revive(null, '/r')).toBeUndefined()
  })

  test('a closed step keeps its words but not its pasteable text', () => {
    const [open, closed] = slim([step({ copy: 'a', language: 'sql' }), step({ copy: 'b', language: 'sql', status: 'done' })])
    expect(open?.copy).toBe('a')
    expect(closed).toMatchObject({ copy: undefined, language: undefined, status: 'done' })
  })

  test('writes go in order, and a store that refuses is reported, not thrown', async () => {
    const ok = fakeStore()
    expect(await save(ok.$, '/r', [step({ id: '1' })], 1, 2)).toBe(true)
    expect(await save(ok.$, '/r', [step({ id: '2' })], 1, 3)).toBe(true)
    expect(ok.set.map(([, v]) => (v as { steps: Array<{ id: string }> }).steps[0]?.id)).toEqual(['1', '2'])
    expect(await save(fakeStore(true).$, '/r', [], 1, 2)).toBe(false)
    expect(await save(ok.$, '/r', [step({ id: '3' })], 1, 4)).toBe(true) // and the next write still goes through
  })
})

describe('small text helpers', () => {
  test('clip, fnv', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('abc', 4)).toBe('abc')
    expect(clip('abc', 1)).toBe('…')
    expect(fnv('same')).toBe(fnv('same'))
    expect(fnv('a')).not.toBe(fnv('b'))
  })
})
