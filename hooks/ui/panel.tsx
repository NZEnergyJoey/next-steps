import type { ElementTable, RenderElement, UiPressArgument } from 'claude-code'

import type { Repo, Reveal, Step, StepStatus, StepsStatus } from '../../types'
import { fileHref, prHref, relativeTo } from '../lib/git'
import { effectiveSelection, extras, isStale, lead, ownerOf, tagOf, type Summary } from '../lib/select'
import { clip, clockTime } from '../lib/text'

/**
 * The panel: the whole list, with one step open at a time.
 *
 *   Next steps  3 pending · 1 for Claude                                    r: Refresh
 *
 *   ○ 1: Run the invoices migration
 *       For you · to do
 *       Adds the table the new invoices page reads from.
 *       supabase/migrations/0042_invoices.sql (feature/invoices)   p: Copy path
 *       ╭──────────────────────────╮
 *       │ create table invoices …  │
 *       ╰──────────────────────────╯
 *       c: Copy SQL   d: Mark done   s: Skip
 *   ○ 2: Approve the schema change                                         decision
 *
 *   Claude can do
 *   ○ 3: Run the test suite                                                  Claude
 *
 *   o: Optional · 2 ▸    h: Done · 1 ▸
 *
 * Progressive disclosure: only the step in focus shows its why, links and code; optional, earlier and finished steps
 * are folded away. Colour is used for two things only: the mark of what needs you, and success.
 */

export type PanelModel = {
  summary: Summary
  status: StepsStatus
  error: string | null
  updatedAt: number
  root: string
  repo: Repo | null
  selected: string | null
  reveal: Reveal
  /** Cells the panel may use (`bodyColumns`). */
  width: number
  /** Whether the person has given the panel the keyboard: only then are the key hints shown. */
  isFocused: boolean
}

export type PanelActions = {
  select: (id: string, isSelected: boolean) => void
  setStatus: (id: string, status: StepStatus) => void
  copy: (value: string, what: string, press: UiPressArgument) => void
  handOff: (step: Step, how: 'ask' | 'approve' | 'decline') => void
  refresh: () => void
  toggle: (section: keyof Reveal) => void
}

const WHO: Record<Step['group'], string> = {
  you: 'For you',
  decision: 'Needs your decision',
  claude: 'Claude can do this',
  optional: 'Optional',
}

function statusWord(s: Step): string {
  if (s.status === 'done') return s.closedBy === 'reply' ? 'done (Claude says so)' : 'done'
  if (s.status === 'skipped') return 'skipped'

  return isStale(s) ? 'not mentioned lately' : 'to do'
}

const copyLabel = (s: Step) => (s.kind === 'sql' ? 'Copy SQL' : s.kind === 'command' ? 'Copy command' : 'Copy')
const copyWhat = (s: Step) => (s.kind === 'sql' ? 'SQL' : s.kind === 'command' ? 'command' : 'text')

