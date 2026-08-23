#!/usr/bin/env node
// Render an HTML canvas to a PNG with headless Chrome.
//
//   node scripts/render.mjs <input.html> <output.png> [--size WxH] [--scale N] [--theme name] [--transparent]
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
import { assertPng, assertStylesheets, findChrome, makeWorkDir, reapOrphans, shootResilient, sweepStaleCopies } from './chrome.mjs'
import { fail, findThemeLink, parseArgs, readInput } from './cli.mjs'
import { describeImages, inlineImages } from './images.mjs'
import { assertPartClasses, inlineParts } from './parts.mjs'

const USAGE = 'render.mjs <input.html> <output.png> [--size WxH] [--scale N] [--theme name] [--transparent]'
const cli = parseArgs({ usage: USAGE, bool: ['transparent'], value: ['size', 'scale', 'theme'] })

const [input, output] = cli.positional
if (!input || !output) fail('Both an input .html and an output .png are required.', USAGE)

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

const chrome = findChrome() // before any copy is written: it exits when no browser is found

const theme = cli.theme() // already validated against the shipped set, or fatal
const transparent = cli.flag('transparent')

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

let source = inputFile
let workDir = null
if (theme || transparent || parts.used.length || images.used.length) {
  // A <base href> back at the input's directory keeps every other relative
  // reference on the page resolving exactly as it would in place.
  workDir = makeWorkDir()
  source = join(workDir, 'page.html')
  const base = `<base href="${pathToFileURL(inputDir).href}/">`
  writeFileSync(source, html.replace(/<head([^>]*)>/i, `<head$1>${base}`))
  process.on('exit', () => rmSync(workDir, { recursive: true, force: true })) // covers Ctrl-C too
}

try {
  // Checked against the input's directory either way: unthemed pages still link
  // their stylesheet relatively, and the <base href> above preserves that.
  assertStylesheets(html, inputDir)
  assertPartClasses(html, parts.used, inputDir)
  await shootResilient(chrome, pathToFileURL(source).href, output, w, h, scale, { transparent })
  // Dimensions are only asserted for integer scales: Chrome's own rounding at a
  // fractional device-scale factor is not worth a false failure over.
  assertPng(resolve(output), Number.isInteger(scale) ? { w: w * scale, h: h * scale } : null)
  console.log(`wrote ${output} (${w}x${h} @${scale}x = ${w * scale}x${h * scale}${transparent ? ', alpha' : ''})`)
  // Named, not counted: the cheapest way to notice you framed last week's
  // screenshot is to see its filename and pixel size in the log.
  for (const line of describeImages(images.used)) console.log(line)
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
}
