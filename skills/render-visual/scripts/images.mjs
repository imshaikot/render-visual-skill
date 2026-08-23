// Images in a figure: a screenshot inside a device frame, a photo cropped to a
// circle, a logo on a card, a full-bleed background.
//
//   <g data-part="el-browser" data-image="shot.png"/>     into the frame's screen
//   <image data-image="team.jpg" x=… y=… width=… height=… data-shape="circle"/>
//   <img src="logo.png" data-fit="contain">               plain HTML
//   <div data-image="hero.jpg">                           as a background
//   background-image: url(./texture.png)                  in a <style> block
//
// Every local source is read, format-sniffed and inlined as a data: URI on the
// temp copy before Chrome launches. That is the whole design, not an
// optimisation: an <image href> that resolves to nothing renders *nothing*, the
// frame around it still paints, and assertPng sees a perfectly inked figure —
// the exact "wrong image at exit 0" this pipeline exists to refuse. Resolving
// the bytes here turns every way that can fail into a fatal error with a path
// in it, and leaves the prepared page self-contained the way the inlined theme
// already is.
//
// The data-fit / data-align / data-shape vocabulary is opt-in. A plain
// `<img src="logo.png">` is inlined and otherwise left alone; nothing here
// restyles markup that did not ask for it.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHAPES, clipDefs, dropAttr, getAttr, mergeStyle, setAttr, shapeCss, shapeGeometry } from './markup.mjs'

/** One source this big is already past what a 2x canvas can use. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
/** And this much inlined makes a page Chrome spends real time just parsing. */
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024

export const FITS = ['cover', 'contain', 'stretch']
export const ALIGNS = ['center', 'top', 'bottom', 'left', 'right']
/** Every attribute this module consumes; all of them are stripped after use. */
export const IMAGE_ATTRS = ['data-image', 'data-fit', 'data-align', 'data-shape', 'data-radius']

// SVG says the same thing with preserveAspectRatio that CSS says with
// object-fit plus object-position, so both surfaces are driven from one pair of
// author-facing words.
const PAR_ALIGN = { center: 'xMidYMid', top: 'xMidYMin', bottom: 'xMidYMax', left: 'xMinYMid', right: 'xMaxYMid' }
const CSS_POSITION = { center: 'center', top: 'center top', bottom: 'center bottom', left: 'left center', right: 'right center' }
const CSS_OBJECT_FIT = { cover: 'cover', contain: 'contain', stretch: 'fill' }
const CSS_BG_SIZE = { cover: 'cover', contain: 'contain', stretch: '100% 100%' }

const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/* ── Format sniffing ────────────────────────────────────────────────────── */

const ascii = (b, from, to) => b.toString('latin1', from, to)

function jpegSize(b) {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue }
    const marker = b[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const len = b.readUInt16BE(i + 2)
    // SOF0..SOF15, minus the three in that range that are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
    }
    if (len < 2) break
    i += 2 + len
  }
  return {}
}

function webpSize(b) {
  const chunk = ascii(b, 12, 16)
  try {
    if (chunk === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 }
    if (chunk === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 }
    }
  } catch {}
  return {}
}

function svgSize(text) {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? ''
  const num = (name) => {
    const raw = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? ''
    const v = /^([\d.]+)/.exec(raw)?.[1]
    return v ? Number(v) : undefined
  }
  const w = num('width'), h = num('height')
  if (w && h) return { w, h }
  const vb = tag.match(/\bviewBox\s*=\s*"([^"]*)"/i)?.[1]?.trim().split(/[\s,]+/).map(Number)
  if (vb?.length === 4 && vb.every(Number.isFinite)) return { w: vb[2], h: vb[3] }
  return {}
}

/**
 * `{ mime, w, h }` for a format Chrome renders, `{ reject }` for one it does
 * not, or null for something that is not an image at all.
 *
 * Dimensions are best-effort — they go into the render's report and into the
 * error that tells you what `width`/`height` an `<image>` wants. The *format*
 * is the load-bearing part: a .png that is really a text file inlines as a
 * data: URI Chrome cannot decode, and draws a hole.
 */
