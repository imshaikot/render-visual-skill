// Shared headless-Chrome screenshotter. Zero dependencies.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

export function findChrome() {
  const chrome = CANDIDATES.find((p) => existsSync(p))
  if (!chrome) {
    console.error('No Chromium browser found. Set CHROME_PATH to one and re-run.')
    process.exit(1)
  }
  return chrome
}

/**
 * Screenshot `url` (any file:// or http(s) URL, query strings allowed) to `out`.
 * Chrome often hangs after writing the screenshot, so this waits on the FILE,
 * not the process, then kills it.
 */
export function shoot(chrome, url, out, w, h, scale) {
  // A reused profile: a fresh one costs minutes of first-launch setup per run.
  const profile = join(tmpdir(), 'rendercraft-profile')
  mkdirSync(profile, { recursive: true })
  const target = resolve(out)
  rmSync(target, { force: true })

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
      `--screenshot=${target}`,
      url,
    ],
    { stdio: 'ignore' },
  )

  return new Promise((resolvePromise, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const done = existsSync(target) && statSync(target).size > 0
      if (done || Date.now() - started > 120_000) {
        clearInterval(timer)
        setTimeout(() => {
          child.kill()
          done ? resolvePromise(target) : reject(new Error('Timed out after 120s with no screenshot written.'))
        }, 1200)
      }
    }, 250)
  })
}
