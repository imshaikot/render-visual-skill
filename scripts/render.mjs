#!/usr/bin/env node
// Render an HTML canvas to a PNG with headless Chrome.
//
//   node scripts/render.mjs <input.html> <output.png> [--size WxH] [--scale N] [--theme name] [--transparent]
//
// --size  defaults to the `width: Npx; height: Mpx` declared on the input's <body>.
// --scale defaults to 2 (retina). The PNG comes out at W*scale x H*scale.
// --theme rewrites the template's themes/<name>.css link before rendering (in a temp
//         copy next to the input, so the source file is untouched).
// --transparent renders with an alpha background: the body's ground and the
//         glow/dots furniture are stripped, so the PNG drops onto any surface.
//
// Chrome is found automatically on macOS, Linux and Windows; CHROME_PATH overrides.

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertStylesheets, claimProfile, findChrome, shoot, sweepStaleCopies } from './chrome.mjs'

const args = process.argv.slice(2)
const BOOL_FLAGS = new Set(['--transparent'])
const positional = args.filter((a, i) => {
  const prev = args[i - 1] || ''
  return !a.startsWith('--') && !(prev.startsWith('--') && !BOOL_FLAGS.has(prev))
})
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const [input, output] = positional
if (!input || !output) {
  console.error('usage: render.mjs <input.html> <output.png> [--size WxH] [--scale N] [--theme name] [--transparent]')
  process.exit(1)
}

let html = readFileSync(resolve(input), 'utf8')

let size = opt('size')
if (!size) {
  const m = html.match(/width:\s*(\d+)px;\s*height:\s*(\d+)px/)
  if (!m) {
    console.error('No --size given and no "width: Npx; height: Mpx" found on the input body.')
    process.exit(1)
  }
  size = `${m[1]}x${m[2]}`
}
const [w, h] = size.split('x')
const scale = opt('scale') ?? '2'

const chrome = findChrome() // before the theme temp copy: it exits when no browser is found

let source = resolve(input)
const theme = opt('theme')
const transparent = args.includes('--transparent')
// Clear out copies a hard kill orphaned here on an earlier run.
sweepStaleCopies(dirname(resolve(input)))
if (theme) {
  // Tested, not diffed: rewriting ember.css to ember.css is a no-op too.
  const themeLink = /(themes\/)[a-z-]+(\.css)/
  if (!themeLink.test(html)) {
    console.error(`note: --theme ${theme} matched no themes/<name>.css link — rendering the page's own stylesheet.`)
  }
  html = html.replace(themeLink, `$1${theme}$2`)
}
if (transparent) {
  // Unpaint the ground and drop the ground-level furniture; everything else
  // (surfaces, shadows, text) keeps its own alpha and composites cleanly.
  html = html.replace(/<\/head>/i, '<style>body{background:transparent!important}.glow,.dots{display:none!important}</style></head>')
}
if (theme || transparent) {
  source = join(dirname(resolve(input)), `.render-${process.pid}.html`)
  writeFileSync(source, html)
  process.on('exit', () => rmSync(source, { force: true })) // covers Ctrl-C too
}

try {
  // The temp copy is a sibling of the input, so either way the input's
  // directory is what the page's relative links resolve against.
  assertStylesheets(html, dirname(resolve(input)))
  await shoot(chrome, pathToFileURL(source).href, output, w, h, scale, claimProfile(), null, transparent)
  console.log(`wrote ${output} (${w}x${h} @${scale}x = ${w * scale}x${h * scale}${transparent ? ', alpha' : ''})`)
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  if (source !== resolve(input)) rmSync(source, { force: true })
}
