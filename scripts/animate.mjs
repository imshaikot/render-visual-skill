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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TEMP_ROOT, assertPng, assertStylesheets, findChrome, makeWorkDir, reapOrphans, shootResilient, sweepStaleCopies } from './chrome.mjs'
import { fail, findThemeLink, parseArgs, readInput } from './cli.mjs'
import { describeImages, inlineImages } from './images.mjs'
import { assertPartClasses, inlineParts } from './parts.mjs'
import { decodePng, encodeGif } from './gif.mjs'

const USAGE = 'animate.mjs <input.html> <output.gif> [--theme name] [--scale 1] [--size WxH] [--fx slide|fade|pop] [--fps 25] [--transition 450] [--delay 900] [--hold 2600] [--jobs 4] [--keep-frames]'
const cli = parseArgs({
  usage: USAGE,
  bool: ['keep-frames'],
  value: ['theme', 'scale', 'size', 'fx', 'fps', 'transition', 'delay', 'hold', 'jobs'],
})
const { opt, flag, num } = cli

const [input, output] = cli.positional
if (!input || !output) fail('Both an input .html and an output .gif are required.', USAGE)

const inputFile = readInput(input)
const inputDir = dirname(inputFile)
let html = readFileSync(inputFile, 'utf8')

const steps = [...html.matchAll(/data-step="(\d+)"/g)].map((m) => Number(m[1]))
const maxStep = steps.length ? Math.max(...steps) : 0
if (maxStep < 1) {
  console.error('No data-step="1..N" attributes found — nothing to animate. See templates/sequence.html.')
  process.exit(1)
}

let size = cli.size()
if (!size) {
  const m = html.match(/width:\s*(\d+)px;\s*height:\s*(\d+)px/)
  if (!m) fail('No --size given and no "width: Npx; height: Mpx" found on the input body.', USAGE)
  size = { w: Number(m[1]), h: Number(m[2]) }
}
const { w, h } = size
const scale = cli.scale('scale', 1)
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

const chrome = findChrome() // before any copy is written: it exits when no browser is found

const theme = cli.theme() // already validated against the shipped set, or fatal
// Clear out copies a hard kill orphaned here on an earlier run, and reap any
// Chrome still holding a profile slot after an interrupted run.
sweepStaleCopies(inputDir)
reapOrphans()

let source = inputFile
let workDir = null
if (theme) {
  const tag = findThemeLink(html)
  if (!tag) {
    fail(
      `--theme ${theme.name} found no theme stylesheet to replace in ${input}.\n` +
        '  A themeable page links either themes/<name>.css or a bare ./<name>.css.\n' +
        '  Every frame would carry the wrong colours, so this is fatal.',
    )
  }
  html = html.replace(tag, `<style>\n${readFileSync(theme.file, 'utf8')}\n</style>`)
}

// After the theme, so the CSS check sees the stylesheet the frames render with.
const parts = inlineParts(html, { onError: (m) => fail(m) })
html = parts.html

// Every frame renders the same prepared copy, so an image is read and encoded
// once here rather than once per frame.
const images = inlineImages(html, inputDir, { onError: (m) => fail(m) })
html = images.html
for (const line of describeImages(images.used)) console.log(line)

if (theme || parts.used.length || images.used.length) {
  workDir = makeWorkDir()
  source = join(workDir, 'page.html')
  const base = `<base href="${pathToFileURL(inputDir).href}/">`
  writeFileSync(source, html.replace(/<head([^>]*)>/i, `<head$1>${base}`))
  // Registered here, not below with the frame-dir cleanup: the stylesheet
  // preflight that follows can exit, and for as long as this handler sat 30
  // lines further down that exit left the copy behind.
  process.on('exit', () => rmSync(workDir, { recursive: true, force: true }))
}

// Before any Chrome starts: one blank frame would poison the whole GIF.
try {
  assertStylesheets(html, inputDir)
  assertPartClasses(html, parts.used, inputDir)
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
mkdirSync(TEMP_ROOT, { recursive: true })
const frameDir = mkdtempSync(join(TEMP_ROOT, `frames-${process.pid}-`))
const files = new Array(plan.length)

// The finally below covers normal completion; this covers Ctrl-C, where
// process.exit skips pending finally blocks. The work dir has its own handler,
// registered the moment it is written.
process.on('exit', () => {
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

  // The first and last frames are the ones that prove the animation actually
  // animated something: if the theme failed to apply or the page rendered empty,
  // both are content-free, and a GIF of 66 empty frames is the failure this
  // script's own comments warned about while never checking for it.
  const expect = Number.isInteger(scale) ? { w: w * scale, h: h * scale } : null
  for (const i of new Set([0, files.length - 1])) {
    assertPng(files[i], expect)
  }

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
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (!flag('keep-frames')) rmSync(frameDir, { recursive: true, force: true })
}
