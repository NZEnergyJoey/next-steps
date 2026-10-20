import type { EngineInterface } from 'claude-code'

import type { Saved, Step } from '../../types'

import { reviveSteps } from './extract'
import { slashes } from './text'

/**
 * Keeping the list between sessions, per worktree.
 *
 * `$.store` is one JSON file for this plugin (4 MiB at most). Each worktree gets its own record under
 * `scope:<its root path>`, so two repositories, or two worktrees of one repository, never share a list. Records
 * not touched for a quarter of a year, and all but the thirty most recent, are dropped at the start of a session.
 * Everything read back is checked again (reviveSteps): the file is not trusted to be what this mod wrote.
 */

export const SCOPE_PREFIX = 'scope:'
export const MAX_SCOPES = 30
export const KEEP_MS = 90 * 24 * 3600_000
export const DAY_MS = 24 * 3600_000

export const scopeKey = (root: string) => `${SCOPE_PREFIX}${slashes(root).toLowerCase()}`

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** A saved record as the store holds it, or undefined when it is missing, from another version, or not ours. */
export function revive(raw: unknown, root: string): Saved | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (r.v !== 1) return undefined

  return { v: 1, root: slashes(root), steps: reviveSteps(r.steps), updatedAt: num(r.updatedAt), touched: num(r.touched) }
}

/** What goes in the store: closed steps keep their words but not their pasteable text, which can be large. */
export const slim = (steps: Step[]): Step[] =>
  steps.map(s => (s.status === 'open' ? s : { ...s, copy: undefined, language: undefined }))

export async function load($: EngineInterface, root: string): Promise<Saved | undefined> {
  try {
    return revive(await $.store.get(scopeKey(root)), root)
  } catch {
    return undefined
  }
}

let chain: Promise<unknown> = Promise.resolve()

/** Writes one worktree's list. Writes go one after another so a slow one cannot land after a newer one. */
export function save($: EngineInterface, root: string, steps: Step[], updatedAt: number, now: number): Promise<boolean> {
  const record: Saved = { v: 1, root: slashes(root), steps: slim(steps), updatedAt, touched: now }
  const done = chain.then(() => $.store.set(scopeKey(root), record).then(() => true))
  chain = done.catch(() => false)

  // A store that is full or unwritable must not break the mod: the list simply is not kept this time.
  return done.catch(() => false)
}

export async function prune($: EngineInterface, now: number): Promise<void> {
  try {
    const keys = (await $.store.keys()).filter(k => k.startsWith(SCOPE_PREFIX))
    const rows = await Promise.all(
      keys.map(async key => {
        const raw = await $.store.get(key)
        const touched = typeof raw === 'object' && raw !== null ? num((raw as Record<string, unknown>).touched) : 0

        return { key, touched }
      }),
    )
    const old = rows.filter(r => now - r.touched > KEEP_MS)
    const extra = rows
      .filter(r => !old.includes(r))
      .sort((a, b) => b.touched - a.touched)
      .slice(MAX_SCOPES)
    for (const r of [...old, ...extra]) await $.store.delete(r.key)
  } catch {
    /* housekeeping only */
  }
}
