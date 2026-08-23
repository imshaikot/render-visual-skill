// Element includes: <g data-part="el-database" transform="translate(70,452)"/>
//
// Every part in parts/ is one <g> anchored at its own top-left, built purely
// from theme tokens. A figure references one instead of carrying a copy of its
// geometry, so the parts sheet stays the single definition of each shape —
// templates/elements.html is itself rendered through this, which is what keeps
// the sheet and the parts from drifting.
//
// A framing part additionally declares the rectangle its content sits in, as
// `data-screen="x y w h tl tr br bl"` on its root <g>. `data-image` at the call
// site fills exactly that rectangle — see screenOverlay below.
//
// Substitution happens on the temp copy, pre-launch, and every way it can go
// wrong is fatal: an unknown id, an accent that is not 1-4, a page missing the
// CSS the part needs. That last one is the reason this file is not a ten-line
// string replace — a part whose utility classes are undefined still renders,
// as invisible or unstroked shapes on an otherwise perfect PNG.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SKILL_ROOT, distance } from './cli.mjs'
import { ALIGNS, FITS } from './images.mjs'
import { clipDefs, roundedRectPath } from './markup.mjs'

export const PARTS_DIR = join(SKILL_ROOT, 'parts')

/** Every part the skill ships, by bare id, sorted. */
export function listParts(dir = PARTS_DIR) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.slice(0, -4))
      .sort()
  } catch {
    return []
  }
}

/** Attributes of an opening tag, in source order. */
function parseAttrs(tag) {
  const attrs = new Map()
  for (const [, name, value] of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"/g)) attrs.set(name, value)
  return attrs
}

const serializeAttrs = (attrs) =>
  [...attrs].map(([k, v]) => ` ${k}="${v}"`).join('')

/**
 * Rewrite accent classes inside class attributes only.
 *
 * Never over the whole string: `s` and `S` are path commands, so a d="..." can
 * legitimately contain `s1` and a global replace would silently bend the shape.
 */
function recolor(svg, accent) {
  return svg.replace(/class="([^"]*)"/g, (_, cls) => {
    const swapped = cls
      .split(/\s+/)
      .map((c) => (c === 's1' ? `s${accent}` : c === 'f1' ? `f${accent}` : c))
      .join(' ')
    return `class="${swapped}"`
  })
}

/** Index of the `</g>` closing the `<g>` that opens at `from`, nesting-aware. */
function findClose(html, from) {
  let depth = 0
  const re = /<g\b[^>]*?(\/?)>|<\/g\s*>/g
  re.lastIndex = from
  for (let m; (m = re.exec(html)); ) {
    if (m[0].startsWith('</')) {
      if (--depth === 0) return { start: m.index, end: re.lastIndex }
    } else if (!m[1]) depth++
  }
  return null
}

/** Every part that declares a screen an image can go into, by bare id, sorted. */
export function listScreenParts(dir = PARTS_DIR) {
  return listParts(dir).filter((id) => /\bdata-screen\s*=/.test(readFileSync(join(dir, `${id}.svg`), 'utf8')))
}

/**
 * The markup that drops an image into a frame's declared screen.
 *
 * Three pieces, and each earns its place: a clip path, because a screen follows
 * the shell's corners and a plain rect would square them off; an opaque
 * backdrop, because `data-fit="contain"` letterboxes and the part's own
 * skeleton bars would otherwise show through the bars; and the `<image>` itself,
 * left unresolved for images.mjs to inline so that both this and a hand-written
 * `<image data-image>` go through one loader and one set of guards.
 *
 * The backdrop takes its colour from `var(--ground)` in an inline style rather
 * than a utility class: a class would have to be defined by whatever page the
 * part lands on, and assertPartClasses can only see classes the part file
 * itself carries.
 */
