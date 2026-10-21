import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { Flash, Step, StepsStatus } from '../../types'
import type { Progress } from '../lib/progress'
import { extras, lead, type Summary } from '../lib/select'
import { ringSvg } from './svg'
import { TONES, toneOf } from './tone'

/**
 * The bar: one quiet row above the prompt that always answers "what now?".
 *
 *   ◔  Now  Run migration 134 on NZE/PAW   3 pending · 1 for Claude   +2 new        ✓ Done   Open
 *
 * The ring fills as the round is worked through (and circles while Claude's reply is read); the step in the
 * spotlight leads, in bold. When a step is finished the bar says so for a moment ("✓ Done · …") and then the next
 * step takes its place, so the highlight visibly moves on. New steps never pop up a toast: a small "+2 new" waits
 * on the bar until the panel has been opened. The step wears the same coloured state as in the panel (Now, Decide,
 * Claude). It narrows by dropping words, never by wrapping, and fills the row it is given rather than a cell count.
 */

export type BandModel = {
  summary: Summary
  progress: Progress
  status: StepsStatus
  /** The step just closed, while its moment lasts. */
  flash: Flash | null
  /** Steps for the reader that arrived since the panel was last open. */
  newCount: number
  /** Cells the row may use (the band's `bodyColumns`). */
  width: number
  /** The surface drawing it: every surface but the terminal draws the ring. */
  surface: RenderSurface
}

export type BandActions = {
  open: () => void
  done: (step: Step) => void
  ask: (step: Step) => void
  retry: () => void
}

export type Tier = 'wide' | 'mid' | 'narrow' | 'tiny'

export const tierOf = (width: number): Tier => (width >= 90 ? 'wide' : width >= 60 ? 'mid' : width >= 36 ? 'narrow' : 'tiny')

/** Whether there is anything to say. A suggestion alone is not worth a permanent row; a step just finished is. */
export const hasBand = (m: Pick<BandModel, 'summary' | 'status' | 'flash'>): boolean =>
  m.summary.next !== undefined || m.status === 'error' || m.flash !== null

/** The ring as one character, for the terminal: how full the round is. */
export function ringGlyph(p: Pick<Progress, 'ratio' | 'total' | 'position'>): string {
  if (p.total > 0 && p.position === 0) return '✓'
  const r = p.ratio

  return r <= 0 ? '○' : r < 0.375 ? '◔' : r < 0.625 ? '◑' : r < 0.875 ? '◕' : '●'
}

export function taskbar(E: ElementTable, m: BandModel, a: BandActions): RenderElement {
  const { Box, Text, Button } = E
  const Svg = m.surface !== 'terminal' ? (E as ElementTable<'desktop'>).Svg : undefined
  const s = m.summary
  const step = s.next
  const tier = tierOf(m.width)
  const isError = m.status === 'error'
  const isWorking = m.status === 'working'
  const isYours = step !== undefined && step.group !== 'claude'
  const roomy = tier === 'wide' || tier === 'mid'

  const count = tier === 'tiny' ? String(s.pending > 0 ? s.pending : s.claude.length) : lead(s)
  const more = tier === 'wide' ? extras(s) : ''
  const glyphColour = isError ? 'error' : m.flash ? 'success' : s.attention === 'you' ? 'suggestion' : s.attention === 'claude' ? 'claude' : 'inactive'
  const tone = step === undefined ? undefined : TONES[step.group === 'decision' ? 'decide' : toneOf(step, true)]

  return (
    <Box flexDirection="row" width={Svg ? '100%' : m.width} gap={2} alignItems="center">
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} gap={1} alignItems="center">
        {Svg ? (
          <Svg
            source={ringSvg(m.progress, isWorking)}
            alt={m.progress.total > 0 ? `${m.progress.done} of ${m.progress.total} steps finished` : 'Next steps'}
            isInteractive
            width={18}
            height={18}
          />
        ) : (
          <Text color={glyphColour}>{ringGlyph(m.progress)}</Text>
        )}
        <Text wrap="truncate-end">
          {m.flash ? (
            <Text color="success" weight="semibold">
              ✓ {m.flash.by === 'reply' ? 'Claude finished' : 'Done'} · {m.flash.title}
            </Text>
          ) : isError && step === undefined ? (
            <Text>
              <Text dimColor>Next steps · </Text>
              <Text color="error">couldn't read Claude's last reply</Text>
            </Text>
          ) : (
            step && (
              <Text>
                {tone && roomy && (
                  <Text size="caption" weight="semibold" color={tone.color} backgroundColor={Svg ? tone.tint : undefined}>
                    {Svg ? ` ${tone.label} ` : tone.label}
                  </Text>
                )}
                {tone && roomy && ' '}
                <Text weight="semibold" color="text">
                  {step.title}
                </Text>
              </Text>
            )
          )}
          {!m.flash && step && roomy && (
            <Text dimColor>
              {'   '}
              Next steps · {count}
              {more !== '' ? ` · ${more}` : ''}
            </Text>
          )}
          {!m.flash && step && !roomy && <Text dimColor> · {count}</Text>}
          {isWorking && tier !== 'tiny' && <Text color="suggestion"> · syncing…</Text>}
        </Text>
        {m.newCount > 0 && tier !== 'tiny' && (
          <Box flexShrink={0}>
            <Text color="suggestion" weight="semibold" size="caption" backgroundColor={Svg ? TONES.now.tint : undefined} wrap="truncate-end">
              {Svg ? ` +${m.newCount} new ` : `+${m.newCount} new`}
            </Text>
          </Box>
        )}
      </Box>
      <Box flexShrink={0} flexDirection="row" gap={2} alignItems="center">
        {isError && (
          <Button key="retry" plain hotkey="r" onPress={() => a.retry()}>
            Retry
          </Button>
        )}
        {step && roomy && isYours && !m.flash && (
          <Button key="done" plain hotkey="d" label={`Mark done: ${step.title}`} onPress={() => a.done(step)}>
            ✓ Done
          </Button>
        )}
        {step && roomy && !isYours && !m.flash && (
          <Button key="ask" plain hotkey="a" label={`Ask Claude: ${step.title}`} onPress={() => a.ask(step)}>
            Ask Claude
          </Button>
        )}
        <Button key="open" plain hotkey="o" label="Open the next steps panel" onPress={() => a.open()}>
          Open
        </Button>
      </Box>
    </Box>
  )
}