export function panel(E: ElementTable, m: PanelModel, a: PanelActions): RenderElement {
  const { Box, Text, Button, Link, Code } = E
  const sum = m.summary
  const shown = (reveal: boolean, list: Step[]) => (reveal ? list : [])
  const rows: Step[] = [
    ...sum.todo,
    ...sum.claude,
    ...shown(m.reveal.optional, sum.optional),
    ...shown(m.reveal.earlier, sum.earlier),
    ...shown(m.reveal.closed, sum.closed),
  ]
  const focus = effectiveSelection(m.selected, sum, rows)
  const hotkeyOf = new Map(rows.map((s, i) => [s.id, i < 9 ? String(i + 1) : undefined]))
  const columns = Math.max(24, m.width)

  const row = (s: Step) => {
    const isFocus = s.id === focus
    const isNext = s.id === sum.next?.id
    const isClosed = s.status !== 'open'
    // Under "Claude can do" the owner is already said; elsewhere (optional, earlier, done) it is not.
    const tag = s.group === 'claude' && s.status === 'open' && !isStale(s) ? '' : tagOf(s)
    const tagRoom = tag === '' || columns < 50 ? 0 : tag.length + 2
    const title = clip(s.title, Math.max(12, columns - 10 - tagRoom))
    const glyph = s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : '○'

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Button
            key={`tick-${s.id}`}
            plain
            label={isClosed ? `Reopen: ${s.title}` : `Mark done: ${s.title}`}
            onPress={() => a.setStatus(s.id, isClosed ? 'open' : 'done')}
          >
            <Text color={s.status === 'done' ? 'success' : isNext ? 'warning' : undefined} dimColor={isClosed || (!isNext && !isFocus)}>
              {glyph}
            </Text>
          </Button>
          <Button key={`row-${s.id}`} plain hotkey={hotkeyOf.get(s.id)} label={s.title} onPress={() => a.select(s.id, isFocus)}>
            <Text bold={isFocus || isNext} dimColor={isClosed}>
              {title}
            </Text>
          </Button>
        </Box>
        {tagRoom > 0 && <Text dimColor>{tag}</Text>}
      </Box>
    )
  }

  const detail = (s: Step) => {
    const href = prHref(m.repo, s)
    const isOpen = s.status === 'open'
    const label = s.file?.label ?? (s.path ? relativeTo(m.root, s.path) : '')

    return (
      <Box flexDirection="column" paddingLeft={4} marginBottom={1}>
        {s.title.length > columns - 10 && <Text>{s.title}</Text>}
        <Text dimColor>
          {WHO[s.group]} · {statusWord(s)}
          {s.closedAt !== undefined && s.status !== 'open' ? ` at ${clockTime(s.closedAt)}` : ''}
        </Text>
        {s.why && <Text>{s.why}</Text>}

        {href && (
          <Text>
            ↗ <Link href={href} label={href.replace(/^https?:\/\//, '')} />
          </Text>
        )}

        {s.path && (
          <Box flexDirection="row" gap={2}>
            <Text>
              <Link href={s.file?.href ?? fileHref(m.root, m.repo, s.path)} label={label} />
              {s.file?.branch && <Text dimColor> ({s.file.branch})</Text>}
            </Text>
            <Button key="path" plain dimColor hotkey="p" onPress={press => a.copy(s.file?.copy ?? relativeTo(m.root, s.path ?? ''), 'path', press)}>
              Copy path
            </Button>
          </Box>
        )}

        {s.copy && (
          <Box borderStyle="round" borderDimColor paddingX={1}>
            <Code source={s.copy} language={s.language ?? (s.kind === 'sql' ? 'sql' : s.kind === 'command' ? 'bash' : undefined)} />
          </Box>
        )}

        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {s.copy && (
            <Button key="copy" plain hotkey="c" onPress={press => a.copy(s.copy ?? '', copyWhat(s), press)}>
              {copyLabel(s)}
            </Button>
          )}
          {isOpen && s.group === 'claude' && (
            <Button key="ask" plain hotkey="a" onPress={() => a.handOff(s, 'ask')}>
              Ask Claude
            </Button>
          )}
          {isOpen && s.group === 'decision' && (
            <Button key="approve" plain hotkey="y" onPress={() => a.handOff(s, 'approve')}>
              Approve
            </Button>
          )}
          {isOpen && s.group === 'decision' && (
            <Button key="decline" plain hotkey="n" onPress={() => a.handOff(s, 'decline')}>
              Decline
            </Button>
          )}
          <Button key="done" plain hotkey="d" onPress={() => a.setStatus(s.id, isOpen ? 'done' : 'open')}>
            {isOpen ? 'Mark done' : 'Reopen'}
          </Button>
          {isOpen && (
            <Button key="skip" plain dimColor hotkey="s" onPress={() => a.setStatus(s.id, 'skipped')}>
              Skip
            </Button>
          )}
        </Box>
      </Box>
    )
  }

  const item = (s: Step) => (
    <Box flexDirection="column">
      {row(s)}
      {s.id === focus && detail(s)}
    </Box>
  )

  const section = (label: string | undefined, list: Step[]) =>
    list.length === 0 ? null : (
      <Box flexDirection="column" marginTop={label ? 1 : 0}>
        {label && <Text dimColor>{label}</Text>}
        {list.map(item)}
      </Box>
    )

  const fold = (key: keyof Reveal, hotkey: string, label: string, list: Step[]) =>
    list.length === 0 ? null : (
      <Box flexDirection="column" marginTop={1}>
        <Button key={`reveal-${key}`} plain dimColor hotkey={hotkey} onPress={() => a.toggle(key)}>
          {label} · {list.length} {m.reveal[key] ? '▾' : '▸'}
        </Button>
        {m.reveal[key] && list.map(item)}
      </Box>
    )

  const hasLive = sum.todo.length + sum.claude.length > 0
  const hasAny = hasLive || sum.optional.length + sum.earlier.length + sum.closed.length > 0
  const summaryLine = [lead(sum), extras(sum)].filter(x => x !== '').join(' · ')

  return (
    <Box flexDirection="column" width={m.width}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold>Next steps</Text>
          {hasAny && <Text dimColor>  {summaryLine}</Text>}
          {hasAny && m.updatedAt > 0 && columns >= 60 && <Text dimColor> · {clockTime(m.updatedAt)}</Text>}
        </Text>
        <Button key="refresh" plain dimColor hotkey="r" onPress={() => a.refresh()}>
          Refresh
        </Button>
      </Box>

      {m.status === 'working' && <Text dimColor>Reading Claude's reply…</Text>}
      {m.status === 'error' && <Text color="error">{m.error ?? "Couldn't read Claude's last reply."} Press r to try again.</Text>}

      {!hasAny && m.status !== 'working' && (
        <Text dimColor>No next steps yet. They appear here when Claude hands work back to you.</Text>
      )}
      {hasAny && !hasLive && <Text color="success">Nothing is waiting on you ✓</Text>}

      {section(sum.claude.length > 0 ? 'To do' : undefined, sum.todo)}
      {section('Claude can do', sum.claude)}
      {fold('optional', 'o', 'Optional', sum.optional)}
      {fold('earlier', 'e', 'Earlier, not mentioned lately', sum.earlier)}
      {fold('closed', 'h', 'Done', sum.closed)}

      {m.isFocused && (
        <Box marginTop={1}>
          <Text dimColor>1–9 open a step · Tab moves between buttons · Esc returns to the prompt</Text>
        </Box>
      )}
    </Box>
  )
}
