#!/usr/bin/env node
// Render an HTML canvas to a PNG, JPEG or PDF with headless Chrome.
//
//   node scripts/render.mjs <input.html> <output.(png|jpg|pdf)> [--size WxH] [--scale N] [--theme name] [--format name] [--transparent]
//
// --format defaults to whatever the output file's extension names. PNG is the
//         master: a JPEG is transcoded from a PNG that already passed the
//         content guard, and a PDF is printed in the same Chrome launch as a
//         proof shot that does. Neither can reach disk on pixels nobody looked
//         at. PDF is vector, so it takes no --scale, and neither format takes
//         --transparent.
//
// --size  defaults to the `width: Npx; height: Mpx` declared on the input's <body>.
// --scale defaults to 2 (retina). The PNG comes out at W*scale x H*scale.
// --theme inlines one of the skill's own themes/<name>.css into a copy of the
//         page, so the source file is untouched and no themes/ directory has to
//         sit beside the figure. An unknown name, or a page with no theme link
//         to replace, is fatal — never a note followed by the wrong colours.
// --transparent renders with an alpha background: the body's ground and the
//         glow/dots furniture are stripped, so the PNG drops onto any surface.
//
// <g data-part="el-database"/> anywhere in the page is replaced with that
// part's markup from parts/ before the render. Unknown ids are fatal.
//
// Local images — <img src>, <image data-image>, data-image on a framing part or
// any other element, url() in a stylesheet — are read, format-checked and
// inlined as data: URIs before the render. A source that cannot be read is
// fatal: it would draw nothing at all inside a figure that still screenshots
// as a success.
//
// Chrome is found automatically on macOS, Linux and Windows; CHROME_PATH overrides.

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertJpeg, assertPdf, assertPng, assertStylesheets, findChrome, makeWorkDir, reapOrphans, shootResilient, sweepStaleCopies } from './chrome.mjs'
import { fail, findThemeLink, parseArgs, readInput } from './cli.mjs'
import { describeImages, inlineImages } from './images.mjs'
import { assertPartClasses, inlineParts } from './parts.mjs'

const USAGE =
  'render.mjs <input.html> <output.(png|jpg|pdf)> [--size WxH] [--scale N] [--theme name] [--format png|jpeg|pdf] [--transparent]'
const cli = parseArgs({ usage: USAGE, bool: ['transparent'], value: ['size', 'scale', 'theme', 'format'] })

const [input, output] = cli.positional
if (!input || !output) fail('Both an input .html and an output file are required.', USAGE)
const format = cli.format(output) // fatal when the flag and the extension disagree

const inputFile = readInput(input)
const inputDir = dirname(inputFile)
let html = readFileSync(inputFile, 'utf8')

let size = cli.size()
if (!size) {
  const m = html.match(/width:\s*(\d+)px;\s*height:\s*(\d+)px/)
  if (!m) fail('No --size given and no "width: Npx; height: Mpx" found on the input body.', USAGE)
  size = { w: Number(m[1]), h: Number(m[2]) }
}
const { w, h } = size
const scale = cli.scale()
const scaleGiven = cli.opt('scale') !== undefined

const chrome = findChrome() // before any copy is written: it exits when no browser is found

const theme = cli.theme() // already validated against the shipped set, or fatal
const transparent = cli.flag('transparent')

// Refused, not ignored. A flag that quietly does nothing is how you get a file
// that is not what was asked for and says nothing about it.
if (format === 'pdf' && scaleGiven) {
  fail(
    '--scale has no meaning for a PDF: it is vector, and already resolution-independent at any zoom.\n' +
      '  Size the page with --size (or the body\'s width/height declaration) and drop --scale.',
    USAGE,
  )
}
if (transparent && format !== 'png') {
  fail(
    format === 'jpeg'
      ? '--transparent cannot apply to a JPEG: the format has no alpha channel, so the ground would come out black.\n' +
        '  Render a PNG for transparency, or drop --transparent.'
      : '--transparent cannot apply to a PDF: print-to-pdf always paints an opaque page.\n' +
        '  Render a PNG for transparency, or drop --transparent.',
    USAGE,
  )
}

// Clear out copies a hard kill orphaned on an earlier run, and put the temp dir
// into a known state: an orphaned Chrome from an interrupted run holds its
// profile's singleton, and every render on that slot fails until it is gone.
sweepStaleCopies(inputDir)
reapOrphans()

if (theme) {
  const tag = findThemeLink(html)
  if (!tag) {
    fail(
      `--theme ${theme.name} found no theme stylesheet to replace in ${input}.\n` +
        '  A themeable page links either themes/<name>.css or a bare ./<name>.css.\n' +
        '  Rendering it unthemed would silently produce the wrong colours, so this is fatal.',
    )
  }
  // Inlined, not relinked: the page then carries its own tokens and renders the
  // same from any directory, which is what lets the copy live in the temp dir.
  html = html.replace(tag, `<style>\n${readFileSync(theme.file, 'utf8')}\n</style>`)
}

// Parts are inlined after the theme so the CSS check below sees the whole
// stylesheet the page will actually render with.
const parts = inlineParts(html, { onError: (m) => fail(m) })
html = parts.html

// Images last, so a part's screen overlay is inlined through the same loader as
// a hand-written <image data-image> and gets the same guards.
const images = inlineImages(html, inputDir, { onError: (m) => fail(m) })
html = images.html