function screenOverlay(id, screen, src, fit, align, seq, onError) {
  const nums = screen.trim().split(/[\s,]+/).map(Number)
  if (nums.length !== 8 || !nums.every(Number.isFinite)) {
    onError(`Part "${id}" has a malformed data-screen="${screen}" — it must be 8 numbers: x y w h tl tr br bl.`)
  }
  const [x, y, w, h, tl, tr, br, bl] = nums
  const clip = `rv-screen-${seq}`
  return (
    clipDefs(clip, `<path d="${roundedRectPath(x, y, w, h, [tl, tr, br, bl])}"/>`) +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" clip-path="url(#${clip})" style="fill:var(--ground)"/>` +
    `<image data-image="${src}" data-fit="${fit}" data-align="${align}" ` +
    `x="${x}" y="${y}" width="${w}" height="${h}" clip-path="url(#${clip})"/>`
  )
}

/**
 * Replace every `<g data-part="id" …>` with the part's markup.
 *
 * Call-site attributes win over the part's own, except `class`, which is
 * unioned — dropping `glyph` off a glyph by writing `class="s3"` would render a
 * filled blob instead of a stroked icon, so the recolor knob is `data-accent`
 * and a second accent class in the union is fatal rather than left to CSS
 * source order. Content inside the call site is kept, after the part's, so a
 * caption can ride along with the shape it labels.
 *
 * `data-image` at the call site fills the part's declared screen, if it has one.
 */
export function inlineParts(html, { dir = PARTS_DIR, onError = (m) => { throw new Error(m) } } = {}) {
  const used = new Set()
  const available = listParts(dir)
  let out = ''
  let cursor = 0
  let screens = 0
  const open = /<g\b[^>]*\bdata-part\s*=\s*"([^"]*)"[^>]*?(\/?)>/g

  for (let m; (m = open.exec(html)); ) {
    const [tag, id, selfClosing] = m
    if (!available.includes(id)) {
      const near = available.map((p) => [p, distance(id, p)]).sort((x, y) => x[1] - y[1])[0]
      onError(
        `Unknown part "${id}".\n` +
          (near && near[1] <= 3 ? `  Did you mean "${near[0]}"?\n` : '') +
          `  Available (${available.length}): ${available.join(', ') || '(none found — is parts/ missing?)'}`,
      )
    }

    const attrs = parseAttrs(tag)
    const accentRaw = attrs.get('data-accent')
    const imageSrc = attrs.get('data-image')
    const fit = attrs.get('data-fit') ?? 'cover'
    const align = attrs.get('data-align') ?? 'center'
    for (const a of ['data-part', 'data-accent', 'data-image', 'data-fit', 'data-align', 'data-shape', 'data-radius']) attrs.delete(a)
    if (imageSrc === undefined) {
      for (const a of ['data-fit', 'data-align']) {
        if (tag.includes(`${a}=`)) onError(`data-part="${id}" has ${a} but no data-image, so it does nothing.`)
      }
    } else {
      if (!imageSrc) onError(`data-part="${id}" has an empty data-image — give it a path to an image file.`)
      if (!FITS.includes(fit)) onError(`data-fit="${fit}" on data-part="${id}" is not one of: ${FITS.join(', ')}.`)
      if (!ALIGNS.includes(align)) onError(`data-align="${align}" on data-part="${id}" is not one of: ${ALIGNS.join(', ')}.`)
      if (/\bdata-(shape|radius)=/.test(tag)) {
        onError(
          `data-part="${id}" carries data-shape/data-radius, which belong on an <image> or <img>.\n` +
            "  A frame crops to its own screen; the shell's corners are the shape.",
        )
      }
    }
    if (accentRaw !== undefined && !['1', '2', '3', '4'].includes(accentRaw)) {
      onError(`data-part="${id}" has data-accent="${accentRaw}" — it must be 1, 2, 3 or 4 (see the accent semantics table).`)
    }

    let part = readFileSync(join(dir, `${id}.svg`), 'utf8').replace(/<!--[\s\S]*?-->\s*/g, '')
    if (accentRaw && new RegExp(`class="[^"]*\\b[sf]${accentRaw}\\b`).test(part)) {
      // Charts carry a1..a4 as categorical series, and el-server's LEDs are f4
      // on purpose. Folding s1/f1 onto an index the part already uses would
      // merge two things it draws as distinct — a plausible, wrong picture.
      onError(
        `data-part="${id}" already uses accent ${accentRaw}, so data-accent="${accentRaw}" would merge two\n` +
          '  things the part draws as different. Pick another accent, or copy the part in and edit it.',
      )
    }
    const rootOpen = /<g\b[^>]*>/.exec(part)
    if (!rootOpen) onError(`Part "${id}" has no root <g> — parts/${id}.svg is malformed.`)
    const rootAttrs = parseAttrs(rootOpen[0])
    let body = part.slice(rootOpen.index + rootOpen[0].length, part.lastIndexOf('</g>'))
    if (accentRaw) {
      body = recolor(body, accentRaw)
      if (rootAttrs.has('class')) rootAttrs.set('class', recolor(`class="${rootAttrs.get('class')}"`, accentRaw).slice(7, -1))
    }

    const screen = rootAttrs.get('data-screen')
    rootAttrs.delete('data-screen') // machine-readable metadata, never markup
    if (imageSrc !== undefined) {
      if (!screen) {
        const framed = listScreenParts(dir)
        onError(
          `data-part="${id}" has no screen for an image to go into.\n` +
            `  Parts that do (${framed.length}): ${framed.join(', ') || '(none)'}\n` +
            '  For any other shape, place an <image data-image="..." x y width height> yourself.',
        )
      }
      // Appended to the part's own markup, so the screen covers the skeleton
      // content the frame ships with rather than fighting it for z-order.
      body += screenOverlay(id, screen, imageSrc, fit, align, ++screens, onError)
    }

    // merge: part's attributes first, call site overrides, class unioned
    const merged = new Map(rootAttrs)
    for (const [k, v] of attrs) {
      if (k !== 'class') merged.set(k, v)
      else {
        const union = [...new Set([...(rootAttrs.get('class') ?? '').split(/\s+/), ...v.split(/\s+/)])].filter(Boolean)
        for (const family of ['s', 'f']) {
          const accents = union.filter((c) => new RegExp(`^${family}[1-4]$`).test(c))
          if (accents.length > 1) {
            onError(
              `data-part="${id}" would carry two accent classes (${accents.join(' and ')}).\n` +
                `  Which one wins is CSS source order, not intent. Recolor with data-accent="N" instead.`,
            )
          }
        }
        merged.set('class', union.join(' '))
      }
    }

    // keep whatever the call site wrapped around the include
    let inner = ''
    let endOfCall = m.index + tag.length
    if (!selfClosing) {
      const close = findClose(html, m.index)
      if (!close) onError(`data-part="${id}" opens a <g> that is never closed.`)
      inner = html.slice(m.index + tag.length, close.start)
      endOfCall = close.end
    }

    out += html.slice(cursor, m.index) + `<g${serializeAttrs(merged)}>${body}${inner}</g>`
    cursor = endOfCall
    open.lastIndex = endOfCall
    used.add(id)
  }
  out += html.slice(cursor)

  // One pass only. Anything still carrying the attribute would reach Chrome as a
  // literal <g data-part> — an empty group, rendering nothing, inside a figure
  // that otherwise screenshots perfectly.
  if (used.size && /\bdata-part\s*=/.test(out)) {
    onError(
      'An include was left unresolved: a data-part survived substitution.\n' +
        '  Includes are not recursive, so this is one of three things:\n' +
        '    · a part nested INSIDE another part\'s call site — place the part, then draw its\n' +
        '      contents in a sibling <g> on the same origin (templates/deployment.html does this)\n' +
        '    · a part file that references another part — inline the inner one into it\n' +
        '    · prose that spells the attribute out in escaped text — reword it',
    )
  }
  return { html: out, used: [...used].sort() }
}