export function sniffImage(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { mime: 'image/png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ...jpegSize(buf) }
  }
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') {
    return { mime: 'image/gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
  }
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ...webpSize(buf) }
  }
  if (ascii(buf, 0, 2) === 'BM' && buf.length >= 26) {
    return { mime: 'image/bmp', w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) }
  }
  if (ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12)
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif' }
    return {
      reject:
        `it is an ISO-BMFF image (brand "${brand}") — HEIC/HEIF and the like, which Chrome does not decode.\n` +
        '  Convert it first:  sips -s format png in.heic --out out.png   (macOS)\n' +
        '                     magick in.heic out.png                     (ImageMagick)',
    }
  }
  if (ascii(buf, 0, 4) === 'II*\0' || ascii(buf, 0, 4) === 'MM\0*') {
    return { reject: 'it is a TIFF, which Chrome does not decode. Convert it to PNG or JPEG first.' }
  }
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart()
  if (/^<(\?xml|svg\b)/i.test(head)) {
    return { mime: 'image/svg+xml', ...svgSize(buf.toString('utf8')) }
  }
  return null
}

/* ── Loading ────────────────────────────────────────────────────────────── */

const isRemote = (src) => /^(https?:)?\/\//i.test(src)
const isEmbedded = (src) => /^data:/i.test(src) || src.startsWith('#')

function describe(buf) {
  const head = buf.subarray(0, 64)
  const printable = head.toString('utf8').replace(/[^\x20-\x7e]/g, '.').slice(0, 48)
  return `first bytes ${[...head.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}  "${printable}"`
}

/**
 * Read one local source and encode it. Everything that can go wrong here is
 * fatal and names the path it resolved, because the alternative — an unreadable
 * source reaching Chrome as a broken reference — is a hole in an otherwise
 * finished figure.
 */
