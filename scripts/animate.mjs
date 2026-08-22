#!/usr/bin/env node
// Animate a stepped canvas (e.g. templates/sequence.html) into a looping GIF.
// Each step is revealed with a short tween (several frames at --fps), then
// dwells --delay ms; frames render in parallel Chrome instances and are
// assembled in pure Node with inter-frame delta encoding.
//
//   node scripts/animate.mjs <input.html> <output.gif>
//        [--theme name] [--scale 1] [--size WxH] [--fx slide|fade|pop]
//        [--fps 25] [--transition 450] [--delay 900] [--hold 2600]
//        [--jobs 4] [--keep-frames]
//
// --transition is ms of tween per step reveal (0 = old one-frame-per-step look);
// --delay is ms of dwell on each completed step; --hold replaces the dwell on
// the final, complete frame. GIF timing is in 10ms units, so fps values that
// divide 100 (20, 25, 50) play back exactly; 50 is the format's ceiling.
// --scale defaults to 1 for GIFs — at 2x a 1360x740 animation gets very heavy.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertStylesheets, findChrome, reapOrphans, shootResilient, sweepStaleCopies } from './chrome.mjs'
import { decodePng, encodeGif } from './gif.mjs'

const args = process.argv.slice(2)
const BOOL_FLAGS = new Set(['--keep-frames'])
const positional = args.filter((a, i) => {
  const before = args[i - 1] || ''
  return !a.startsWith('--') && !(before.startsWith('--') && !BOOL_FLAGS.has(before))
})
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const flag = (name) => args.includes(`--${name}`)
const num = (name, def) => {
  const v = opt(name)
  if (v === undefined) return def
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) {
    console.error(`--${name} needs a non-negative number, got "${v}"`)
    process.exit(1)
  }
  return n
}

const [input, output] = positional
if (!input || !output) {
  console.error('usage: animate.mjs <input.html> <output.gif> [--theme name] [--scale 1] [--size WxH] [--fx slide|fade|pop] [--fps 25] [--transition 450] [--delay 900] [--hold 2600] [--jobs 4] [--keep-frames]')
  process.exit(1)
}

let html = readFileSync(resolve(input), 'utf8')

const steps = [...html.matchAll(/data-step="(\d+)"/g)].map((m) => Number(m[1]))
const maxStep = steps.length ? Math.max(...steps) : 0
if (maxStep < 1) {
  console.error('No data-step="1..N" attributes found — nothing to animate. See templates/sequence.html.')
  process.exit(1)
}

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
const delayMs = num('delay', 900)
const holdMs = num('hold', 2600)
const fps = num('fps', 25)
if (fps <= 0) {
  console.error('--fps must be positive; use --transition 0 for the one-frame-per-step look.')
  process.exit(1)
}
const transitionMs = num('transition', 450)
let jobs = Math.max(1, Math.floor(num('jobs', 4)))
if (jobs > 16) {
  // Each worker holds a profile slot, and a retry claims another; 64 slots is
  // the ceiling. More Chromes than cores costs wall-clock anyway.
  console.error(`note: --jobs ${jobs} clamped to 16.`)
  jobs = 16
}
const fx = opt('fx') ?? 'slide'
if (!['slide', 'fade', 'pop'].includes(fx)) {
  console.error(`note: --fx ${fx} is not a built-in (slide|fade|pop) — the template decides what it means.`)
}

const chrome = findChrome() // before the theme temp copy: it exits when no browser is found

let source = resolve(input)
const theme = opt('theme')
// Clear out copies a hard kill orphaned here on an earlier run, and reap any
// Chrome still holding a profile slot after an interrupted run.
sweepStaleCopies(dirname(resolve(input)))
reapOrphans()
if (theme) {
  // Tested, not diffed: rewriting ember.css to ember.css is a no-op too.
  const themeLink = /(themes\/)[a-z-]+(\.css)/
  if (!themeLink.test(html)) {
    console.error(`note: --theme ${theme} matched no themes/<name>.css link — rendering the page's own stylesheet.`)
  }
  html = html.replace(themeLink, `$1${theme}$2`)
  source = join(dirname(resolve(input)), `.render-${process.pid}.html`)
  writeFileSync(source, html)
}

// Before any Chrome starts: one blank frame would poison the whole GIF.
try {
  assertStylesheets(html, dirname(resolve(input)))
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

// One entry per GIF frame: tween frames tick at 1000/fps ms, the settled
// (f=1) frame of each step dwells delayMs — holdMs on the last step.
const tween = Math.max(1, Math.round((transitionMs / 1000) * fps))
const tickMs = 1000 / fps
const plan = []
for (let step = 1; step <= maxStep; step++) {
  for (let i = 1; i <= tween; i++) {
    plan.push({
      step,
      f: i / tween,
      delay: i < tween ? tickMs : step === maxStep ? holdMs : delayMs,
    })
  }
}

// Pid-tagged: SIGKILL cannot run the cleanup below, and an untagged dir gives
// a later run no way to tell an abandoned one from a live one. reapOrphans()
// removes these as soon as the writing pid is gone.
const frameDir = mkdtempSync(join(tmpdir(), `rendercraft-frames-${process.pid}-`))
const files = new Array(plan.length)

// The finally below covers normal completion; this covers Ctrl-C, where
// process.exit skips pending finally blocks.
process.on('exit', () => {
  if (theme) rmSync(source, { force: true })
  if (!flag('keep-frames')) rmSync(frameDir, { recursive: true, force: true })
})

try {
  let cursor = 0, done = 0
  const abort = { aborted: false } // one failed frame stops the whole pool promptly
  const worker = async () => {
    // One warm slot per worker for the whole run; shootResilient rotates it
    // only if a render on it fails.
    const slot = { dir: null }
    for (;;) {
      const i = cursor++
      if (i >= plan.length || abort.aborted) return
      const { step, f } = plan[i]
      const png = join(frameDir, `frame-${String(i + 1).padStart(3, '0')}-s${step}-f${f.toFixed(2)}.png`)
      try {
        await shootResilient(chrome, `${pathToFileURL(source).href}?step=${step}&f=${f.toFixed(4)}&fx=${fx}`, png, w, h, scale, { abort, slot })
      } catch (err) {
        abort.aborted = true
        throw err
      }
      files[i] = png
      console.log(`frame ${++done}/${plan.length} (step ${step})`)
    }
  }
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(jobs, plan.length) }, () => worker()),
  )
  const failure = settled.find((s) => s.status === 'rejected' && s.reason?.message !== 'aborted')
    ?? settled.find((s) => s.status === 'rejected')
  if (failure) throw failure.reason

  // Lazy provider: decode PNGs on demand so only one frame's RGB is in memory
  // at a time — at 25fps a long sequence would otherwise hold hundreds of MB.
  const gif = encodeGif(
    { count: files.length, get: (i) => decodePng(readFileSync(files[i])) },
    { delays: plan.map((p) => p.delay) },
  )
  writeFileSync(resolve(output), gif)
  console.log(`wrote ${output} (${gif.readUInt16LE(6)}x${gif.readUInt16LE(8)}, ${plan.length} frames, ${(gif.length / 1024).toFixed(0)} KB, ${fx} @ ${fps}fps, loops)`)
  if (flag('keep-frames')) console.log(`frames kept in ${frameDir}`)
} finally {
  if (theme) rmSync(source, { force: true })
  if (!flag('keep-frames')) rmSync(frameDir, { recursive: true, force: true })
}
