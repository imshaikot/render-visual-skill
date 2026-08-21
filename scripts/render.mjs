#!/usr/bin/env node
// Render an HTML canvas to a PNG with headless Chrome.
//
//   node scripts/render.mjs <input.html> <output.png> [--size WxH] [--scale N] [--theme name]
//
// --size  defaults to the `width: Npx; height: Mpx` declared on the input's <body>.
// --scale defaults to 2 (retina). The PNG comes out at W*scale x H*scale.
// --theme rewrites the template's themes/<name>.css link before rendering (in memory,
//         via a temp copy next to the input, so the source file is untouched).
//
// Chrome is found automatically on macOS, Linux and Windows; CHROME_PATH overrides.

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const positional = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'))
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const [input, output] = positional
if (!input || !output) {
  console.error('usage: render.mjs <input.html> <output.png> [--size WxH] [--scale N] [--theme name]')
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

let source = resolve(input)
const theme = opt('theme')
if (theme) {
  html = html.replace(/(themes\/)[a-z-]+(\.css)/, `$1${theme}$2`)
  source = join(dirname(resolve(input)), `.render-${process.pid}.html`)
  writeFileSync(source, html)
}

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

const chrome = CANDIDATES.find((p) => existsSync(p))
if (!chrome) {
  console.error('No Chromium browser found. Set CHROME_PATH to one and re-run.')
  process.exit(1)
}

// A reused profile: a fresh one costs minutes of first-launch setup per run.
const profile = join(tmpdir(), 'rendercraft-profile')
mkdirSync(profile, { recursive: true })

const out = resolve(output)
rmSync(out, { force: true })

const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--force-device-scale-factor=${scale}`,
    `--window-size=${w},${h}`,
    '--no-first-run',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=8000',
    `--screenshot=${out}`,
    pathToFileURL(source).href,
  ],
  { stdio: 'ignore' },
)

// Chrome often hangs after writing the screenshot, so wait on the FILE, not the process.
const started = Date.now()
const timer = setInterval(() => {
  const done = existsSync(out) && statSync(out).size > 0
  if (done || Date.now() - started > 120_000) {
    clearInterval(timer)
    setTimeout(() => {
      child.kill()
      if (theme) rmSync(source, { force: true })
      if (!done) {
        console.error('Timed out after 120s with no screenshot written.')
        process.exit(1)
      }
      console.log(`wrote ${output} (${w}x${h} @${scale}x = ${w * scale}x${h * scale})`)
      process.exit(0)
    }, 1500)
  }
}, 250)
