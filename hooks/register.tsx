import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileLink, Repo, Step, StepKind, StepsStatus } from '../types'

const PANE = 'next-steps'
const COMMAND = 'next-steps'

const steps = atom({ plugin: 'next-steps', key: 'steps' } as const, [])
const done = atom({ plugin: 'next-steps', key: 'done' } as const, [])
const status = atom({ plugin: 'next-steps', key: 'status' } as const, 'idle')
const updatedAt = atom({ plugin: 'next-steps', key: 'updatedAt' } as const, 0)
const lastAnswer = atom({ plugin: 'next-steps', key: 'lastAnswer' } as const, '')
const repo = atom({ plugin: 'next-steps', key: 'repo' } as const, null)

// Replies shorter than this are chat, not a hand-off: they never replace the list.
const MIN_ANSWER = 160

const KINDS: Record<StepKind, { label: string; color: string }> = {
  pr: { label: 'PR', color: 'magenta' },
  sql: { label: 'SQL', color: 'cyan' },
  command: { label: 'RUN', color: 'green' },
  file: { label: 'FILE', color: 'blue' },
  deploy: { label: 'DEPLOY', color: 'red' },
  review: { label: 'REVIEW', color: 'yellow' },
  check: { label: 'CHECK', color: 'yellow' },
  action: { label: 'DO', color: 'white' },
}

const SYSTEM = `You turn a coding assistant's reply into the reader's next steps.

Return ONLY a JSON array, no prose, no code fence. Each item:
{"kind": "pr"|"sql"|"command"|"file"|"deploy"|"review"|"check"|"action",
 "title": "imperative, max ~70 chars, e.g. 'Open a PR for branch feat/x'",
 "detail": "optional one short sentence of context",
 "copy": "optional EXACT text to paste: the full SQL, shell command, or snippet, copied verbatim from the reply",
 "language": "optional highlighter id for copy: sql, bash, ts, json ...",
 "path": "optional file path exactly as written in the reply; if the reply says the file is in a particular folder, give that folder joined with the path",
 "url": "optional URL exactly as written in the reply"}

Rules:
- Only steps the READER (a human) must do next, in the order they should do them. Skip work the assistant says it already did.
- One action per item. Running a SQL migration file is kind "sql" with its path; pasting SQL is kind "sql" with copy.
- Never invent SQL, commands, paths or URLs. Copy them character-for-character from the reply, or leave the field out.
- At most 12 items. If the reply asks nothing of the reader, return [].`

type Raw = Partial<Record<keyof Step, unknown>>

const text = (v: unknown, max = 4000): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined

export function parseSteps(reply: string, stamp: number): Step[] {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let raw: unknown
  try {
    raw = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  return raw
    .filter((r): r is Raw => typeof r === 'object' && r !== null)
    .map((r, i): Step | undefined => {
      const title = text(r.title, 200)
      if (title === undefined) return undefined
      const kind = (typeof r.kind === 'string' && r.kind in KINDS ? r.kind : 'action') as StepKind
      const url = text(r.url, 2000)

      return {
        id: `${stamp}-${i}`,
        kind,
        title,
        detail: text(r.detail, 400),
        copy: text(r.copy, 20000),
        language: text(r.language, 20),
        path: text(r.path, 500),
        url: url !== undefined && /^https?:\/\//.test(url) ? url : undefined,
      }
    })
    .filter((s): s is Step => s !== undefined)
    .slice(0, 12)
}

export function parseRemote(remote: string): { owner: string; name: string } | undefined {
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim())

  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : undefined
}

async function readRepo($: EngineInterface): Promise<{ repo: Repo | null; root: string }> {
  const git = (args: string[]) =>
    $.process.run(['git', ...args]).then(
      r => (r.exitCode === 0 ? r.stdout.trim() : ''),
      () => '',
    )
  const [remote, branch, root] = await Promise.all([
    git(['remote', 'get-url', 'origin']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['rev-parse', '--show-toplevel']),
  ])
  const gh = parseRemote(remote)

  return {
    repo: gh && branch !== '' ? { ...gh, branch } : null,
    root: root || (await $.session.cwd()),
  }
}

let repoRoot = ''

const relative = (path: string) =>
  repoRoot !== '' && path.startsWith(repoRoot + '/') ? path.slice(repoRoot.length + 1) : path.replace(/^\.\//, '')

const blobHref = (r: Pick<Repo, 'owner' | 'name'>, branch: string, rel: string) =>
  `https://github.com/${r.owner}/${r.name}/blob/${branch.split('/').map(encodeURIComponent).join('/')}/${rel.split('/').map(encodeURIComponent).join('/')}`

/** file:// URL for a local path: `C:\a b\x` becomes `file:///C:/a%20b/x`, `/x` becomes `file:///x`. */
export function localHref(abs: string): string {
  const joined = slashes(abs)
    .split('/')
    .map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)))
    .join('/')
  return `file://${joined.startsWith('/') ? '' : '/'}${joined}`
}

function fileHref(r: Repo | null, path: string): string {
  const rel = relative(path)
  if (r) return blobHref(r, r.branch, rel)

  return localHref(rel.startsWith('/') ? rel : `${repoRoot}/${rel}`)
}

