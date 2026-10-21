import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { Flash, Step, StepStatus, View } from '../types'

import { MIN_ANSWER, readReply } from './lib/model'
import { reconcile, setStatus, setTarget, targetsLeft, type MergeResult } from './lib/merge'
import { gitRunner, prHref, readRepo, withFiles } from './lib/git'
import { ordered, statusText, summarise } from './lib/select'
import { FLASH_MS, liveFlash, newSince, progressOf } from './lib/progress'
import { DAY_MS, load, loadAll, prune, save } from './lib/store'
import { ago, fnv, slashes } from './lib/text'
import { taskbar, hasBand } from './ui/taskbar'
import { panel, type HandOff } from './ui/panel'

// Names other code (and the tests) have always been able to import from here.
export { parseSteps, parseExtraction } from './lib/extract'
export { localHref, parseRemote, parseWorktrees, slashes, worktreeOf } from './lib/git'

// ── The session's values ───────────────────────────────────────────────────────
// Held by the host, so a hot reload of this code keeps them (module variables it does not). What must outlive the
// session too is written to the store as well (lib/store.ts). The engine reads these declarations from this file.

const stepsAtom = atom({ plugin: 'next-steps', key: 'steps' } as const, [])
const statusAtom = atom({ plugin: 'next-steps', key: 'status' } as const, 'idle')
const errorAtom = atom({ plugin: 'next-steps', key: 'error' } as const, null)
const updatedAtAtom = atom({ plugin: 'next-steps', key: 'updatedAt' } as const, 0)
const lastAnswerAtom = atom({ plugin: 'next-steps', key: 'lastAnswer' } as const, '')
const repoAtom = atom({ plugin: 'next-steps', key: 'repo' } as const, null)
const rootAtom = atom({ plugin: 'next-steps', key: 'root' } as const, '')
const selectedAtom = atom({ plugin: 'next-steps', key: 'selected' } as const, null)
const viewAtom = atom({ plugin: 'next-steps', key: 'view' } as const, 'todo' satisfies View)
const paneOpenAtom = atom({ plugin: 'next-steps', key: 'isPaneOpen' } as const, false)
const flashAtom = atom({ plugin: 'next-steps', key: 'flash' } as const, null)
const seenAtAtom = atom({ plugin: 'next-steps', key: 'seenAt' } as const, 0)

const PANE = 'next-steps'
const COMMAND = 'next-steps'
/** Rows asked for when the panel opens above the prompt; the person's own size wins. */
const PANE_ROWS = 14
/** A failed read is tried once more after this long. */
const RETRY_MS = 1500

// ── Reading a reply, one at a time ─────────────────────────────────────────────
// These live in the module and so start over on a hot reload, which is harmless: the worst case is one reply read twice,
// and reading is idempotent (a step that comes round again is the same step).

let busy = false
let queued: { answer: string; force: boolean } | undefined
let lastRead = ''

/**
 * Reads a reply into the list. One read runs at a time; a request that arrives meanwhile waits, and only the newest
 * waiting one is kept, so a burst of replies or refreshes costs two reads, not many. A reply already read is skipped
 * unless `force` (an explicit refresh) says otherwise.
 */
async function refresh($: EngineInterface, answer: string, force: boolean): Promise<void> {
  if (busy) {
    queued = { answer, force: force || queued?.force === true }

    return
  }
  const hash = fnv(answer)
  if (!force && hash === lastRead) return

  busy = true
  try {
    await readInto($, answer, hash, force)
  } catch {
    // Whatever went wrong, the panel must not be left reading for ever.
    await update($, statusAtom, () => 'error').catch(() => undefined)
    await update($, errorAtom, () => "Something went wrong while reading Claude's reply.").catch(() => undefined)
  } finally {
    busy = false
  }
  const next = queued
  if (next !== undefined) {
    queued = undefined
    await refresh($, next.answer, next.force)
  }
}

