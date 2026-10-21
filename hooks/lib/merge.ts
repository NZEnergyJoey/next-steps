import type { Step } from '../../types'

import type { Incoming } from './extract'
import { contains, similarity } from './text'

/**
 * Folding a new reply's steps into the list already there. Pure.
 *
 * The old behaviour replaced the whole list (and every tick) with each long reply. Now a step that comes round again
 * is the same step, a step the reply drops is kept (and ages out if it keeps being dropped), and only steps the reply
 * itself says are done are closed for you.
 */

/** An open step that this many consecutive replies ignored is "earlier": still listed, no longer counted. */
export const STALE_AFTER = 3
/** The most open steps kept; the least useful go first. */
export const MAX_OPEN = 30
/** The most closed (done or skipped) steps kept as history. */
export const MAX_CLOSED = 15
/**
 * A step you closed and a reply then lists again within this long is taken to be the old step (Claude had not heard
 * you did it). Later than that it is a new occurrence, such as running the tests again.
 */
export const REOPEN_AFTER_MS = 30 * 60_000
/** Titles at least this alike, for the same kind of step, are the same step when their keys differ. */
export const SAME_TITLE = 0.7

export type MergeResult = {
  steps: Step[]
  /** Steps that were not on the list before. */
  added: Step[]
  /** Steps closed because the reply said they were done. */
  resolved: Step[]
}

const isOpen = (s: Step) => s.status === 'open'

/** A closed step the reply may be talking about: closed by a reply, or by you not long ago. */
const isRecent = (s: Step, stamp: number) =>
  s.status !== 'open' && (s.closedBy === 'reply' || stamp - (s.closedAt ?? 0) < REOPEN_AFTER_MS)

function findMatch(list: Step[], inc: Incoming, taken: Set<string>, stamp: number): Step | undefined {
  const free = list.filter(s => !taken.has(s.id))
  const pools = [free.filter(isOpen), free.filter(s => isRecent(s, stamp))]
  for (const pool of pools) {
    const exact = pool.find(s => s.key === inc.key)
    if (exact) return exact
  }
  for (const pool of pools) {
    const alike = pool
      .filter(s => s.kind === inc.kind && (similarity(s.title, inc.title) >= SAME_TITLE || contains(s.title, inc.title)))
      .sort((a, b) => similarity(b.title, inc.title) - similarity(a.title, inc.title))[0]
    if (alike) return alike
  }
  // A step part-way through its places, listed again for the places left ("Run the preflight on NZE/PAW" once HKL
  // is done), is the same step, whatever kind the reply now gives it: a looser likeness, but it must name such a place.
  const title = inc.title.toLowerCase()
  const midway = free
    .filter(s => isOpen(s) && (s.doneTargets ?? []).length > 0 && targetsLeft(s).some(t => title.includes(t.toLowerCase())))
    .filter(s => similarity(s.title, inc.title) >= MIDWAY_TITLE)
    .sort((a, b) => similarity(b.title, inc.title) - similarity(a.title, inc.title))[0]

  return midway
}

/** How alike the titles of a step part-way through its places and its relisting must be (see findMatch). */
const MIDWAY_TITLE = 0.3

function nextId(list: Step[], stamp: number, i: number): string {
  let id = `${stamp}-${i}`
  for (let n = 1; list.some(s => s.id === id); n++) id = `${stamp}-${i}.${n}`

  return id
}

