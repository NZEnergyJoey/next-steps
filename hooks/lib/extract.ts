import type { FileLink, Step, StepGroup, StepKind } from '../../types'

import { clip, fnv, slashes, squash, words } from './text'

/**
 * Turning the model's answer into steps. Pure, so every rule here is tested without an engine.
 *
 * The safety rules that went before still hold, and are now checked in code rather than only asked for in the prompt:
 * - only http(s) URLs are kept;
 * - SQL, commands and snippets are kept only when they really appear in the reply, and are never cut short;
 * - a path is kept only when its file name appears in the reply.
 */

export const KINDS: readonly StepKind[] = ['pr', 'sql', 'command', 'file', 'deploy', 'review', 'check', 'action']
export const GROUPS: readonly StepGroup[] = ['you', 'decision', 'claude', 'optional']

const KIND_SET = new Set<string>(KINDS)
const GROUP_SET = new Set<string>(GROUPS)

/** Other words a model may use for a group. A Map, so a name like `constructor` finds nothing. */
const GROUP_WORDS = new Map<string, StepGroup>([
  ['user', 'you'],
  ['human', 'you'],
  ['me', 'you'],
  ['reader', 'you'],
  ['approval', 'decision'],
  ['approve', 'decision'],
  ['confirm', 'decision'],
  ['choice', 'decision'],
  ['assistant', 'claude'],
  ['ai', 'claude'],
  ['agent', 'claude'],
  ['suggestion', 'optional'],
  ['recommendation', 'optional'],
  ['recommended', 'optional'],
])

export const LIMIT = { title: 200, why: 400, copy: 12000, language: 20, path: 500, url: 2000 } as const

/** At most this many steps are taken from one reply. */
export const MAX_PER_REPLY = 12

/** What one reply adds: a step as read, before it is given an id and a place in the list. */
export type Incoming = {
  kind: StepKind
  group: StepGroup
  title: string
  why?: string
  copy?: string
  language?: string
  path?: string
  url?: string
  file?: FileLink
  key: string
}

export type Extraction = {
  steps: Incoming[]
  /** Ids of earlier open steps the reply says are now done. */
  resolved: string[]
}

type Raw = Record<string, unknown>

const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A control character other than tab and newline. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** Prose: trimmed, and cut with an ellipsis when too long. */
export function prose(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()

  return t === '' ? undefined : clip(t, max)
}

/** Code: kept exactly (less blank lines at either end), and left out rather than cut when it does not fit. */
export function block(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()
  if (t.trim() === '' || t.length > max || CONTROL.test(t)) return undefined

  return t
}

/** A path or URL: one line, kept whole or left out. */
export function token(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t === '' || t.length > max || /[\s\u0000-\u001f\u007f]/.test(t)) return undefined

  return t
}

const isHttp = (u: string) => /^https?:\/\/[^\s/]+/i.test(u)

/** Whether `value` really stands in the reply (white space aside): the guard against invented code. */
/** Each line's own white space is ignored, but line breaks are not: a flattened one-liner is not the multi-line code. */
const byLine = (s: string) => s.split(/\r?\n/).map(squash).filter(l => l !== '').join('\n')
export const isGrounded = (reply: string, value: string) => byLine(reply).includes(byLine(value))

/** A path is kept only when its file name is in the reply. */
function pathIsGrounded(reply: string, path: string): boolean {
  const name = slashes(path).split('/').pop() ?? ''

  if (slashes(path).split('/').includes('..')) return false

  return name !== '' && reply.toLowerCase().includes(name.toLowerCase())
}

export function toGroup(v: unknown): StepGroup {
  if (typeof v !== 'string') return 'you'
  const w = v.trim().toLowerCase()
  if (GROUP_SET.has(w)) return w as StepGroup

  return GROUP_WORDS.get(w) ?? 'you'
}

export const toKind = (v: unknown): StepKind => (typeof v === 'string' && KIND_SET.has(v) ? (v as StepKind) : 'action')

/** What makes a later reply's step "the same step": the code, else the URL, else the file, else the title's words. */
export function stepKey(s: { kind: StepKind; title: string; copy?: string; path?: string; url?: string }): string {
  if (s.copy) return `c:${fnv(squash(s.copy))}`
  if (s.url) return `u:${s.url.replace(/\/+$/, '')}`
  if (s.path) return `p:${s.kind}:${slashes(s.path).toLowerCase()}`

  return `t:${[...new Set(words(s.title))].sort().join(' ')}`
}

/** The JSON in a model's answer: the whole text, else an object or an array found inside prose or a code fence. */
function readJson(output: string): unknown {
  const text = output
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
  const attempts = [text]
  const o = [text.indexOf('{'), text.lastIndexOf('}')] as const
  const a = [text.indexOf('['), text.lastIndexOf(']')] as const
  if (o[0] >= 0 && o[1] > o[0]) attempts.push(text.slice(o[0], o[1] + 1))
  if (a[0] >= 0 && a[1] > a[0]) attempts.push(text.slice(a[0], a[1] + 1))
  for (const t of attempts) {
    try {
      return JSON.parse(t) as unknown
    } catch {
      /* try the next shape */
    }
  }

  return undefined
}

