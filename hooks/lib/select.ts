import type { Step } from '../../types'

import { STALE_AFTER } from './merge'
import { plural } from './text'

/** Reading the list: what needs the reader, what comes next, what to say about it. Pure. */

export const isStale = (s: Step) => s.status === 'open' && s.missed >= STALE_AFTER

/** The open step this one waits for, if any: "merge only after the migration is verified". */
export const waitingOn = (s: Step, steps: Step[]): Step | undefined =>
  s.after === undefined ? undefined : steps.find(o => o.id === s.after && o.status === 'open' && o.id !== s.id)

/** Steps that can be done now first, then those waiting on another, each in the order given. */
const readyFirst = (list: Step[], steps: Step[]) => [...list.filter(s => !waitingOn(s, steps)), ...list.filter(s => waitingOn(s, steps))]

export type Summary = {
  /** Open steps for the reader: their own actions and the decisions waiting on them, in the order to do them. */
  todo: Step[]
  /** Open steps Claude can do. */
  claude: Step[]
  /** Open suggestions that are not needed. */
  optional: Step[]
  /** Open steps that the last few replies stopped mentioning. */
  earlier: Step[]
  /** Done and skipped steps, newest first. */
  closed: Step[]
  /** The step to do next: the first thing for the reader, else the first thing Claude can do. */
  next: Step | undefined
  /** How many things are waiting on the reader. */
  pending: number
  /** Who the next move is with: drives the colour of the indicator. */
  attention: 'you' | 'claude' | 'optional' | 'clear'
}

export function summarise(steps: Step[]): Summary {
  const live = steps.filter(s => s.status === 'open' && !isStale(s))
  // A step waiting on another never leads: the spotlight is always something that can be done now.
  const todo = readyFirst(live.filter(s => s.group === 'you' || s.group === 'decision'), steps)
  const claude = readyFirst(live.filter(s => s.group === 'claude'), steps)
  const optional = live.filter(s => s.group === 'optional')
  const next = todo[0] ?? claude[0]

  return {
    todo,
    claude,
    optional,
    earlier: steps.filter(isStale),
    closed: steps.filter(s => s.status !== 'open').sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)),
    next,
    pending: todo.length,
    attention: todo.length > 0 ? 'you' : claude.length > 0 ? 'claude' : optional.length > 0 ? 'optional' : 'clear',
  }
}

/** The open steps in the order the panel and `/next-steps list` show them, which is also how they are numbered. */
export const ordered = (s: Summary): Step[] => [...s.todo, ...s.claude, ...s.optional]

/** The step the panel has open: the reader's pick if it is still there, else the next step. */
export function effectiveSelection(selected: string | null, s: Summary, visible: Step[]): string | undefined {
  if (selected === '') return undefined
  if (selected !== null && visible.some(v => v.id === selected)) return selected

  return s.next?.id
}

/** Who a step is for, in a word. */
export function ownerOf(step: Step): 'you' | 'Claude' {
  return step.group === 'claude' ? 'Claude' : 'you'
}

/** The small label beside a step: nothing for the common case (your own action). */
export function tagOf(step: Step): string {
  if (step.status === 'skipped') return 'skipped'
  switch (step.group) {
    case 'decision':
      return 'decision'
    case 'claude':
      return 'Claude'
    case 'optional':
      return 'optional'
    default:
      return ''
  }
}

/** The first part of the one-line summary: what is waiting, in the reader's terms. */
export function lead(s: Summary): string {
  if (s.pending > 0) return `${s.pending} pending`
  if (s.claude.length > 0) return `${s.claude.length} for Claude`
  if (s.optional.length > 0) return `${plural(s.optional.length, 'suggestion')}`

  return 'all clear'
}

/** The extra counts shown when there is room: what else is on the list besides what leads. */
export function extras(s: Summary): string {
  const parts: string[] = []
  if (s.pending > 0 && s.claude.length > 0) parts.push(`${s.claude.length} for Claude`)
  if (s.pending + s.claude.length > 0 && s.optional.length > 0) parts.push(`${s.optional.length} optional`)

  return parts.join(' · ')
}

/**
 * The one-line status for surfaces with no band: `Next steps · 3 pending · Run database migration`.
 * Suggestions alone say nothing: they are never worth a permanent line.
 */
export function statusText(s: Summary): string | undefined {
  return s.next === undefined ? undefined : `Next steps · ${lead(s)} · ${s.next.title}`
}