function loadImage(src, baseDir, onError) {
  let file
  if (/^file:/i.test(src)) {
    try { file = fileURLToPath(src) } catch { onError(`"${src}" is not a usable file: URL.`) }
  } else {
    file = resolve(baseDir, decodeURIComponent(src.split(/[?#]/)[0]))
  }
  if (!existsSync(file)) {
    onError(
      `Image not found: ${src}\n` +
        `  -> ${file}\n` +
        "  (a relative source resolves against the HTML file's own directory, not the working directory)",
    )
  }
  const stat = statSync(file)
  if (stat.isDirectory()) onError(`Image source is a directory: ${file}`)
  if (stat.size === 0) onError(`Image is empty (0 bytes): ${file}`)
  if (stat.size > MAX_IMAGE_BYTES) {
    onError(
      `Image is ${kb(stat.size)}, over the ${kb(MAX_IMAGE_BYTES)} ceiling: ${file}\n` +
        '  It is inlined into the page, so a source this large costs parse time for detail no canvas shows.\n' +
        '  Shrink it first:  sips -Z 2000 in.png --out small.png   (macOS)\n' +
        '                    magick in.png -resize 2000x small.png (ImageMagick)',
    )
  }
  const buf = readFileSync(file)
  const info = sniffImage(buf)
  if (!info) {
    onError(
      `Not an image this renderer recognises: ${file}\n` +
        `  ${describe(buf)}\n` +
        '  Supported: PNG, JPEG, GIF, WebP, AVIF, BMP, SVG. Inlining an unrecognised file would put a\n' +
        '  broken reference on the page, which renders as a hole in an otherwise correct figure.',
    )
  }
  if (info.reject) onError(`Cannot use ${file} —\n  ${info.reject}`)
  return {
    file,
    mime: info.mime,
    w: info.w || null,
    h: info.h || null,
    bytes: buf.length,
    // Unquoted in CSS on purpose: base64 and the data: prefix contain no
    // parenthesis, quote or space, so url(…) needs no delimiter — and a quote
    // here would have to survive being nested inside a style="…" attribute.
    dataUri: `data:${info.mime};base64,${buf.toString('base64')}`,
  }
}

/* ── The rewrite ────────────────────────────────────────────────────────── */

// Attribute soup that tolerates a `>` inside a quoted value.
const TAG_RE = /<([a-zA-Z][-\w]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '')

/**
 * Replace every image reference on the page with an inlined data: URI, and
 * apply the `data-fit` / `data-align` / `data-shape` vocabulary to whichever
 * surface carries it.
 *
 * Returns `{ html, used }`; `used` holds one entry per occurrence, which is what
 * the renderer reports so a wrong file is obvious from the log alone.
 */
export function inlineImages(html, baseDir, { onError = (m) => { throw new Error(m) } } = {}) {
  const used = []
  const cache = new Map()
  let total = 0
  let seq = 0

  const load = (src) => {
    if (!cache.has(src)) cache.set(src, loadImage(src, baseDir, onError))
    const img = cache.get(src)
    total += img.bytes
    if (total > MAX_TOTAL_BYTES) {
      onError(
        `The page's images come to ${kb(total)} inlined, over the ${kb(MAX_TOTAL_BYTES)} ceiling.\n` +
          '  Every source is embedded in the page Chrome parses. Use fewer, or shrink them first.',
      )
    }
    used.push({ src, ...img })
    return img
  }

  /**
   * True when this source is one to read from disk.
   *
   * A remote source is fatal where the markup *names an image to place* —
   * `data-image`, an `<img src>`, an `<image href>` — because a URL that 404s
   * or loads too slowly leaves an invisible hole in a figure that still
   * screenshots as a success, and nothing downstream can see it.
   *
   * In CSS it is passed through untouched instead. `url()` there is also how
   * every theme reaches `fonts.googleapis.com`, and a missing font degrades to
   * a substitute rather than to nothing — the same reason a remote `<link>`
   * is left to Chrome in assertStylesheets.
   */
  const needsLoading = (src, { strictRemote = true } = {}) => {
    if (isRemote(src)) {
      if (!strictRemote) return false
      onError(
        `Remote image source: ${src}\n` +
          '  Only images this renderer can read and verify are placed, because a URL that fails or\n' +
          '  loads too slowly leaves a hole in a figure that still screenshots as a success.\n' +
          `  Download it first:  curl -fsSL -o image.png "${src}"`,
      )
    }
    return !isEmbedded(src)
  }

  // Comment ranges, so a commented-out <img> is not resolved.
  const comments = [...html.matchAll(/<!--[\s\S]*?-->/g)].map((m) => [m.index, m.index + m[0].length])
  const inComment = (i) => comments.some(([a, b]) => i >= a && i < b)

  let out = ''
  let cursor = 0
  for (const m of html.matchAll(TAG_RE)) {
    const name = m[1].toLowerCase()
    const hasDataImage = /\sdata-image\s*=/i.test(m[0])
    if (!hasDataImage && name !== 'img' && name !== 'image') continue
    if (inComment(m.index)) continue

    let tag = m[0]
    const srcAttr = hasDataImage ? 'data-image'
      : name === 'img' ? 'src'
      : getAttr(tag, 'href') !== undefined ? 'href' : 'xlink:href'
    const src = getAttr(tag, srcAttr)
    if (hasDataImage && !src) onError('data-image="" is empty — give it a path to an image file.')
    if (!src) continue // an <img>/<image> with no source at all: not ours to fix

    const at = `${srcAttr}="${src}"`
    const pick = (attr, allowed, fallback) => {
      const v = getAttr(tag, attr)
      if (v === undefined) return fallback
      if (!allowed.includes(v)) onError(`${attr}="${v}" on ${at} is not one of: ${allowed.join(', ')}.`)
      return v
    }
    // The vocabulary is opt-in: markup that asked for nothing is inlined and
    // otherwise left exactly as written.
    const styled = hasDataImage || IMAGE_ATTRS.some((a) => getAttr(tag, a) !== undefined)
    const fit = pick('data-fit', FITS, 'cover')
    const align = pick('data-align', ALIGNS, 'center')
    const shape = pick('data-shape', SHAPES, null)
    const radiusRaw = getAttr(tag, 'data-radius')
    const radius = radiusRaw === undefined ? 16 : Number(radiusRaw)
    if (!Number.isFinite(radius) || radius < 0) onError(`data-radius="${radiusRaw}" on ${at} must be a number >= 0.`)

    const img = needsLoading(src) ? load(src) : { dataUri: src, mime: null, w: null, h: null, bytes: 0 }
    let defs = ''

    if (name === 'image') {
      // SVG. Width and height are required rather than inferred: an <image>
      // sized only by its intrinsic dimensions is a coin flip across Chrome
      // versions, and the losing side of that flip is an invisible image inside
      // a frame that drew perfectly.
      const wAttr = getAttr(tag, 'width')
      const hAttr = getAttr(tag, 'height')
      if (wAttr === undefined || hAttr === undefined) {
        const hint = img.w && img.h
          ? `  It is ${img.w}x${img.h}, so width="${img.w}" height="${img.h}" is its natural size.`
          : '  Give it the box you want it to fill; data-fit decides how it fills it.'
        onError(`<image ${at}> needs both a width and a height.\n${hint}`)
      }
      if (shape && shape !== 'rect') {
        const box = [getAttr(tag, 'x') ?? 0, getAttr(tag, 'y') ?? 0, wAttr, hAttr].map(Number)
        if (!box.every(Number.isFinite)) {
          onError(`data-shape="${shape}" on ${at} needs numeric x/y/width/height on the <image> to crop against.`)
        }
        const id = `rv-clip-${++seq}`
        defs = clipDefs(id, shapeGeometry(shape, ...box, radius))
        tag = setAttr(tag, 'clip-path', `url(#${id})`)
      }
      if (styled) {
        tag = setAttr(tag, 'preserveAspectRatio', fit === 'stretch' ? 'none' : `${PAR_ALIGN[align]} ${fit === 'cover' ? 'slice' : 'meet'}`)
      }
    } else if (name === 'img') {
      if (styled) {
        tag = mergeStyle(tag, [
          `object-fit:${CSS_OBJECT_FIT[fit]}`,
          `object-position:${CSS_POSITION[align]}`,
          shapeCss(shape ?? 'rect', radius),
        ].filter(Boolean).join(';'))
      }
    } else {
      // Anything else carrying data-image gets it as a background, which is how
      // a full-bleed HTML hero or a textured panel is written.
      tag = mergeStyle(tag, [
        `background-image:url(${img.dataUri})`,
        `background-size:${CSS_BG_SIZE[fit]}`,
        `background-position:${CSS_POSITION[align]}`,
        'background-repeat:no-repeat',
        shapeCss(shape ?? 'rect', radius),
      ].filter(Boolean).join(';'))
    }

    // Set the source last: every regex above then runs over a short tag rather
    // than one carrying a megabyte of base64.
    if (name === 'image') tag = setAttr(dropAttr(tag, 'xlink:href'), 'href', img.dataUri)
    else if (name === 'img') tag = setAttr(tag, 'src', img.dataUri)

    for (const a of IMAGE_ATTRS) tag = dropAttr(tag, a)
    out += html.slice(cursor, m.index) + defs + tag
    cursor = m.index + m[0].length
  }
  out += html.slice(cursor)

  // url() in stylesheets and style attributes, but nowhere else: code.html
  // renders CSS *as content*, and a snippet containing url(./x.png) is text on
  // a slide, not a reference this pipeline should try to resolve.
  const rewriteCss = (css) =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _q, ref) => {
      const src = ref.trim()
      return needsLoading(src, { strictRemote: false }) ? `url(${load(src).dataUri})` : whole
    })
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, body, close) => open + rewriteCss(body) + close)
  out = out.replace(/\sstyle=("([^"]*)"|'([^']*)')/gi, (whole, _q, dq, sq) => {
    const v = dq ?? sq
    if (!v.includes('url(')) return whole
    return dq !== undefined ? ` style="${rewriteCss(v)}"` : ` style='${rewriteCss(v)}'`
  })

  // The backstop. Every element type above is handled, so a survivor means the
  // tag scanner did not see this one — and an unresolved data-image renders as
  // nothing at all, which is precisely the failure this module exists to make
  // impossible.
  if (/\sdata-image\s*=/i.test(stripComments(out))) {
    onError('A data-image attribute survived the rewrite unresolved — it would render as nothing. Simplify the tag it sits on and re-run.')
  }
  return { html: out, used }
}

/** One line per distinct source, for the renderer's report. */
export function describeImages(used) {
  const byFile = new Map()
  for (const u of used) {
    const e = byFile.get(u.file) ?? { ...u, count: 0 }
    e.count++
    byFile.set(u.file, e)
  }
  return [...byFile.values()].map((u) => {
    const dims = u.w && u.h ? `${u.w}x${u.h}` : 'size unknown'
    const fmt = (u.mime ?? '').replace('image/', '').replace('svg+xml', 'svg')
    return `  image ${u.src} (${dims} ${fmt}, ${kb(u.bytes)})${u.count > 1 ? ` x${u.count}` : ''}`
  })
}
