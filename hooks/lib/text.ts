/** Small text helpers shared by the parsing, merging and drawing code. Pure. */

/** Forward slashes, no trailing slash, no leading `./`. */
export const slashes = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

/** Whitespace runs collapsed to one space: what two copies of the same code are compared by. */
export const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** `text` cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  if (max <= 1) return text.length > 0 ? '…' : ''
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/** The zero-width space: an invisible place where a line may break. */
const BREAK = String.fromCharCode(0x200b)

/**
 * Long unbroken runs (paths, identifiers, URLs, hashes) given places to wrap, for surfaces that break lines at spaces
 * only: a zero-width space after each separator, and every 24 characters of a run with none. For display alone.
 */
export function breakable(text: string, run = 18): string {
  return text.replace(new RegExp(`\\S{${run},}`, 'g'), w =>
    w
      .replace(/([/\\_.:=&?,-])(?=\S)/g, `$1${BREAK}`)
      .split(BREAK)
      .map(part => part.replace(/(.{24})(?=.)/g, `$1${BREAK}`))
      .join(BREAK),
  )
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** How long ago, in the largest whole unit: "just now", "5m ago", "3h ago", "2d ago". */
export function ago(now: number, then: number): string {
  const m = Math.floor(Math.max(0, now - then) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ago`

  return `${Math.floor(m / 1440)}d ago`
}

export function clockTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A short stable hash (FNV-1a, base 36): enough to tell two pieces of text apart, not a security measure. */
export function fnv(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }

  return (h >>> 0).toString(36)
}

const STOP = new Set(['the', 'and', 'for', 'with', 'then', 'that', 'this', 'your', 'you', 'please', 'now', 'its', 'are', 'from'])

/** The words of a title that carry its meaning, lower case. A lone digit counts: "chore 1" is not "chore 2". */
export const words = (title: string): string[] =>
  title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => (w.length >= 2 || /^\d$/.test(w)) && !STOP.has(w))

/**
 * Whether one title says everything the other does, with more: "Merge PR #76 once both verifiers pass" contains
 * "Merge PR #76". The shorter needs three words of meaning, so "Run the tests" is never swallowed by another title.
 */
export function contains(a: string, b: string): boolean {
  const [short, long] = words(a).length <= words(b).length ? [new Set(words(a)), new Set(words(b))] : [new Set(words(b)), new Set(words(a))]
  if (short.size < 3) return false
  for (const w of short) if (!long.has(w)) return false

  return true
}

/** How alike two titles are, 0 to 1 (shared words over all words). */
export function similarity(a: string, b: string): number {
  const x = new Set(words(a))
  const y = new Set(words(b))
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++

  return shared / (x.size + y.size - shared)
}