async function readInto($: EngineInterface, answer: string, hash: string, force: boolean): Promise<void> {
  await update($, statusAtom, () => 'working')
  await update($, errorAtom, () => null)

  let out = await readReply($, answer, await read($, stepsAtom))
  if (!out.ok && out.retry) {
    await $.clock.sleep(RETRY_MS)
    out = await readReply($, answer, await read($, stepsAtom))
  }
  if (!out.ok) {
    await update($, statusAtom, () => 'error')
    await update(
      $,
      errorAtom,
      () => (out.ok ? null : out.why === 'model' ? "Couldn't reach the model to read Claude's reply." : "Couldn't make sense of the model's answer."),
    )

    return
  }

  const stamp = await $.clock.now()
  const found = await withFiles(gitRunner($), await read($, rootAtom), await read($, repoAtom), out.extraction.steps)
  const result: { v?: MergeResult } = {}
  await commit($, list => (result.v = reconcile(list, found, out.extraction.resolved, stamp, hash !== lastRead)).steps, stamp)
  lastRead = hash
  await update($, statusAtom, () => 'idle')

  // Quiet by design: no toast for new steps. The bar shows "+n new" until the panel is opened; while it is open,
  // the reader is looking at them already. A step the reply finished lingers a moment as "✓ Claude finished".
  if (await read($, paneOpenAtom)) await update($, seenAtAtom, () => stamp)
  const finished = (result.v?.resolved ?? []).find(s => s.group === 'you' || s.group === 'decision')
  if (finished) await flash($, finished, 'reply')
}

/** Shows a just-closed step for a moment while the highlight moves on, then lets it go. */
async function flash($: EngineInterface, step: Step, by: Flash['by']): Promise<void> {
  const at = await $.clock.now()
  await update($, flashAtom, () => ({ id: step.id, title: step.title, at, by }))
  $.clock.after(FLASH_MS, () => void update($, flashAtom, f => (f !== null && f.at === at ? null : f)).catch(() => undefined))
}

/**
 * Changes the list and keeps it: the session's copy first (which redraws whatever shows it), then the store and the
 * status line. `change` must be pure, as the engine may run it again if another write lands first.
 */
async function commit($: EngineInterface, change: (list: Step[]) => Step[], stamp?: number): Promise<void> {
  const now = await $.clock.now()
  await update($, stepsAtom, change)
  if (stamp !== undefined) await update($, updatedAtAtom, () => stamp)
  // Saved from the list as it stands now, so a tick that landed meanwhile is never overwritten by an older copy.
  await save($, await read($, rootAtom), await read($, stepsAtom), await read($, updatedAtAtom), now)
  await syncStatus($)
}

/**
 * Surfaces with no band above the prompt (the editor, the phone) get the same summary as a line of status.
 * Where a terminal or the desktop app is attached the band does the job, so the line is cleared.
 */
async function syncStatus($: EngineInterface): Promise<void> {
  const surfaces = await $.session.surfaces()
  const hasBandSurface = surfaces.some(s => s === 'terminal' || s === 'desktop')
  $.ui.status(!hasBandSurface && surfaces.length > 0 ? statusText(summarise(await read($, stepsAtom))) : undefined)
}

// ── What the buttons do ────────────────────────────────────────────────────────

async function openPane($: EngineInterface, focus: boolean): Promise<void> {
  const placed = await $.ui.open({ id: PANE, title: 'Next steps', rows: PANE_ROWS, closeOnEscape: true, ...(focus ? { focus: true as const } : {}) })
  await update($, paneOpenAtom, () => placed.isPlaced)
  if (placed.isPlaced) {
    const now = await $.clock.now()
    await update($, seenAtAtom, () => now)
  }
}

async function mark($: EngineInterface, id: string, status: StepStatus): Promise<void> {
  const now = await $.clock.now()
  const step = (await read($, stepsAtom)).find(s => s.id === id)
  await commit($, list => setStatus(list, id, status, now))
  if (status === 'done' && step && step.status === 'open') await flash($, step, 'you')
  if (status === 'open') await update($, flashAtom, f => (f?.id === id ? null : f))
}

/** Ticks one place a step must be done in; the last one ticked closes the step, which lingers its moment like any. */
async function tickTarget($: EngineInterface, id: string, target: string, isDone: boolean): Promise<void> {
  const now = await $.clock.now()
  const before = (await read($, stepsAtom)).find(s => s.id === id)
  await commit($, list => setTarget(list, id, target, isDone, now))
  const after = (await read($, stepsAtom)).find(s => s.id === id)
  if (before?.status === 'open' && after?.status === 'done') await flash($, after, 'you')
  if (before?.status === 'done' && after?.status === 'open') await update($, flashAtom, f => (f?.id === id ? null : f))
}

async function copyText($: EngineInterface, value: string, what: string, press?: UiPressArgument): Promise<void> {
  const r = await $.ui.copy({ text: value, surface: press?.surface })
  $.ui.toast(r.isCopied ? `Copied ${what}` : `Copy isn't available here: select the text in the box instead`)
}

