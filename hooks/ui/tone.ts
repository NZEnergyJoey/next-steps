import type { ThemeKey } from 'claude-code'

import type { Step, View } from '../../types'
import { isStale } from '../lib/select'

/**
 * The status vocabulary: every step is in exactly one state, and each state has a colour, a glyph and a word, so
 * it never rests on colour alone (as Linear's status icons and the badge guidance of most design systems do).
 *
 *   ◐ Now      blue     the step in the spotlight
 *   ○ Next     purple   yours, after the one in front
 *   ◇ Decide   amber    Claude is waiting on your choice
 *   ✦ Claude   orange   Claude can do it when asked
 *   ◷ Waiting  grey     another step must be finished first
 *   ◌ Optional teal     a suggestion, not needed to finish
 *   ◌ Earlier  grey     the last few replies stopped mentioning it
 *   ✓ Done     green
 *   – Skipped  grey
 *
 * Text colours are theme keys, so they follow the person's light or dark theme; the tints behind a pill or a tab
 * are the same hues at low alpha, which read on either.
 */

export type Tone = 'now' | 'next' | 'decide' | 'claude' | 'waiting' | 'optional' | 'earlier' | 'done' | 'skipped'

export type ToneStyle = {
  label: string
  glyph: string
  color: ThemeKey
  /** The soft fill behind a pill, a selected tab or the spotlight card. */
  tint: string
  /** The card's edge. */
  edge: string
  /** A fainter fill, for a whole card. */
  wash: string
}

const style = (label: string, glyph: string, color: ThemeKey, rgb: string): ToneStyle => ({
  label,
  glyph,
  color,
  tint: `rgba(${rgb},0.14)`,
  edge: `rgba(${rgb},0.55)`,
  wash: `rgba(${rgb},0.07)`,
})

export const TONES: Record<Tone, ToneStyle> = {
  now: style('Now', '◐', 'suggestion', '59,130,246'),
  next: style('Next', '○', 'merged', '139,92,246'),
  decide: style('Decide', '◇', 'warning', '245,158,11'),
  claude: style('Claude', '✦', 'claude', '217,119,87'),
  waiting: style('Waiting', '◷', 'inactive', '128,128,128'),
  optional: style('Optional', '◌', 'planMode', '20,184,166'),
  earlier: style('Earlier', '◌', 'inactive', '128,128,128'),
  done: style('Done', '✓', 'success', '34,197,94'),
  skipped: style('Skipped', '–', 'inactive', '128,128,128'),
}

/**
 * The state a step is in, as the panel shows it. `isNow` marks the step in the spotlight; `isWaiting`, a step whose
 * prerequisite is still open (see `waitingOn`).
 */
export function toneOf(s: Step, isNow = false, isWaiting = false): Tone {
  if (s.status === 'done') return 'done'
  if (s.status === 'skipped') return 'skipped'
  if (isStale(s)) return 'earlier'
  if (s.group === 'optional') return 'optional'
  if (isWaiting) return 'waiting'
  if (s.group === 'claude') return 'claude'
  if (isNow) return 'now'

  return s.group === 'decision' ? 'decide' : 'next'
}

/** The panel's tabs, in order, and the tone each is drawn in. */
export const TABS: Array<{ view: View; label: string; hotkey: string; tone: Tone }> = [
  { view: 'todo', label: 'To do', hotkey: 't', tone: 'now' },
  { view: 'optional', label: 'Optional', hotkey: 'o', tone: 'optional' },
  { view: 'earlier', label: 'Earlier', hotkey: 'e', tone: 'earlier' },
  { view: 'done', label: 'Done', hotkey: 'h', tone: 'done' },
]