/** Every class token the given parts put on the page. */
function classesOf(ids, dir = PARTS_DIR) {
  const seen = new Set()
  for (const id of ids) {
    const svg = readFileSync(join(dir, `${id}.svg`), 'utf8')
    for (const [, cls] of svg.matchAll(/class="([^"]*)"/g)) for (const c of cls.split(/\s+/)) if (c) seen.add(c)
  }
  return [...seen].sort()
}

/** Every stylesheet the page carries: inline blocks plus resolvable local links. */
function pageCss(html, baseDir) {
  let css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel=["']?stylesheet\b/i.test(tag)) continue
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1]
    if (!href || /^(https?:)?\/\/|^data:/i.test(href)) continue
    const file = resolve(baseDir, href.split(/[?#]/)[0])
    if (existsSync(file)) css += '\n' + readFileSync(file, 'utf8')
  }
  return css
}

/**
 * A part whose utility classes the page never defines renders as unstroked,
 * unfilled, or invisible geometry — a defect assertPng cannot see, because the
 * rest of the figure paints normally. Catch it before Chrome launches.
 */
export function assertPartClasses(html, used, baseDir, dir = PARTS_DIR) {
  if (!used.length) return
  const css = pageCss(html, baseDir)
  const missing = classesOf(used, dir).filter((c) => !new RegExp(`\\.${c}\\b`).test(css))
  if (!missing.length) return
  throw new Error(
    `The page defines no CSS for ${missing.map((c) => `.${c}`).join(', ')}, which ${used.join(', ')} rely on.\n` +
      '  Parts carry no colour of their own, so undefined classes render as invisible or unstroked\n' +
      '  shapes on an otherwise perfect PNG. Add these to the page <style>:\n\n' +
      declarationsFor(missing).map((l) => `    ${l}`).join('\n'),
  )
}

/**
 * The real declarations for the missing classes, lifted from the reference
 * template rather than written out here — a hard-coded block in this message
 * would be one more copy to drift, and it silently would not cover a class a
 * new part starts using.
 */
function declarationsFor(missing) {
  let reference = ''
  try {
    reference = readFileSync(join(SKILL_ROOT, 'templates', 'diagram.html'), 'utf8')
  } catch {
    return missing.map((c) => `.${c} { /* see templates/diagram.html */ }`)
  }
  const out = []
  for (const c of missing) {
    const rules = [...reference.matchAll(new RegExp(`\\.${c}\\s*\\{[^}]*\\}`, 'g'))].map((m) => m[0])
    out.push(rules.length ? rules.join(' ') : `.${c} { /* not in templates/diagram.html — define it */ }`)
  }
  return out
}
