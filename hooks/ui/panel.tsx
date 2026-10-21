import type { ElementTable, RenderElement, RenderSurface, UiPressArgument } from 'claude-code'

import type { Flash, Repo, Step, StepStatus, StepsStatus, View } from '../../types'
import { fileHref, prHref, relativeTo } from '../lib/git'
import { kindLabel, type Progress } from '../lib/progress'
import { effectiveSelection, extras, lead, ordered, type Summary } from '../lib/select'
import { breakable, clockTime } from '../lib/text'
import { pulseSvg, railSvg } from './svg'
import { TABS, TONES, toneOf, type Tone } from './tone'

/**
 * The panel: one step in the spotlight, everything else a line, every step wearing its state.
 *
 *   Next steps  3 pending · 1 for Claude  ◉ Live · 10:42                     ↻ Refresh
 *   ▰▰▣▱▱  Step 3 of 5 · 2 done
 *   ( ● To do 4 )  ○ Optional 2   ○ Earlier 1   ○ Done 2                    (coloured tabs)
 *   ╭─────────────────────────────────────────────────────────────────────────╮
 *   │ ◉ Now · step 3 of 5                                         SQL   ▾    │
 *   │ ◐ Run migration 134 on NZE/PAW, which can be a long title that wraps   │
 *   │   inside the card however narrow the panel gets                         │
 *   │   Lets a note sit on both an invoice and its PO.                       │
 *   │   ╭ create table … ╮   [ Copy SQL ]  ✓ Mark done   Skip                │
 *   ╰─────────────────────────────────────────────────────────────────────────╯
 *   Up next 1
 *   ◇ Approve merging PR #155                                  Decide   2: ▸
 *   Claude can do 1
 *   ✦ Update the vault notes                      Ask Claude   Claude   3: ▸
 *
 * Every state has a colour, a glyph and a word (see tone.ts), and the tabs are drawn in the same colours, so blue is
 * always "now", green always "done". Nothing long sits inside a Button: titles are Text in a Box that may shrink,
 * so they wrap within the card at any width rather than run past its edge, and long paths and identifiers get
 * places to break. The panel fills the width it is given on the desktop instead of a count of cells.
 */

export type PanelModel = {
  summary: Summary
  progress: Progress
  status: StepsStatus
  error: string | null
  updatedAt: number
  root: string
  repo: Repo | null
  selected: string | null
  /** The tab the reader picked; an empty one falls back to To do. */
  view: View
  /** The step just closed, while its moment lasts. */
  flash: Flash | null
  /** Cells the panel may use (`bodyColumns`). */
  width: number
  /** Whether the person has given the panel the keyboard: only then are the key hints shown. */
  isFocused: boolean
  /** The surface drawing it: every surface but the terminal draws the accents (Svg, tints). */
  surface: RenderSurface
}

export type PanelActions = {
  select: (id: string, isSelected: boolean) => void
  setStatus: (id: string, status: StepStatus) => void
  copy: (value: string, what: string, press: UiPressArgument) => void
  handOff: (step: Step, how: 'ask' | 'approve' | 'decline') => void
  refresh: () => void
  show: (view: View) => void
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

  return toneOf(s) === 'earlier' ? 'not mentioned lately' : 'to do'
}

/** The panel's own surface on the desktop: a neutral grey at low alpha, a step off the chat in either theme. */
const PANEL_FILL = 'rgba(127,127,127,0.09)'

const copyLabel = (s: Step) => (s.kind === 'sql' ? 'Copy SQL' : s.kind === 'command' ? 'Copy command' : 'Copy')
const copyWhat = (s: Step) => (s.kind === 'sql' ? 'SQL' : s.kind === 'command' ? 'command' : 'text')

/** How many steps each tab holds. */
export function tabCounts(s: Summary): Record<View, number> {
  return { todo: s.todo.length + s.claude.length, optional: s.optional.length, earlier: s.earlier.length, done: s.closed.length }
}

/** The tab to draw: the reader's pick while it holds anything, else To do. */
export const viewOf = (picked: View, s: Summary): View => (picked !== 'todo' && tabCounts(s)[picked] === 0 ? 'todo' : picked)