// ── Which worktree/branch really holds a step's file ───────────────────────────
// The session's own branch is often not where the work is: a task built in another git worktree leaves its files on
// that worktree's branch, and a link to the session's branch is a GitHub 404. So each step's file is looked up once,
// when the reply is read: an absolute path names its worktree outright; a relative one is looked for in the session's
// worktree first, then in every other worktree of the same repository (newest commit touching it wins).

export type Worktree = { root: string; branch: string }

/** `git worktree list --porcelain` → worktrees with a branch (detached and bare ones are skipped). */
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = []
  for (const block of porcelain.replace(/\r/g, '').split(/\n\n+/)) {
    const root = /^worktree (.+)$/m.exec(block)?.[1]
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    if (root && branch) out.push({ root: slashes(root), branch })
  }
  return out
}

/** Forward slashes, no trailing slash, no leading `./`. */
export const slashes = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

const isAbsolute = (p: string) => /^([A-Za-z]:)?\//.test(p)
const sameStart = (path: string, root: string) => path.toLowerCase().startsWith(root.toLowerCase() + '/')

/** The worktree an absolute path is inside (the deepest, as worktrees may nest) and the path relative to it. */
export function worktreeOf(abs: string, worktrees: Worktree[]): { worktree: Worktree; rel: string } | undefined {
  const hit = worktrees.filter(w => sameStart(abs, w.root)).sort((a, b) => b.root.length - a.root.length)[0]
  return hit ? { worktree: hit, rel: abs.slice(hit.root.length + 1) } : undefined
}

async function locateFile($: EngineInterface, r: Repo | null, path: string): Promise<FileLink | undefined> {
  const git = (cwd: string, args: string[]) =>
    $.process.run(['git', ...args], { cwd, timeoutMs: 10000 }).then(
      x => ({ ok: x.exitCode === 0, out: x.stdout.trim() }),
      () => ({ ok: false, out: '' }),
    )
  const own = slashes(repoRoot)
  const worktrees = parseWorktrees((await git(own, ['worktree', 'list', '--porcelain'])).out)
  if (worktrees.length === 0) return undefined
  const p = slashes(path)

  let found: { worktree: Worktree; rel: string } | undefined
  if (isAbsolute(p)) {
    found = worktreeOf(p, worktrees)
  } else {
    const rel = relative(p)
    const has = async (w: Worktree) => (await git(w.root, ['cat-file', '-e', `HEAD:${rel}`])).ok
    const mine = worktrees.find(w => w.root.toLowerCase() === own.toLowerCase())
    if (mine && (await has(mine))) found = { worktree: mine, rel }
    else {
      // All worktrees at once (a repository can have dozens); the newest commit touching the file wins.
      const hits = await Promise.all(
        worktrees.filter(w => w !== mine).map(async w => {
          if (!(await has(w))) return undefined
          const when = Number((await git(w.root, ['log', '-1', '--format=%ct', 'HEAD', '--', rel])).out) || 0
          return { w, when }
        }),
      )
      const best = hits.filter(h => h !== undefined).sort((a, b) => b.when - a.when)[0]
      if (best) found = { worktree: best.w, rel }
    }
  }
  if (!found) return undefined

  const { worktree, rel } = found
  const abs = `${worktree.root}/${rel}`
  const elsewhere = worktree.root.toLowerCase() !== own.toLowerCase()
  // GitHub only shows what was pushed: the branch's remote-tracking ref must exist and hold the file.
  const pushed = r !== null && (await git(worktree.root, ['cat-file', '-e', `refs/remotes/origin/${worktree.branch}:${rel}`])).ok
  return {
    href: pushed && r ? blobHref(r, worktree.branch, rel) : localHref(abs),
    label: rel,
    branch: elsewhere || !pushed ? worktree.branch + (pushed ? '' : ', not on GitHub yet') : undefined,
    copy: elsewhere ? abs : rel,
  }
}

async function withFiles($: EngineInterface, found: Step[]): Promise<Step[]> {
  const r = await read($, repo)
  return Promise.all(
    found.map(async step => {
      if (!step.path) return step
      const file = await locateFile($, r, step.path).catch(() => undefined)
      return file ? { ...step, file } : step
    }),
  )
}

function prHref(r: Repo | null, step: Step): string | undefined {
  if (step.url) return step.url
  if (r && step.kind === 'pr' && /\b(open|create|raise|make)\b/i.test(step.title)) {
    return `https://github.com/${r.owner}/${r.name}/compare/${r.branch}?expand=1`
  }

  return undefined
}

function clockTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function summarise($: EngineInterface, answer: string) {
  await update($, status, (): StepsStatus => 'working')
  const result = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: `The assistant's reply:\n\n<reply>\n${answer}\n</reply>`,
    maxTokens: 4000,
    timeoutMs: 60000,
  })
  if (!result.isAnswered) {
    await update($, status, (): StepsStatus => 'error')
    return
  }
  const stamp = await $.clock.now()
  const found = await withFiles($, parseSteps(result.text, stamp))
  if (found.length > 0) {
    await update($, steps, () => found)
    await update($, done, () => [])
    await update($, updatedAt, () => stamp)
    void $.ui.open({ id: PANE, title: 'Next steps' })
    $.ui.toast(`${found.length} next step${found.length === 1 ? '' : 's'} ready`)
  }
  await update($, status, (): StepsStatus => 'idle')
}