/** Puts a ready-made reply in the prompt box for the reader to edit and send: nothing is ever sent for them. */
async function handOff($: EngineInterface, step: Step, how: HandOff, option?: string): Promise<void> {
  const text =
    how === 'ask'
      ? `Please go ahead with this next step: ${step.title}`
      : how === 'result'
        ? `Result of "${step.title}": `
        : how === 'option'
          ? `Decision on "${step.title}": ${option ?? ''}.`
          : `Decision on "${step.title}": ${how === 'approve' ? 'approved' : 'declined'}.`
  const r = await $.prompt.fill({ text, mode: 'insert' })
  $.ui.toast(
    !r.isFilled ? "Couldn't fill the prompt here" : how === 'result' ? 'Paste the result after it, then press Enter.' : 'Added to your prompt. Press Enter to send it.',
  )
}

async function rereadLastReply($: EngineInterface): Promise<boolean> {
  const answer = await read($, lastAnswerAtom)
  if (answer === '') return false
  $.clock.after(0, () => void refresh($, answer, true))

  return true
}

/** The lines `/next-steps list` prints: the same order and numbers as the panel. */
function listing(list: Step[]): string {
  const s = summarise(list)
  const open = ordered(s)
  if (open.length === 0) return 'No next steps.'
  const who = (st: Step) => (st.group === 'claude' ? 'Claude' : st.group === 'decision' ? 'decision' : st.group === 'optional' ? 'optional' : 'you')
  const where = (st: Step) => (st.targets ? ` (on ${st.targets.map(t => (targetsLeft(st).includes(t) ? t : `${t} ✓`)).join(', ')})` : '')
  const lines = open.map((st, i) => `${i + 1}. [${who(st)}] ${st.title}${where(st)}${st.why ? `: ${st.why}` : ''}`)

  return [`Next steps (${s.pending} pending${s.claude.length > 0 ? `, ${s.claude.length} for Claude` : ''}):`, ...lines].join('\n')
}

/**
 * What `/next-steps all` prints: every worktree with something open, in the order given (this one first, then the
 * rest newest first), with what waits on the reader in each. With many worktrees on the go, it is the one place to
 * see which migrations and merges are still outstanding.
 */