export function panel(E: ElementTable, m: PanelModel, a: PanelActions): RenderElement {
  const { Box, Text, Button, Link, Code } = E
  // The desktop (and the editor, and the phone) can draw the accents; the terminal cannot, and gets text. Decided by
  // the surface, not by looking for `Svg` in the table, which a table may answer for whether or not it draws it.
  const rich = m.surface !== 'terminal'
  const Svg = rich ? (E as ElementTable<'desktop'>).Svg : undefined
  const sum = m.summary
  const p = m.progress
  const columns = Math.max(24, m.width)
  // Where the surface wraps at spaces only, long paths and identifiers get places to break; the terminal wraps hard.
  const shown = (text: string) => (rich ? breakable(text) : text)

  const counts = tabCounts(sum)
  const view = viewOf(m.view, sum)
  const now = view === 'todo' ? sum.next : undefined
  const upNext = sum.todo.filter(s => s !== now)
  const forClaude = sum.claude.filter(s => s !== now)
  const rows: Step[] =
    view === 'todo' ? [...(now ? [now] : []), ...upNext, ...forClaude] : view === 'optional' ? sum.optional : view === 'earlier' ? sum.earlier : sum.closed
  const focus = effectiveSelection(m.selected, sum, rows)
  // Numbered as `/next-steps list` and `/next-steps done n` number them, in every tab; the digits 1-9 open them.
  const numberOf = new Map(ordered(sum).map((s, i) => [s.id, i + 1]))
  const hotkeyOf = (s: Step) => {
    const n = numberOf.get(s.id)

    return n !== undefined && n <= 9 ? String(n) : undefined
  }

  /** A state, as a word in its colour: a tinted pill where the surface can draw one. */
  const pill = (tone: Tone, label = TONES[tone].label) => {
    const t = TONES[tone]

    return (
      <Text size="caption" weight="semibold" color={t.color} backgroundColor={rich ? t.tint : undefined}>
        {rich ? ` ${label} ` : label}
      </Text>
    )
  }

  /** The state's glyph, which is also the tick: press it to close the step, or to bring a closed one back. */
  const tick = (s: Step, tone: Tone) => {
    const isClosed = s.status !== 'open'

    return (
      <Button key={`tick-${s.id}`} plain onPress={() => a.setStatus(s.id, isClosed ? 'open' : 'done')}>
        <Text color={TONES[tone].color} weight="semibold">
          {TONES[tone].glyph}
        </Text>
      </Button>
    )
  }

  /**
   * Opens or folds a step: a chevron, so no title is ever held to one line. No `label` on any Button that has
   * children: a desktop draws the label in their place, and a long one would crowd the title out of its row.
   */
  const disclose = (s: Step, isOpen: boolean) => (
    <Button key={`row-${s.id}`} plain dimColor hotkey={hotkeyOf(s)} onPress={() => a.select(s.id, isOpen)}>
      {isOpen ? '▾' : '▸'}
    </Button>
  )

  /** The why, the links, the code and the actions of one step: in full for the spotlight, the same for a picked row. */
  const body = (s: Step, isSpot: boolean) => {
    const href = prHref(m.repo, s)
    const isOpen = s.status === 'open'
    const label = s.file?.label ?? (s.path ? relativeTo(m.root, s.path) : '')
    // The one action to take is the button that stands out; the rest stay quiet.
    const primary: 'copy' | 'ask' | 'approve' | 'done' = !isOpen ? 'done' : s.group === 'decision' ? 'approve' : s.group === 'claude' ? 'ask' : s.copy ? 'copy' : 'done'
    const btn = (key: string, hotkey: string, text: string, onPress: (press: UiPressArgument) => void, quiet = false) =>
      rich && isSpot ? (
        <Button key={key} hotkey={hotkey} variant={primary === key ? 'primary' : 'secondary'} dimColor={quiet} onPress={onPress}>
          {text}
        </Button>
      ) : (
        <Button key={key} plain hotkey={hotkey} dimColor={quiet} onPress={onPress}>
          {text}
        </Button>
      )

    return (
      <Box flexDirection="column" gap={rich ? 'xs' : 0} minWidth={0}>
        {(!isSpot || s.group !== 'you' || !isOpen) && (
          <Text dimColor size="footnote" wrap="wrap">
            {WHO[s.group]} · {statusWord(s)}
            {s.closedAt !== undefined && s.status !== 'open' ? ` at ${clockTime(s.closedAt)}` : ''}
          </Text>
        )}
        {s.why && (
          <Text dimColor={!isSpot} wrap="wrap">
            {shown(s.why)}
          </Text>
        )}

        {href && (
          <Text wrap="wrap">
            ↗ <Link href={href} label={shown(href.replace(/^https?:\/\//, ''))} />
          </Text>
        )}

        {s.path && (
          <Box flexDirection="row" columnGap={2} flexWrap="wrap" alignItems="flex-start">
            <Box flexShrink={1} minWidth={0}>
              <Text wrap="wrap">
                <Link href={s.file?.href ?? fileHref(m.root, m.repo, s.path)} label={shown(label)} />
                {s.file?.branch && <Text dimColor> ({shown(s.file.branch)})</Text>}
              </Text>
            </Box>
            <Button key="path" plain dimColor hotkey="p" onPress={press => a.copy(s.file?.copy ?? relativeTo(m.root, s.path ?? ''), 'path', press)}>
              Copy path
            </Button>
          </Box>
        )}

        {s.copy && (
          <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column" minWidth={0}>
            <Code source={s.copy} language={s.language ?? (s.kind === 'sql' ? 'sql' : s.kind === 'command' ? 'bash' : undefined)} />
          </Box>
        )}

        <Box flexDirection="row" gap={rich ? 'sm' : 2} flexWrap="wrap" marginTop={rich && isSpot ? 'xs' : 0}>
          {s.copy && btn('copy', 'c', copyLabel(s), press => a.copy(s.copy ?? '', copyWhat(s), press))}
          {isOpen && s.group === 'claude' && btn('ask', 'a', 'Ask Claude', () => a.handOff(s, 'ask'))}
          {isOpen && s.group === 'decision' && btn('approve', 'y', 'Approve', () => a.handOff(s, 'approve'))}
          {isOpen && s.group === 'decision' && btn('decline', 'n', 'Decline', () => a.handOff(s, 'decline'))}
          {btn('done', 'd', isOpen ? '✓ Mark done' : 'Reopen', () => a.setStatus(s.id, isOpen ? 'done' : 'open'))}
          {isOpen && btn('skip', 's', 'Skip', () => a.setStatus(s.id, 'skipped'), true)}
        </Box>
      </Box>
    )
  }

  /** The step in the spotlight: a card in its state's colour, the whole title and story inside. */
  const spotlight = (s: Step) => {
    const isOpenCard = focus === s.id
    const tone = toneOf(s, true)
    const t = TONES[tone]
    const where = s.group === 'claude' ? 'Claude can do' : p.position > 0 ? `Now · step ${p.position} of ${p.total}` : 'Now'

    return (
      <Box
        key={`spot-${s.id}`}
        flexDirection="column"
        marginTop={rich ? 'sm' : 1}
        borderStyle="round"
        borderColor={rich ? t.edge : t.color}
        backgroundColor={rich ? t.wash : undefined}
        paddingX={rich ? 'md' : 1}
        paddingY={rich ? 'sm' : 0}
        gap={rich ? 'xs' : 0}
        minWidth={0}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
            {Svg ? <Svg source={pulseSvg(10, tone === 'claude' ? '#D97757' : '#3B82F6')} alt="Current step" isInteractive width={10} height={10} /> : <Text color={t.color}>◉</Text>}
            <Text color={t.color} size="caption" weight="semibold" wrap="truncate-end">
              {where}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            {s.group === 'decision' ? pill('decide') : columns >= 30 && s.kind !== 'action' && <Text dimColor size="caption">{kindLabel(s)}</Text>}
            {disclose(s, isOpenCard)}
          </Box>
        </Box>
        <Box flexDirection="row" gap={1} alignItems="flex-start">
          {tick(s, tone)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color="text" size={rich ? 'heading' : undefined} weight="semibold" wrap="wrap">
              {shown(s.title)}
            </Text>
          </Box>
        </Box>
        {isOpenCard && (
          <Box paddingLeft={rich ? 'lg' : 2} flexDirection="column" minWidth={0}>
            {body(s, true)}
          </Box>
        )}
      </Box>
    )
  }

  /** Any other step: its glyph, its whole title (wrapped, never cut), its state; opened, its story underneath. */
  const line = (s: Step) => {
    const isFocus = s.id === focus
    const isClosed = s.status !== 'open'
    const tone = toneOf(s)
    const isAskable = s.group === 'claude' && !isClosed && columns >= 48
    // The kind is worth a word only when it says something ("SQL", "PR"), never the catch-all "Action".
    const showKind = !isClosed && !isAskable && s.group !== 'decision' && s.kind !== 'action' && columns >= 56

    return (
      <Box key={`line-${s.id}`} flexDirection="column" marginTop={rich ? 'xs' : 0}>
        <Box flexDirection="row" gap={1} alignItems="flex-start">
          {tick(s, tone)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color="text" weight={isFocus ? 'semibold' : 'regular'} dimColor={isClosed} strikethrough={s.status === 'done'} wrap="wrap">
              {shown(s.title)}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            {showKind && (
              <Text dimColor size="caption">
                {kindLabel(s)}
              </Text>
            )}
            {isAskable && (
              <Button key={`ask-${s.id}`} plain dimColor onPress={() => a.handOff(s, 'ask')}>
                Ask Claude
              </Button>
            )}
            {columns >= 34 && pill(tone)}
            {disclose(s, isFocus)}
          </Box>
        </Box>
        {isFocus && (
          <Box flexDirection="column" paddingLeft={rich ? 'lg' : 2} marginTop={rich ? 'xs' : 0} marginBottom={1} minWidth={0}>
            {body(s, false)}
          </Box>
        )}
      </Box>
    )
  }

  const heading = (label: string, n: number) => (
    <Box flexDirection="row" gap={1} alignItems="center" marginTop={1}>
      <Text color="text" weight="semibold" size={rich ? 'footnote' : undefined} dimColor={!rich}>
        {label}
      </Text>
      <Text dimColor size="caption" tabular>
        {String(n)}
      </Text>
    </Box>
  )

  const section = (label: string, list: Step[]) =>
    list.length === 0 ? null : (
      <Box flexDirection="column">
        {heading(label, list.length)}
        {list.map(line)}
      </Box>
    )

  /**
   * One tab: a dot in its state's colour, then its name and count; the open one is filled, and tinted where it can
   * be. The dot sits outside the Button, as a desktop draws a Button's words but not their colours.
   */
  const tab = (t: (typeof TABS)[number]) => {
    const isOn = view === t.view
    const tone = TONES[t.tone]

    return (
      <Box
        key={`tabbox-${t.view}`}
        flexDirection="row"
        gap={1}
        alignItems="center"
        flexShrink={0}
        backgroundColor={rich && isOn ? tone.tint : undefined}
        paddingX={rich ? 'xs' : 0}
      >
        <Text color={tone.color}>{isOn ? '●' : '○'}</Text>
        <Button key={`tab-${t.view}`} plain hotkey={t.hotkey} dimColor={!isOn} onPress={() => a.show(t.view)}>
          {`${t.label} ${counts[t.view]}`}
        </Button>
      </Box>
    )
  }
  const tabs = TABS.filter(t => t.view === 'todo' || counts[t.view] > 0)

  const hasLive = counts.todo > 0
  const hasAny = tabs.length > 1 || hasLive
  const summaryLine = [lead(sum), extras(sum)].filter(x => x !== '').join(' · ')

  // ── The header: what it is, that it is live, and when it last heard from Claude ──
  const live =
    m.status === 'working' ? (
      <Text color="suggestion" size="caption">
        Syncing with Claude…
      </Text>
    ) : m.status === 'error' ? (
      <Text color="error" size="caption">
        Couldn't read the last reply
      </Text>
    ) : (
      <Text dimColor size="caption">
        Live{m.updatedAt > 0 && columns >= 44 ? ` · updated ${clockTime(m.updatedAt)}` : ''}
      </Text>
    )

  return (
    // On the desktop the panel sits on a surface of its own, set apart from the chat by a soft neutral fill that
    // reads on light and dark themes alike; the cards inside are tinted on top of it.
    <Box
      flexDirection="column"
      width={rich ? '100%' : m.width}
      minWidth={0}
      backgroundColor={rich ? PANEL_FILL : undefined}
      paddingX={rich ? 'md' : 0}
      paddingY={rich ? 'sm' : 0}
    >
      <Box flexDirection="row" alignItems="flex-start" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="wrap">
            <Text weight="semibold" size={rich ? 'heading' : undefined}>
              Next steps
            </Text>
            {hasAny && columns >= 40 && <Text dimColor>  {summaryLine}</Text>}
          </Text>
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            {Svg && m.status !== 'error' ? (
              <Svg source={pulseSvg(9)} alt={m.status === 'working' ? 'Syncing' : 'Live'} isInteractive width={9} height={9} />
            ) : (
              <Text color={m.status === 'error' ? 'error' : m.status === 'working' ? 'suggestion' : 'success'}>●</Text>
            )}
            {live}
          </Box>
        </Box>
        <Box flexShrink={0}>
          <Button key="refresh" plain dimColor hotkey="r" onPress={() => a.refresh()}>
            {columns >= 40 ? '↻ Refresh' : '↻'}
          </Button>
        </Box>
      </Box>

      {m.status === 'error' && (
        <Text color="error" wrap="wrap">
          {m.error ?? "Couldn't read Claude's last reply."} Press r to try again.
        </Text>
      )}

      {p.total > 0 && (
        <Box flexDirection="column" marginTop={rich ? 'sm' : 1} gap={rich ? 'xs' : 0}>
          {Svg ? (
            <Svg source={railSvg(p)} alt={`${p.done} of ${p.total} steps finished`} isInteractive height={6} />
          ) : (
            <Text>
              {p.segments.map(seg => (
                <Text color={seg.state === 'done' ? 'success' : seg.state === 'current' ? 'suggestion' : 'inactive'}>
                  {seg.state === 'current' ? '▣' : seg.state === 'todo' ? '▱' : '▰'}
                </Text>
              ))}
            </Text>
          )}
          <Text dimColor size="caption" tabular wrap="wrap">
            {p.position > 0 ? `Step ${p.position} of ${p.total} · ${p.done} done` : `All ${p.total} done`}
          </Text>
        </Box>
      )}

      {m.flash && (
        <Text color="success" weight="medium" wrap="truncate-end">
          ✓ {m.flash.by === 'reply' ? 'Claude finished' : 'Done'} · {m.flash.title}
        </Text>
      )}

      {tabs.length > 1 && (
        <Box flexDirection="row" flexWrap="wrap" gap={rich ? 'xs' : 2} marginTop={rich ? 'sm' : 1}>
          {tabs.map(tab)}
        </Box>
      )}

      {!hasAny && m.status !== 'working' && (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="medium">No next steps yet</Text>
          <Text dimColor wrap="wrap">
            They appear here when Claude hands work back to you, with the one to do first in the spotlight.
          </Text>
        </Box>
      )}
      {hasAny && view === 'todo' && !hasLive && (
        <Box flexDirection="row" gap={1} marginTop={1} alignItems="flex-start">
          <Text color="success" weight="semibold">
            ✓
          </Text>
          <Text color="success" weight="medium" wrap="wrap">
            Nothing is waiting on you
          </Text>
        </Box>
      )}

      {view === 'todo' && now && spotlight(now)}
      {view === 'todo' && section('Up next', upNext)}
      {view === 'todo' && section('Claude can do', forClaude)}
      {view === 'optional' && section('Optional', sum.optional)}
      {view === 'earlier' && (
        <Box flexDirection="column">
          {section('Earlier, not mentioned lately', sum.earlier)}
          <Text dimColor size="caption" wrap="wrap">
            The last few replies stopped mentioning these, so they no longer count. Tick them off or leave them.
          </Text>
        </Box>
      )}
      {view === 'done' && section('Done', sum.closed)}

      {m.isFocused && (
        <Box marginTop={1}>
          <Text dimColor size="caption" wrap="wrap">
            1–9 open a step · d done · c copy · t o e h switch tabs · Tab moves between buttons · Esc returns to the prompt
          </Text>
        </Box>
      )}
    </Box>
  )
}