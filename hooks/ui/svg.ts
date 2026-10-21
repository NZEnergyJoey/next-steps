import type { Progress } from '../lib/progress'

/**
 * The few drawn accents of the redesign, as SVG markup for the desktop's `Svg` element (the terminal has none and
 * draws text instead). Animated with SMIL, which the desktop runs only for an `isInteractive` Svg, in its sandboxed,
 * script-less frame. Pure strings: nothing here reads state or the clock.
 *
 * One accent colour, the app's blue; green only for "finished"; a neutral track that reads on light and dark alike.
 */

export const ACCENT = '#3B82F6'
export const ACCENT_SOFT = 'rgba(59,130,246,0.10)'
export const ACCENT_EDGE = 'rgba(59,130,246,0.55)'
export const SUCCESS = '#22C55E'
const TRACK = 'rgba(128,128,128,0.28)'
const SKIPPED = 'rgba(128,128,128,0.55)'

const svg = (w: number | string, h: number, viewBox: string, body: string, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${viewBox}"${extra}>${body}</svg>`

/**
 * The bar's ring: how far through the round the reader is. While Claude's reply is being read a short arc circles
 * the track; with everything finished the ring closes in green around a check.
 */
export function ringSvg(p: Pick<Progress, 'ratio' | 'total' | 'position'>, isWorking: boolean, size = 18): string {
  const r = 9
  const c = +(2 * Math.PI * r).toFixed(2)
  const isDone = p.total > 0 && p.position === 0
  const filled = isDone ? 1 : Math.min(1, Math.max(0, p.ratio))
  const colour = isDone ? SUCCESS : ACCENT
  const parts = [
    `<circle cx="12" cy="12" r="${r}" fill="none" stroke="${TRACK}" stroke-width="3"/>`,
    filled > 0
      ? `<circle cx="12" cy="12" r="${r}" fill="none" stroke="${colour}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${+(c * (1 - filled)).toFixed(2)}" transform="rotate(-90 12 12)"/>`
      : '',
    isDone ? `<path d="M8 12.4l2.6 2.6L16.2 9.6" fill="none" stroke="${SUCCESS}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` : '',
    !isDone && p.position > 0 ? `<circle cx="12" cy="12" r="2.6" fill="${ACCENT}"><animate attributeName="opacity" values="1;0.35;1" dur="2.4s" repeatCount="indefinite"/></circle>` : '',
    isWorking
      ? `<g><circle cx="12" cy="12" r="${r}" fill="none" stroke="${ACCENT}" stroke-opacity="0.9" stroke-width="3" stroke-linecap="round" stroke-dasharray="9 ${+(c - 9).toFixed(2)}"/><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1.1s" repeatCount="indefinite"/></g>`
      : '',
  ]

  return svg(size, size, '0 0 24 24', parts.join(''))
}

/** A soft beacon: a dot with a ring that breathes outward. Marks "live" and the step in focus. */
export function pulseSvg(size = 10, colour = ACCENT): string {
  return svg(
    size,
    size,
    '0 0 20 20',
    `<circle cx="10" cy="10" r="4" fill="${colour}"/><circle cx="10" cy="10" r="4" fill="none" stroke="${colour}" stroke-width="2"><animate attributeName="r" values="4;9" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.8;0" dur="2s" repeatCount="indefinite"/></circle>`,
  )
}

/**
 * The rail: one segment per step of the round, finished ones green, the current one shimmering in blue, the rest a
 * quiet track (the same colours as the Done and Now pills). Stretches to the width it is given.
 */
export function railSvg(p: Pick<Progress, 'segments'>, height = 6): string {
  const n = p.segments.length
  if (n === 0) return svg('100%', height, `0 0 100 ${height}`, '', ' preserveAspectRatio="none"')
  const gap = n > 1 ? 1.2 : 0
  const w = (100 - gap * (n - 1)) / n
  const rects = p.segments.map((s, i) => {
    const x = +(i * (w + gap)).toFixed(3)
    const fill = s.state === 'done' ? SUCCESS : s.state === 'current' ? ACCENT : s.state === 'skipped' ? SKIPPED : TRACK
    const shimmer = s.state === 'current' ? `<animate attributeName="opacity" values="1;0.4;1" dur="1.8s" repeatCount="indefinite"/>` : ''
    // A step part-way through its places: the done part solid, the rest shimmering on the track.
    const part = s.state === 'current' ? Math.min(1, Math.max(0, s.part ?? 0)) : 0
    if (part > 0) {
      const solid = +(w * part).toFixed(3)

      return `<rect x="${x}" y="0" width="${+w.toFixed(3)}" height="${height}" rx="0" fill="${TRACK}"/><rect x="${x}" y="0" width="${+w.toFixed(3)}" height="${height}" rx="0" fill="${ACCENT}" fill-opacity="0.45">${shimmer}</rect><rect x="${x}" y="0" width="${solid}" height="${height}" rx="0" fill="${ACCENT}"/>`
    }

    return `<rect x="${x}" y="0" width="${+w.toFixed(3)}" height="${height}" rx="0" fill="${fill}">${shimmer}</rect>`
  })

  return svg('100%', height, `0 0 100 ${height}`, rects.join(''), ' preserveAspectRatio="none"')
}