export function everywhere(records: Array<{ root: string; steps: Step[]; updatedAt: number }>, here: string, now: number): string {
  const lines: string[] = []
  let waiting = 0
  let places = 0
  for (const r of records) {
    const s = summarise(r.steps)
    if (s.todo.length + s.claude.length === 0) continue
    places += 1
    waiting += s.todo.length
    const name = slashes(r.root).split('/').pop() ?? r.root
    const isHere = slashes(r.root).toLowerCase() === slashes(here).toLowerCase()
    const counts = [`${s.todo.length} for you`, ...(s.claude.length > 0 ? [`${s.claude.length} for Claude`] : [])].join(', ')
    lines.push('', `${name}${isHere ? ' (this one)' : ''} · ${counts} · updated ${ago(now, r.updatedAt)}`)
    for (const st of s.todo) {
      const left = targetsLeft(st)
      const where = st.targets && left.length > 0 ? ` (${left.join(', ')} to go)` : ''
      lines.push(`  ${st.group === 'decision' ? '◇' : '○'} ${st.title}${where}`)
    }
  }
  if (places === 0) return 'Nothing is open in any worktree.'

  return [`Next steps in ${places} worktree${places === 1 ? '' : 's'}: ${waiting} waiting on you.`, ...lines].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the next-steps panel (args: refresh | clear | list | all | done [n] | help)',
      argumentHint: '[refresh|clear|list|all|done [n]|help]',
    })
    const found = await readRepo(gitRunner($), () => $.session.cwd())
    await update($, repoAtom, () => found.repo)
    await update($, rootAtom, () => found.root)

    // A read that was under way when the code reloaded will never report back.
    if ((await read($, statusAtom)) === 'working') await update($, statusAtom, () => 'idle')
    await update($, paneOpenAtom, () => false) // a pane from before a reload or resume is gone; ui.render re-opens it on demand
    await update($, flashAtom, () => null)
    if ((await read($, seenAtAtom)) === 0) {
      const started = await $.clock.now()
      await update($, seenAtAtom, () => started)
    }

    // Pick up this worktree's list from the last session, unless this session already holds one (a reload).
    const now = await $.clock.now()
    if ((await read($, stepsAtom)).length === 0) {
      const saved = await load($, found.root)
      if (saved) {
        await update($, stepsAtom, () => saved.steps)
        await update($, updatedAtAtom, () => saved.updatedAt)
        if (now - saved.touched > DAY_MS) await save($, found.root, saved.steps, saved.updatedAt, now)
      }
    }
    await prune($, now)
    await syncStatus($)

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    await syncStatus($)

    return result
  })

  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    await syncStatus($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && e.answer.length >= MIN_ANSWER) {
      const answer = e.answer
      await update($, lastAnswerAtom, () => answer)
      $.clock.after(0, () => void refresh($, answer, false))
    }

    return result
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    await update($, paneOpenAtom, () => false)

    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/, 2)

    if (verb === 'clear') {
      await commit($, () => [])
      await update($, selectedAtom, () => null)

      return { text: 'Next steps cleared.' }
    }
    if (verb === 'list') return { text: listing(await read($, stepsAtom)) }
    if (verb === 'all') {
      // This worktree's own list is read live; the others as last saved.
      const root = await read($, rootAtom)
      const here = { root, steps: await read($, stepsAtom), updatedAt: await read($, updatedAtAtom) }
      const others = (await loadAll($)).filter(r => slashes(r.root).toLowerCase() !== slashes(root).toLowerCase())

      return { text: everywhere([here, ...others], root, await $.clock.now()) }
    }
    if (verb === 'help') {
      return {
        text: [
          '/next-steps          open the panel',
          '/next-steps list     print the open steps',
          '/next-steps all      what is open in every worktree',
          '/next-steps done [n] mark step n (default: the next one) done',
          '/next-steps refresh  read Claude\'s last reply again',
          '/next-steps clear    empty the list',
        ].join('\n'),
      }
    }
    if (verb === 'done') {
      const open = ordered(summarise(await read($, stepsAtom)))
      const n = arg === '' ? 1 : Number(arg)
      const step = Number.isInteger(n) ? open[n - 1] : undefined
      if (step === undefined) return { text: open.length === 0 ? 'No next steps.' : `No step ${arg}. Try /next-steps list.` }
      await mark($, step.id, 'done')

      return { text: `Done: ${step.title}` }
    }
    if (verb === 'refresh') {
      if (!(await rereadLastReply($))) return { text: 'No reply to summarise yet.' }
      await openPane($, true)

      return { text: 'Re-reading the last reply…' }
    }
    await openPane($, true)

    return { text: 'Next steps opened.' }
  })

  // The compact taskbar above the prompt (terminal and desktop). It gives way to a survey, and to the panel once open.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const steps = await read($, stepsAtom)
    const summary = summarise(steps)
    const status = await read($, statusAtom)
    const isOpen = await read($, paneOpenAtom)
    const now = await $.clock.now().catch(() => 0) // drawing never fails for want of a clock
    const flashing = liveFlash(await read($, flashAtom), now)
    if (isOpen || !hasBand({ summary, status, flash: flashing })) return next(e)

    return taskbar(
      $.ui.resolve(e),
      {
        summary,
        progress: progressOf(steps, summary, now),
        status,
        flash: flashing,
        newCount: newSince(summary, await read($, seenAtAtom)),
        href: summary.next === undefined ? undefined : prHref(await read($, repoAtom), summary.next),
        width: e.props.bodyColumns,
        surface: e.surface,
      },
      {
        open: () => openPane($, false),
        done: step => mark($, step.id, 'done'),
        tickTarget: (step, target) => tickTarget($, step.id, target, true),
        ask: step => handOff($, step, 'ask'),
        retry: () => void rereadLastReply($),
      },
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const steps = await read($, stepsAtom)
    const summary = summarise(steps)
    const now = await $.clock.now().catch(() => 0) // drawing never fails for want of a clock
    const model = {
      summary,
      progress: progressOf(steps, summary, now),
      flash: liveFlash(await read($, flashAtom), now),
      status: await read($, statusAtom),
      error: await read($, errorAtom),
      updatedAt: await read($, updatedAtAtom),
      root: await read($, rootAtom),
      repo: await read($, repoAtom),
      selected: await read($, selectedAtom),
      view: await read($, viewAtom),
      width: Math.max(30, (e.props.bodyColumns ?? e.viewport?.columns ?? 80) - 2),
      isFocused: e.props.isFocused,
      surface: e.surface,
    }

    return panel($.ui.resolve(e), model, {
      select: (id, isSelected) => update($, selectedAtom, () => (isSelected ? '' : id)).then(() => undefined),
      setStatus: (id, status) => mark($, id, status),
      tickTarget: (id, target, isDone) => tickTarget($, id, target, isDone),
      copy: (value, what, press) => copyText($, value, what, press),
      handOff: (step, how, option) => handOff($, step, how, option),
      refresh: () => {
        void rereadLastReply($).then(ok => {
          if (!ok) $.ui.toast('No reply to read yet')
        })
      },
      show: (view: View) => update($, viewAtom, () => view).then(() => undefined),
    })
  })
}
