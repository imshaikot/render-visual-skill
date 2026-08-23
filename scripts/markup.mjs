// Surgical edits to a single opening tag, and the clip geometry both include
// mechanisms generate.
//
// Deliberately *not* a parse-and-reserialize: parts.mjs can round-trip a `<g>`
// through a Map because it wrote every part file itself, but an author's `<img
// loading="lazy" hidden>` round-tripped the same way comes back without
// `hidden` — an attribute silently dropped from someone else's markup. So every
// function here rewrites the one attribute it was asked about and leaves the
// rest of the tag byte for byte as it was found.

const attrRe = (name, flags = 'i') =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, flags)

/** An attribute's value, whatever it was quoted with, or undefined. */
export function getAttr(tag, name) {
  const m = attrRe(name).exec(tag)
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

/** The tag with `name` set to `value`, added before the close if it was absent. */
export function setAttr(tag, name, value) {
  const quoted = ` ${name}="${String(value).replace(/"/g, '&quot;')}"`
  // Function replacements throughout: a data: URI is arbitrary text as far as
  // String.replace is concerned, and `$&` inside one would splice the match
  // back into the page.
  if (attrRe(name).test(tag)) return tag.replace(attrRe(name), () => quoted)
  return tag.replace(/(\/?)>$/, (_, slash) => `${quoted}${slash}>`)
}

/** The tag with every occurrence of `name` removed. */
export const dropAttr = (tag, name) => tag.replace(attrRe(name, 'ig'), '')

/** The tag with `decls` appended to its style attribute, creating one if needed. */
export function mergeStyle(tag, decls) {
  if (!decls) return tag
  const cur = getAttr(tag, 'style')
  return setAttr(tag, 'style', cur ? `${cur.replace(/;\s*$/, '')};${decls}` : decls)
}

/** True when the tag closes itself — `<image …/>` keeps its slash on rewrite. */
export const isSelfClosing = (tag) => /\/>$/.test(tag)

/* ── Clip geometry ──────────────────────────────────────────────────────── */

/**
 * A rounded-rect path with per-corner radii `[tl, tr, br, bl]`.
 *
 * One `rx` cannot describe a device screen: a browser frame's viewport has
 * square corners under the title bar and rounded ones at the bottom, following
 * the shell. Radii are clamped to half the shorter side, so an overstated
 * corner bulges rather than inverting the path.
 */
export function roundedRectPath(x, y, w, h, radii) {
  const max = Math.min(w, h) / 2
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(Number(r) || 0, max)))
  const arc = (r, ex, ey) => (r ? `A${r} ${r} 0 0 1 ${ex} ${ey}` : '')
  return [
    `M${x + tl} ${y}`,
    `H${x + w - tr}`, arc(tr, x + w, y + tr),
    `V${y + h - br}`, arc(br, x + w - br, y + h),
    `H${x + bl}`, arc(bl, x, y + h - bl),
    `V${y + tl}`, arc(tl, x + tl, y),
    'Z',
  ].filter(Boolean).join(' ')
}

/** The shapes `data-shape` understands, in the order the error message lists them. */
export const SHAPES = ['rect', 'rounded', 'circle', 'hex']

/** The clip geometry for one shape inside the box, as SVG markup. */
export function shapeGeometry(shape, x, y, w, h, radius) {
  if (shape === 'circle') return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"/>`
  if (shape === 'hex') {
    const pts = [
      [x + w / 2, y], [x + w, y + h * 0.25], [x + w, y + h * 0.75],
      [x + w / 2, y + h], [x, y + h * 0.75], [x, y + h * 0.25],
    ]
    return `<polygon points="${pts.map(([px, py]) => `${px},${py}`).join(' ')}"/>`
  }
  const r = shape === 'rounded' ? radius : 0
  return `<path d="${roundedRectPath(x, y, w, h, [r, r, r, r])}"/>`
}

/** A `<defs>` carrying one clipPath, safe to emit as a sibling of what it clips. */
export const clipDefs = (id, geometry) => `<defs><clipPath id="${id}">${geometry}</clipPath></defs>`

/**
 * The CSS equivalent of `shapeGeometry`, for the HTML surface.
 *
 * `ellipse(50% 50%)` rather than `circle(50%)` on purpose: CSS derives a
 * circle's radius from the box diagonal, so on a non-square box it would crop
 * differently than the SVG `<ellipse>` does, and one vocabulary that means two
 * things across two surfaces is worse than no vocabulary at all.
 */
export function shapeCss(shape, radius) {
  if (shape === 'circle') return 'clip-path:ellipse(50% 50%)'
  if (shape === 'hex') return 'clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)'
  if (shape === 'rounded') return `border-radius:${radius}px;overflow:hidden`
  return ''
}
