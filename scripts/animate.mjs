#!/usr/bin/env node
// Animate a stepped canvas (e.g. templates/sequence.html) into a looping GIF.
// One frame per data-step, rendered by headless Chrome, assembled in pure Node.
//
//   node scripts/animate.mjs <input.html> <output.gif>
//        [--theme name] [--scale 1] [--size WxH] [--delay 900] [--hold 2600] [--keep-frames]
//
// --delay is ms per step; --hold is ms on the final, complete frame.
// --scale defaults to 1 for GIFs — at 2x a 1360x740 animation gets very heavy.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findChrome, shoot } from './chrome.mjs'
import { decodePng, encodeGif } from './gif.mjs'

const args = process.argv.slice(2)
const positional = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'))
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const flag = (name) => args.includes(`--${name}`)

const [input, output] = positional
if (!input || !output) {
  console.error('usage: animate.mjs <input.html> <output.gif> [--theme name] [--scale 1] [--size WxH] [--delay 900] [--hold 2600] [--keep-frames]')
  process.exit(1)
}

let html = readFileSync(resolve(input), 'utf8')

const steps = [...html.matchAll(/data-step="(\d+)"/g)].map((m) => Number(m[1]))
if (!steps.length) {
  console.error('No data-step attributes found — nothing to animate. See templates/sequence.html.')
  process.exit(1)
}
const maxStep = Math.max(...steps)

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
const scale = opt('scale') ?? '1'
const delayMs = Number(opt('delay') ?? 900)
const holdMs = Number(opt('hold') ?? 2600)

let source = resolve(input)
const theme = opt('theme')
if (theme) {
  html = html.replace(/(themes\/)[a-z-]+(\.css)/, `$1${theme}$2`)
  source = join(dirname(resolve(input)), `.render-${process.pid}.html`)
  writeFileSync(source, html)
}

const chrome = findChrome()
const frameDir = mkdtempSync(join(tmpdir(), 'rendercraft-frames-'))
const frames = []

try {
  for (let step = 1; step <= maxStep; step++) {
    const png = join(frameDir, `frame-${String(step).padStart(2, '0')}.png`)
    await shoot(chrome, `${pathToFileURL(source).href}?step=${step}`, png, w, h, scale)
    frames.push(decodePng(readFileSync(png)))
    console.log(`frame ${step}/${maxStep}`)
  }

  const gif = encodeGif(frames, { delayMs, holdMs })
  writeFileSync(resolve(output), gif)
  console.log(`wrote ${output} (${frames[0].width}x${frames[0].height}, ${frames.length} frames, ${(gif.length / 1024).toFixed(0)} KB, ${delayMs}ms/step, loops)`)
  if (flag('keep-frames')) console.log(`frames kept in ${frameDir}`)
} finally {
  if (theme) rmSync(source, { force: true })
  if (!flag('keep-frames')) rmSync(frameDir, { recursive: true, force: true })
}