if (transparent) {
  // Unpaint the ground and drop the ground-level furniture; everything else
  // (surfaces, shadows, text) keeps its own alpha and composites cleanly.
  if (!/<\/head>/i.test(html)) fail('--transparent needs a <head> to inject into, and the input has none.')
  html = html.replace(/<\/head>/i, '<style>body{background:transparent!important}.glow,.dots{display:none!important}</style></head>')
}

if (format === 'pdf') {
  // Without this Chrome ignores the canvas and lays the figure out on US Letter,
  // cropped to fit, at exit 0. assertPdf checks the box that this rule sets.
  if (!/<\/head>/i.test(html)) fail('--format pdf needs a <head> to inject its @page rule into, and the input has none.')
  html = html.replace(/<\/head>/i, `<style>@page{size:${w}px ${h}px;margin:0}</style></head>`)
}

let source = inputFile
let workDir = null
// A content guard that fires on a proof or a master names that file in its
// message, and the file lives in the work dir. Deleting it on the way out would
// make the message a lie, so a guard failure keeps the dir — the next render
// reaps it, because it is tagged with a pid that is gone by then.
let keepWorkDir = false
// JPEG and PDF always need the temp dir: one to stage its master, the other to
// stage the proof shot that vouches for it.
if (theme || transparent || format !== 'png' || parts.used.length || images.used.length) {
  // A <base href> back at the input's directory keeps every other relative
  // reference on the page resolving exactly as it would in place.
  workDir = makeWorkDir()
  source = join(workDir, 'page.html')
  const base = `<base href="${pathToFileURL(inputDir).href}/">`
  writeFileSync(source, html.replace(/<head([^>]*)>/i, `<head$1>${base}`))
  process.on('exit', () => { if (!keepWorkDir) rmSync(workDir, { recursive: true, force: true }) }) // covers Ctrl-C too
}

try {
  // Checked against the input's directory either way: unthemed pages still link
  // their stylesheet relatively, and the <base href> above preserves that.
  assertStylesheets(html, inputDir)
  assertPartClasses(html, parts.used, inputDir)
  const pageUrl = pathToFileURL(source).href
  // Dimensions are only asserted for integer scales: Chrome's own rounding at a
  // fractional device-scale factor is not worth a false failure over.
  const expect = Number.isInteger(scale) ? { w: w * scale, h: h * scale } : null

  if (format === 'png') {
    await shootResilient(chrome, pageUrl, output, w, h, scale, { transparent })
    assertPng(resolve(output), expect)
    console.log(`wrote ${output} (${w}x${h} @${scale}x = ${w * scale}x${h * scale}${transparent ? ', alpha' : ''})`)
  } else if (format === 'pdf') {
    // One launch, two outputs. The shot is never delivered — it exists so the
    // blank-render guard has pixels to judge the PDF's page by.
    const proof = join(workDir, 'proof.png')
    await shootResilient(chrome, pageUrl, proof, w, h, 1, { pdf: resolve(output) })
    try {
      assertPng(proof, { w, h })
    } catch (err) {
      keepWorkDir = true
      // The PDF is on disk by now — Chrome writes both or neither. Say so, or a
      // non-zero exit sitting next to a plausible-looking file reads as a fluke.
      err.message += `\n  ${output} came off the same layout and is rejected with it.`
      throw err
    }
    const box = assertPdf(resolve(output), { w, h })
    const pt = box.width === null ? 'page size unverified' : `${box.width.toFixed(0)}x${box.height.toFixed(0)}pt`
    console.log(`wrote ${output} (${w}x${h} css px = ${pt}, pdf, 1 page)`)
  } else {
    // The master is a real PNG through the real guard; the second pass only
    // re-encodes it. Chrome will write a JPEG straight from --screenshot, but
    // then nothing has decoded the pixels and a blank figure ships at exit 0.
    const master = join(workDir, 'master.png')
    await shootResilient(chrome, pageUrl, master, w, h, scale)
    let mw, mh
    try {
      ;({ width: mw, height: mh } = assertPng(master, expect))
    } catch (err) {
      keepWorkDir = true
      throw err
    }
    const transcode = join(workDir, 'transcode.html')
    writeFileSync(transcode, [
      '<!doctype html><html><head><meta charset="utf-8"><style>',
      `html,body{margin:0;padding:0;background:#fff}img{display:block;width:${mw}px;height:${mh}px}`,
      '</style></head><body><img src="data:image/png;base64,',
      readFileSync(master).toString('base64'),
      '"></body></html>',
    ].join(''))
    // Window exactly the master's pixel size at scale 1, so the image maps one
    // to one and the only thing the pass changes is the encoding.
    await shootResilient(chrome, pathToFileURL(transcode).href, output, mw, mh, 1)
    assertJpeg(resolve(output), { w: mw, h: mh })
    console.log(`wrote ${output} (${w}x${h} @${scale}x = ${mw}x${mh}, jpeg)`)
  }
  // Named, not counted: the cheapest way to notice you framed last week's
  // screenshot is to see its filename and pixel size in the log.
  for (const line of describeImages(images.used)) console.log(line)
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  if (workDir && !keepWorkDir) rmSync(workDir, { recursive: true, force: true })
}
