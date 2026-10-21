import type { EngineInterface } from 'claude-code'

import type { FileLink, Repo, Step } from '../../types'

import type { Incoming } from './extract'
import { slashes } from './text'

/**
 * Git: which repository and branch the session is on, and which worktree really holds a file a step names.
 * The logic is the same as before the redesign; it is split out so it can be tested with a stand-in for git.
 */

export { slashes }

/** Runs `git` with these arguments; `ok` is false when it fails, and `out` is its trimmed output. */
export type GitRun = (cwd: string | undefined, args: string[]) => Promise<{ ok: boolean; out: string }>

// A function declaration, not a constant: the engine follows `$` into an imported function only when it is declared.
export function gitRunner($: EngineInterface): GitRun {
  return (cwd, args) =>
    $.process.run(['git', ...args], { cwd, timeoutMs: 10000 }).then(
      r => ({ ok: r.exitCode === 0, out: r.stdout.trim() }),
      () => ({ ok: false, out: '' }),
    )
}

export function parseRemote(remote: string): { owner: string; name: string } | undefined {
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim())

  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : undefined
}

export async function readRepo(run: GitRun, cwd: () => Promise<string>): Promise<{ repo: Repo | null; root: string }> {
  const [remote, branch, root] = await Promise.all([
    run(undefined, ['remote', 'get-url', 'origin']),
    run(undefined, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(undefined, ['rev-parse', '--show-toplevel']),
  ])
  const gh = remote.ok ? parseRemote(remote.out) : undefined
  const name = branch.ok ? branch.out : ''

  return {
    repo: gh && name !== '' ? { ...gh, branch: name } : null,
    root: (root.ok && root.out) || (await cwd()),
  }
}

/** `path` relative to the repository root, when it is inside it. */
export function relativeTo(root: string, path: string): string {
  const p = slashes(path)
  const r = slashes(root)

  return r !== '' && p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p
}

export const blobHref = (r: Pick<Repo, 'owner' | 'name'>, branch: string, rel: string) =>
  `https://github.com/${r.owner}/${r.name}/blob/${branch.split('/').map(encodeURIComponent).join('/')}/${rel.split('/').map(encodeURIComponent).join('/')}`

/** file:// URL for a local path: `C:\a b\x` becomes `file:///C:/a%20b/x`, `/x` becomes `file:///x`. */
export function localHref(abs: string): string {
  const joined = slashes(abs)
    .split('/')
    .map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)))
    .join('/')

  return `file://${joined.startsWith('/') ? '' : '/'}${joined}`
}

/** Where to link a step's file when git could not say which worktree has it. */
export function fileHref(root: string, r: Repo | null, path: string): string {
  const rel = relativeTo(root, path)
  if (r) return blobHref(r, r.branch, rel)

  return localHref(rel.startsWith('/') || /^[A-Za-z]:\//.test(rel) ? rel : `${slashes(root)}/${rel}`)
}

// ── Which worktree/branch really holds a step's file ────────────────────────────
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

const isAbsolute = (p: string) => /^([A-Za-z]:)?\//.test(p)
const sameStart = (path: string, root: string) => path.toLowerCase().startsWith(`${root.toLowerCase()}/`)

/** The worktree an absolute path is inside (the deepest, as worktrees may nest) and the path relative to it. */
export function worktreeOf(abs: string, worktrees: Worktree[]): { worktree: Worktree; rel: string } | undefined {
  const hit = worktrees.filter(w => sameStart(abs, w.root)).sort((a, b) => b.root.length - a.root.length)[0]

  return hit ? { worktree: hit, rel: abs.slice(hit.root.length + 1) } : undefined
}

export async function locateFile(run: GitRun, root: string, r: Repo | null, path: string): Promise<FileLink | undefined> {
  const own = slashes(root)
  const worktrees = parseWorktrees((await run(own, ['worktree', 'list', '--porcelain'])).out)
  if (worktrees.length === 0) return undefined
  const p = slashes(path)

  let found: { worktree: Worktree; rel: string } | undefined
  if (isAbsolute(p)) {
    found = worktreeOf(p, worktrees)
  } else {
    const rel = relativeTo(root, p)
    const has = async (w: Worktree) => (await run(w.root, ['cat-file', '-e', `HEAD:${rel}`])).ok
    const mine = worktrees.find(w => w.root.toLowerCase() === own.toLowerCase())
    if (mine && (await has(mine))) found = { worktree: mine, rel }
    else {
      // All worktrees at once (a repository can have dozens); the newest commit touching the file wins.
      const hits = await Promise.all(
        worktrees
          .filter(w => w !== mine)
          .map(async w => {
            if (!(await has(w))) return undefined
            const when = Number((await run(w.root, ['log', '-1', '--format=%ct', 'HEAD', '--', rel])).out) || 0

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
  const pushed = r !== null && (await run(worktree.root, ['cat-file', '-e', `refs/remotes/origin/${worktree.branch}:${rel}`])).ok

  return {
    href: pushed && r ? blobHref(r, worktree.branch, rel) : localHref(abs),
    label: rel,
    branch: elsewhere || !pushed ? worktree.branch + (pushed ? '' : ', not on GitHub yet') : undefined,
    copy: elsewhere ? abs : rel,
  }
}

/** Gives each step that names a file its resolved link. A lookup that fails leaves the step as it was. */
export async function withFiles(run: GitRun, root: string, r: Repo | null, found: Incoming[]): Promise<Incoming[]> {
  return Promise.all(
    found.map(async step => {
      if (!step.path) return step
      const file = await locateFile(run, root, r, step.path).catch(() => undefined)

      return file ? { ...step, file } : step
    }),
  )
}

/** The link a step leads with: its own URL, else a ready-made compare page for "open a PR" steps. */
export function prHref(r: Repo | null, step: Pick<Step, 'kind' | 'title' | 'url'>): string | undefined {
  if (step.url) return step.url
  // "Merge PR #76", "Review PR #165": the pull request itself, wherever the step names one by number.
  const pr = /\b(?:PR|pull request)\s*#(\d+)\b/i.exec(step.title)
  if (r && pr) return `https://github.com/${r.owner}/${r.name}/pull/${pr[1]}`
  if (r && step.kind === 'pr' && /\b(open|create|raise|make)\b/i.test(step.title)) {
    return `https://github.com/${r.owner}/${r.name}/compare/${r.branch}?expand=1`
  }

  return undefined
}
