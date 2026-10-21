import type { Flash, Step } from '../../types'

import { isStale, type Summary } from './select'

/**
 * Progress through "this round" of the reader's steps, and the small facts the redesign draws from: the ring on the
 * bar, the segmented rail in the panel, "Step 2 of 5", the "+2 new" marker and the moment a finished step lingers.
 * Pure, so the bar, the panel and the tests always agree.
 */

/** How long a just-finished step stays on screen ("✓ Done · …") before the highlight has fully moved on. */
export const FLASH_MS = 2600
/** With nothing left open, steps closed this recently still make up the round, so the rail reads "all done". */
export const DONE_WINDOW_MS = 30 * 60_000

/** One segment of the rail, in the order drawn: finished first (oldest first), then what is still to do. */
export type Segment = { id: string; state: 'done' | 'skipped' | 'current' | 'todo' }

export type Progress = {
  /** The round's segments. Empty when there is nothing to show. */
  segments: Segment[]
  /** Finished (done or skipped) steps of the round. */
  done: number
  total: number
  /** 1-based position of the current step within the round; 0 when none is open. */
  position: number
  /** 0 to 1. */
  ratio: number
}

const isMine = (s: Step) => s.group === 'you' || s.group === 'decision'

/**
 * The round: the reader's open steps, plus the ones they finished since the oldest of those first appeared. With
 * nothing open, the ones finished in the last half hour, so the reader sees the round they just completed.
 */
export function progressOf(steps: Step[], summary: Summary, now: number): Progress {
  const open = summary.todo
  const start = open.length > 0 ? Math.min(...open.map(s => s.firstSeen)) : now - DONE_WINDOW_MS
  const finished = steps
    .filter(s => isMine(s) && s.status !== 'open' && (s.closedAt ?? 0) >= start)
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
  const current = open[0]
  const segments: Segment[] = [
    ...finished.map(s => ({ id: s.id, state: s.status === 'skipped' ? ('skipped' as const) : ('done' as const) })),
    ...open.map(s => ({ id: s.id, state: s === current ? ('current' as const) : ('todo' as const) })),
  ]
  const total = segments.length

  return {
    segments,
    done: finished.length,
    total,
    position: current ? finished.length + 1 : 0,
    ratio: total === 0 ? 0 : finished.length / total,
  }
}

/** Open steps for the reader that arrived after they last had the panel open. */
export function newSince(summary: Summary, seenAt: number): number {
  return summary.todo.filter(s => s.firstSeen > seenAt && !isStale(s)).length
}

/** The flash, while its moment lasts; otherwise nothing. */
export function liveFlash(flash: Flash | null, now: number): Flash | null {
  return flash && now - flash.at >= 0 && now - flash.at < FLASH_MS ? flash : null
}

/** A short name for the kind of step, for its chip. */
export function kindLabel(step: Pick<Step, 'kind' | 'group'>): string {
  if (step.group === 'decision') return 'Decision'
  switch (step.kind) {
    case 'sql':
      return 'SQL'
    case 'command':
      return 'Run'
    case 'pr':
      return 'PR'
    case 'file':
      return 'File'
    case 'deploy':
      return 'Deploy'
    case 'review':
      return 'Review'
    case 'check':
      return 'Check'
    default:
      return 'Action'
  }
}

/** The rail as text, for the terminal: ▰ finished, ▣ current, ▱ to do. */
export function railText(p: Progress): string {
  return p.segments.map(s => (s.state === 'current' ? '▣' : s.state === 'todo' ? '▱' : '▰')).join('')
}