export function reconcile(existing: Step[], incoming: Incoming[], resolvedIds: string[], stamp: number, age = true): MergeResult {
  const list: Step[] = existing.map(s => ({ ...s }))
  const resolved: Step[] = []
  const added: Step[] = []
  const taken = new Set<string>()
  /** Steps the reply spoke of without closing them (one place done): not aged, but still free to match. */
  const heard = new Set<string>()
  /** Where each incoming step landed, so "after step 2" can name a real step once all have their places. */
  const placed: Array<Step | undefined> = []

  for (const said of resolvedIds) {
    // "id@HKL": done in that one place. The step closes only when no place is left.
    const at = said.indexOf('@')
    const id = at < 0 ? said : said.slice(0, at)
    const s = list.find(x => x.id === id && isOpen(x))
    if (!s) continue
    if (at >= 0) {
      const place = (s.targets ?? []).find(t => t.toLowerCase() === said.slice(at + 1).trim().toLowerCase())
      if (place === undefined) continue
      s.doneTargets = (s.targets ?? []).filter(t => t === place || (s.doneTargets ?? []).includes(t))
      heard.add(s.id)
      if (targetsLeft(s).length > 0) continue
    }
    s.status = 'done'
    s.closedAt = stamp
    s.closedBy = 'reply'
    taken.add(s.id)
    resolved.push(s)
  }

  incoming.forEach((inc, i) => {
    if (added.some(a => a.key === inc.key)) return // the same step twice in one reply is one step
    const hit = findMatch(list, inc, taken, stamp)
    if (hit) {
      taken.add(hit.id)
      placed[i] = hit
      hit.lastSeen = stamp
      if (hit.status !== 'open' && hit.closedBy !== 'reply') return // you closed it and have not been heard: it stays closed
      if (hit.status !== 'open') {
        hit.status = 'open'
        hit.closedAt = undefined
        hit.closedBy = undefined
      }
      hit.missed = 0
      hit.kind = inc.kind
      hit.group = inc.group
      hit.title = inc.title
      hit.why = inc.why ?? hit.why
      hit.copy = inc.copy
      hit.language = inc.language
      hit.path = inc.path
      hit.url = inc.url
      hit.file = inc.file
      hit.key = inc.key
      // The places already ticked stay ticked, as long as the reply still names them. A relisting that names no
      // places of its own is about the places left, so the step keeps its places and its ticks.
      if (inc.targets !== undefined || targetsLeft(hit).length === 0) {
        const kept = (hit.doneTargets ?? []).filter(t => inc.targets?.some(n => n.toLowerCase() === t.toLowerCase()))
        hit.targets = inc.targets
        hit.doneTargets = kept.length > 0 ? kept : undefined
      }
      hit.asksBack = inc.asksBack
      hit.options = inc.options

      return
    }
    const { after: _after, ...rest } = inc
    const step: Step = {
      ...rest,
      id: nextId(list, stamp, i),
      status: 'open',
      firstSeen: stamp,
      lastSeen: stamp,
      missed: 0,
    }
    taken.add(step.id)
    placed[i] = step
    list.push(step)
    added.push(step)
  })

  // What each step waits for, as the reply now says it: an earlier step of the same reply, never itself.
  incoming.forEach((inc, i) => {
    const s = placed[i]
    if (s === undefined || s.status !== 'open') return
    const first = inc.after === undefined ? undefined : placed[inc.after]
    s.after = first !== undefined && first.id !== s.id ? first.id : undefined
  })

  // A reply that handed over steps and left an earlier one out has moved on from it a little.
  // (Reading the same reply again, as Refresh does, is not a further reply and ages nothing.)
  if (age && incoming.length > 0) {
    for (const s of list) if (isOpen(s) && !taken.has(s.id) && !heard.has(s.id)) s.missed += 1
  }

  // A new occurrence of something closed long ago replaces its old record instead of sitting beside it.
  const fresh = new Set(added.map(s => s.key))
  const merged = list.filter(s => isOpen(s) || !fresh.has(s.key) || added.includes(s))

  return { steps: prune(merged), added, resolved }
}

/** Keeps the list to its caps: the least useful open steps go first, then the oldest closed ones. */
export function prune(list: Step[]): Step[] {
  const open = list.filter(isOpen)
  const closed = list.filter(s => !isOpen(s))
  const keep = new Set<string>()

  const usefulFirst = [...open].sort((a, b) => {
    const rank = (s: Step) => (s.group === 'optional' ? 0 : 1) + (s.missed >= STALE_AFTER ? 0 : 2)

    return rank(b) - rank(a) || a.missed - b.missed || b.lastSeen - a.lastSeen
  })
  for (const s of usefulFirst.slice(0, MAX_OPEN)) keep.add(s.id)
  for (const s of [...closed].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, MAX_CLOSED)) keep.add(s.id)

  return list.filter(s => keep.has(s.id))
}

/** The targets of a step not yet ticked, in order. */
export const targetsLeft = (s: Pick<Step, 'targets' | 'doneTargets'>): string[] =>
  (s.targets ?? []).filter(t => !(s.doneTargets ?? []).some(d => d.toLowerCase() === t.toLowerCase()))

/**
 * Ticks one target of a step (a database it must run on), or unticks it. With every target ticked the step is done;
 * unticking one of a done step opens it again.
 */
export function setTarget(list: Step[], id: string, target: string, isDone: boolean, stamp: number): Step[] {
  return list.map(s => {
    if (s.id !== id || !(s.targets ?? []).includes(target)) return s
    const others = (s.doneTargets ?? []).filter(d => d !== target)
    const doneTargets = isDone ? (s.targets ?? []).filter(t => t === target || others.includes(t)) : others
    const next: Step = { ...s, doneTargets: doneTargets.length > 0 ? doneTargets : undefined }
    if (targetsLeft(next).length === 0) return { ...next, status: 'done', closedAt: stamp, closedBy: 'you' }
    if (s.status !== 'open') return { ...next, status: 'open', missed: 0, lastSeen: stamp, closedAt: undefined, closedBy: undefined }

    return next
  })
}

/** Marks a step done, skipped, or open again; the one place a reader's tick is turned into a change. */
export function setStatus(list: Step[], id: string, status: Step['status'], stamp: number): Step[] {
  return list.map(s => {
    if (s.id !== id) return s
    if (status === 'open') return { ...s, status, missed: 0, lastSeen: stamp, closedAt: undefined, closedBy: undefined }

    return { ...s, status, closedAt: stamp, closedBy: 'you' as const }
  })
}
