import type { ElementTable, RenderElement } from 'claude-code'

import type { Step, StepsStatus } from '../../types'
import { extras, lead, type Summary } from '../lib/select'

/**
 * The compact taskbar: one row above the prompt.
 *
 *   ● Next steps · 3 pending · Run the invoices migration            d: Done   o: Open
 *
 * It says how many things wait on you and which one is next, and nothing else; the detail is one press away. It
 * gives way to narrower terminals by dropping words from the left and buttons from the right, never by wrapping.
 */

export type BandModel = {
  summary: Summary
  status: StepsStatus
  /** Cells the row may use (the band's `bodyColumns`). */
  width: number
}

export type BandActions = {
  open: () => void
  done: (step: Step) => void
  ask: (step: Step) => void
  retry: () => void
}

export type Tier = 'wide' | 'mid' | 'narrow' | 'tiny'

export const tierOf = (width: number): Tier => (width >= 90 ? 'wide' : width >= 60 ? 'mid' : width >= 36 ? 'narrow' : 'tiny')

/** Whether there is anything to say. A suggestion alone is not worth a permanent row. */
export const hasBand = (m: Pick<BandModel, 'summary' | 'status'>): boolean => m.summary.next !== undefined || m.status === 'error'

export function taskbar(E: ElementTable, m: BandModel, a: BandActions): RenderElement {
  const { Box, Text, Button } = E
  const s = m.summary
  const step = s.next
  const tier = tierOf(m.width)
  const isError = m.status === 'error'
  const color = isError ? 'error' : s.attention === 'you' ? 'warning' : s.attention === 'claude' ? 'suggestion' : 'inactive'

  const count = tier === 'tiny' ? String(s.pending > 0 ? s.pending : s.claude.length) : lead(s)
  const head = tier === 'wide' || tier === 'mid' ? `Next steps · ${count}` : count
  const more = tier === 'wide' ? extras(s) : ''
  const note = m.status === 'working' && tier !== 'tiny' && tier !== 'narrow' ? ' · reading reply…' : ''

  const isYours = step !== undefined && step.group !== 'claude'

  return (
    <Box flexDirection="row" width={m.width} gap={2}>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={color}>●</Text>
          <Text bold> {head}</Text>
          {more !== '' && <Text dimColor> ({more})</Text>}
          {isError && step === undefined ? (
            <Text color="error"> · couldn't read Claude's last reply</Text>
          ) : (
            step && <Text> · {step.title}</Text>
          )}
          {note !== '' && <Text dimColor>{note}</Text>}
        </Text>
      </Box>
      <Box flexShrink={0} flexDirection="row" gap={2}>
        {isError && (
          <Button key="retry" plain hotkey="r" onPress={() => a.retry()}>
            Retry
          </Button>
        )}
        {step && tier !== 'tiny' && tier !== 'narrow' && isYours && (
          <Button key="done" plain hotkey="d" label={`Mark done: ${step.title}`} onPress={() => a.done(step)}>
            Done
          </Button>
        )}
        {step && tier !== 'tiny' && tier !== 'narrow' && !isYours && (
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