async function copyText($: EngineInterface, value: string, what: string, surface?: Parameters<EngineInterface['ui']['copy']>[0]['surface']) {
  const r = await $.ui.copy({ text: value, surface })
  $.ui.toast(r.isCopied ? `Copied ${what}` : `Copy isn't available here: select the text in the box instead`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the next-steps checklist (args: refresh | clear)',
      argumentHint: '[refresh|clear]',
    })
    const found = await readRepo($)
    repoRoot = found.root
    await update($, repo, () => found.repo)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && e.answer.length >= MIN_ANSWER) {
      const answer = e.answer
      await update($, lastAnswer, () => answer)
      $.clock.after(0, () => void summarise($, answer))
    }

    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'clear') {
      await update($, steps, () => [])
      await update($, done, () => [])
      return { text: 'Next steps cleared.' }
    }
    if (arg === 'refresh') {
      const answer = await read($, lastAnswer)
      if (answer === '') return { text: 'No reply to summarise yet.' }
      $.clock.after(0, () => void summarise($, answer))
    }
    await $.ui.open({ id: PANE, title: 'Next steps' })

    return { text: arg === 'refresh' ? 'Re-reading the last reply…' : 'Next steps opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Code } = $.ui.resolve(e)
    const list = await read($, steps)
    const ticked = await read($, done)
    const state = await read($, status)
    const when = await read($, updatedAt)
    const r = await read($, repo)
    const width = Math.max(30, (e.props.bodyColumns ?? e.viewport?.columns ?? 80) - 2)
    const doneCount = list.filter(s => ticked.includes(s.id)).length
    const nextUp = list.find(s => !ticked.includes(s.id))

    const toggle = (id: string) =>
      update($, done, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            Next steps{' '}
            {list.length > 0 && (
              <Text dimColor>
                {doneCount}/{list.length} done · {clockTime(when)}
              </Text>
            )}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key="refresh"
              label="Refresh"
              onPress={async () => {
                const answer = await read($, lastAnswer)
                if (answer !== '') await summarise($, answer)
              }}
            />
          </Box>
        </Box>

        {state === 'working' && <Text color="yellow">Reading Claude's reply…</Text>}
        {state === 'error' && <Text color="red">Couldn't summarise that reply. Try /next-steps refresh.</Text>}

        {list.length === 0 && state !== 'working' && (
          <Text dimColor>No next steps yet. They appear here after Claude hands work back to you.</Text>
        )}
        {list.length > 0 && doneCount === list.length && <Text color="green">All done ✓</Text>}

        {list.map((step, i) => {
          const isDone = ticked.includes(step.id)
          const isNext = step === nextUp
          const kind = KINDS[step.kind]
          const href = prHref(r, step)

          return (
            <Box key={step.id} flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1}>
                <Button key={`tick-${step.id}`} plain onPress={() => toggle(step.id)}>
                  {isDone ? '[✓]' : '[ ]'}
                </Button>
                <Text bold={isNext} dimColor={isDone} strikethrough={isDone}>
                  {i + 1}. <Text color={isDone ? undefined : kind.color} bold>{kind.label}</Text> {step.title}
                  {isNext && <Text color="cyan"> ← next</Text>}
                </Text>
              </Box>

              {!isDone && (
                <Box flexDirection="column" paddingLeft={4}>
                  {step.detail && <Text dimColor>{step.detail}</Text>}

                  {href && (
                    <Text>
                      ↗ <Link href={href} label={href.replace(/^https?:\/\//, '')} />
                    </Text>
                  )}

                  {step.path && (
                    <Box flexDirection="row" gap={1}>
                      <Text>
                        📄 <Link href={step.file?.href ?? fileHref(r, step.path)} label={step.file?.label ?? relative(step.path)} />
                        {step.file?.branch && <Text dimColor> ({step.file.branch})</Text>}
                      </Text>
                      <Button
                        key={`path-${step.id}`}
                        label="Copy path"
                        onPress={press => copyText($, step.file?.copy ?? relative(step.path ?? ''), 'path', press.surface)}
                      />
                    </Box>
                  )}

                  {step.copy && (
                    <Box flexDirection="column">
                      <Box borderStyle="round" borderDimColor paddingX={1}>
                        <Code
                          source={step.copy}
                          language={step.language ?? (step.kind === 'sql' ? 'sql' : step.kind === 'command' ? 'bash' : undefined)}
                        />
                      </Box>
                      <Box flexDirection="row">
                        <Button
                          key={`copy-${step.id}`}
                          label={step.kind === 'sql' ? 'Copy SQL' : step.kind === 'command' ? 'Copy command' : 'Copy'}
                          variant="primary"
                          onPress={press =>
                            copyText($, step.copy ?? '', step.kind === 'sql' ? 'SQL' : 'text', press.surface)
                          }
                        />
                      </Box>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