/**
 * Reads the model's answer: `{ steps, resolved }`, or the older bare array of steps.
 * `undefined` means the answer was unreadable, which is not the same as `{ steps: [] }`, a reply that asks nothing.
 * `reply` is the text the steps were drawn from; when given, code, paths and URLs not found in it are dropped.
 */
export function parseExtraction(output: string, reply?: string): Extraction | undefined {
  const raw = readJson(output)
  const list = Array.isArray(raw) ? raw : isRaw(raw) && Array.isArray(raw.steps) ? (raw.steps as unknown[]) : undefined
  if (list === undefined) return undefined

  const resolved =
    isRaw(raw) && Array.isArray(raw.resolved)
      ? (raw.resolved as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 30)
      : []

  const steps: Incoming[] = []
  const keys = new Set<string>()
  for (const item of list) {
    if (!isRaw(item)) continue
    const title = prose(item.title, LIMIT.title)
    if (title === undefined) continue

    const kind = toKind(item.kind)
    let copy = block(item.copy, LIMIT.copy)
    let path = token(item.path, LIMIT.path)
    let url = token(item.url, LIMIT.url)
    if (url !== undefined && !isHttp(url)) url = undefined
    if (reply !== undefined) {
      if (copy !== undefined && !isGrounded(reply, copy)) copy = undefined
      if (path !== undefined && !pathIsGrounded(reply, path)) path = undefined
      if (url !== undefined && !reply.includes(url)) url = undefined
    }

    const step: Incoming = {
      kind,
      group: toGroup(item.group ?? item.owner),
      title,
      why: prose(item.why ?? item.detail, LIMIT.why),
      copy,
      language: copy === undefined ? undefined : prose(item.language, LIMIT.language),
      path,
      url,
      key: '',
    }
    step.key = stepKey(step)
    if (keys.has(step.key)) continue
    keys.add(step.key)
    steps.push(step)
    if (steps.length >= MAX_PER_REPLY) break
  }

  return { steps, resolved }
}

/**
 * The old entry point: the steps of an answer, [] when it has none or cannot be read.
 * Kept so anything calling it still works; new code uses `parseExtraction`.
 */
export function parseSteps(output: string, stamp: number, reply?: string): Step[] {
  return (parseExtraction(output, reply)?.steps ?? []).map((s, i) => ({
    ...s,
    id: `${stamp}-${i}`,
    status: 'open' as const,
    firstSeen: stamp,
    lastSeen: stamp,
    missed: 0,
  }))
}

// ── Reading back what was saved ─────────────────────────────────────────────

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function reviveFile(v: unknown): FileLink | undefined {
  if (!isRaw(v)) return undefined
  const href = token(v.href, LIMIT.url)
  const label = prose(v.label, LIMIT.path)
  const copy = prose(v.copy, LIMIT.path)
  // A saved link is only ever GitHub or a local file: anything else is not something this mod wrote.
  if (!href || !label || !copy || !/^(https:\/\/github\.com\/|file:\/\/\/)/i.test(href)) return undefined

  return { href, label, copy, branch: prose(v.branch, LIMIT.title) }
}

/** Steps read back from the store, held to the same rules as a fresh read: stored data is not trusted. */
export function reviveSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return []
  const out: Step[] = []
  for (const item of raw) {
    if (!isRaw(item)) continue
    const id = token(item.id, 64)
    const title = prose(item.title, LIMIT.title)
    if (id === undefined || title === undefined) continue
    const url = token(item.url, LIMIT.url)
    const kind = toKind(item.kind)
    const copy = block(item.copy, LIMIT.copy)
    const path = token(item.path, LIMIT.path)
    const status = item.status === 'done' || item.status === 'skipped' ? item.status : 'open'
    const base = {
      id,
      kind,
      group: toGroup(item.group),
      status,
      title,
      why: prose(item.why, LIMIT.why),
      copy,
      language: copy === undefined ? undefined : prose(item.language, LIMIT.language),
      path,
      url: url !== undefined && isHttp(url) ? url : undefined,
      file: reviveFile(item.file),
      firstSeen: num(item.firstSeen) ?? 0,
      lastSeen: num(item.lastSeen) ?? 0,
      missed: Math.max(0, Math.floor(num(item.missed) ?? 0)),
      closedAt: num(item.closedAt),
      closedBy: item.closedBy === 'you' || item.closedBy === 'reply' ? item.closedBy : undefined,
    } as const
    out.push({ ...base, key: stepKey(base) })
  }

  return out
}
