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

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

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

/** The words of a title that carry its meaning, lower case. */
export const words = (title: string): string[] =>
  title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 2 && !STOP.has(w))

/** How alike two titles are, 0 to 1 (shared words over all words). */
export function similarity(a: string, b: string): number {
  const x = new Set(words(a))
  const y = new Set(words(b))
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++

  return shared / (x.size + y.size - shared)
}
