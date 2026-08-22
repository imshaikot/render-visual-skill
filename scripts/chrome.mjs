// Shared headless-Chrome screenshotter. Zero dependencies.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { decodePng } from './gif.mjs'

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

/* ── Asset preflight ────────────────────────────────────────────────────── */

/**
 * Throw if a local stylesheet the page links is missing. Every color in a
 * template is a theme variable, so a 404 here does not degrade the render — it
 * empties it: an all-white page that Chrome screenshots and reports as a
 * complete success. It is the one failure this pipeline cannot see, so it is
 * checked before Chrome ever launches. Remote and data: hrefs are Chrome's
 * problem, not ours.
 */
export function assertStylesheets(html, baseDir) {
  const missing = []
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel=["']?stylesheet\b/i.test(tag)) continue
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1]
    if (!href || /^(https?:)?\/\/|^data:/i.test(href)) continue
    const file = resolve(baseDir, decodeURIComponent(href.split(/[?#]/)[0]))
    if (!existsSync(file)) missing.push(`${href}  ->  ${file}`)
  }
  if (missing.length) {
    throw new Error(
      `Stylesheet not found:\n  ${missing.join('\n  ')}\n` +
        'Every theme token would be undefined and the render would come out blank. ' +
        'Copy the theme file beside the HTML and link it directly (href="./slate.css").',
    )
  }
}

/* ── Profile slots ──────────────────────────────────────────────────────── */
// Chrome enforces a process singleton per profile dir, and a cold profile
// costs first-launch setup — so profiles live at stable names in the OS temp
// dir (warm across runs) and are claimed with pid lockfiles, so no two live
// processes share one however many renders run at once. On a multi-user temp
// dir the slots are simply per-user: another user's lock reads as held.

const claimedLocks = []
const liveChildren = new Set()

// Every scrap of temp state this pipeline creates lives under one root, so
// "what did this leave behind?" has a one-directory answer and cleaning up is
// an `rm -rf` rather than a pattern hunt across a shared temp dir.
export const TEMP_ROOT = join(tmpdir(), 'render-visual')

/**
 * A private scratch directory for this process, under TEMP_ROOT.
 *
 * The prepared copy of a page used to be written beside the *input*, which made
 * a read-only input directory an uncaught EACCES and forced a themes/ directory
 * to sit next to every figure. Chrome renders a copy from anywhere identically
 * as long as the page carries a <base href> or absolute asset URLs, so the copy
 * belongs somewhere always writable.
 */
export function makeWorkDir() {
  const dir = join(TEMP_ROOT, `work-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// Callers that skip claimProfile() get their own dir rather than slot 0's, so
// an unlocked caller can never collide with a claimed slot.
const UNCLAIMED_PROFILE = join(tmpdir(), 'rendercraft-profile-unlocked')

const readOwner = (lock) => {
  try { return Number(readFileSync(lock, 'utf8')) } catch { return NaN }
}

// EPERM means the pid exists but belongs to another user — alive, not stale.
function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Remove `lock` if its owner is gone; true when the slot is worth retrying.
 * The stale file is renamed into a private tomb first — rename is atomic, so a
 * racing reclaimer's rename fails and it backs off instead of deleting the
 * lock the winner has since written. Nothing here throws: an unremovable lock
 * (another user's, a sticky temp dir) just sends the scan to the next slot.
 */
function reclaimStale(lock) {
  let pid, st
  try {
    st = statSync(lock)
    pid = readOwner(lock)
  } catch {
    return true // vanished under us — the slot may be free now
  }
  if (pidAlive(pid)) return false
  // An empty lock is a claimant caught between open and write; only treat it
  // as abandoned once it is far too old to be one.
  if (!Number.isFinite(pid) || pid <= 0) {
    if (Date.now() - st.mtimeMs < 10_000) return false
  }

  const tomb = `${lock}.${process.pid}.stale`
  try {
    renameSync(lock, tomb)
  } catch {
    return false // lost the race, or cannot unlink here
  }
  try {
    // If that rename caught a lock recreated since the probe, put it back.
    if (statSync(tomb).ino !== st.ino) { try { linkSync(tomb, lock) } catch {} }
  } catch {}
  try { rmSync(tomb, { force: true }) } catch {}
  return true
}

/**
 * Kill Chromes still holding `dir` after their launcher died. A SIGKILLed run
 * never runs the exit handler that reaps its child, and that orphan keeps
 * Chrome's per-profile singleton: the slot then looks free — its lock is stale
 * — but every render on it exits without writing a file.
 *
 * Only ever called once this process owns the slot's lock, and that ownership
 * is the safety argument: a live claimant would still hold the lock, so any
 * Chrome left on the dir is by definition abandoned. The match must be exact,
 * not a prefix — `rendercraft-profile` is a prefix of `rendercraft-profile-1`,
 * whose Chrome may be legitimately alive under another owner.
 *
 * POSIX only: `ps` is the portable way to read another process's argv, and
 * Windows keeps the "another instance is using profile" error instead.
 */
function killProfileHolders(dir) {
  if (process.platform === 'win32') return
  let out = ''
  try {
    out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout || ''
  } catch {
    return
  }
  const needle = `--user-data-dir=${dir}`
  for (const line of out.split('\n')) {
    const at = line.indexOf(needle)
    if (at < 0) continue
    const next = line[at + needle.length]
    if (next && !/\s/.test(next)) continue // a longer slot name, not ours
    const pid = Number(line.trim().split(/\s+/)[0])
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

/** Claim a warm profile dir for this process. Released on exit. */
export function claimProfile() {
  for (let i = 0; i < 64; i++) {
    const dir = join(tmpdir(), i === 0 ? 'rendercraft-profile' : `rendercraft-profile-${i}`)
    const lock = `${dir}.lock`
    for (let attempt = 0; attempt < 2; attempt++) {
      let taken = false
      try {
        const fd = openSync(lock, 'wx')
        writeSync(fd, String(process.pid))
        closeSync(fd)
        taken = true
      } catch (err) {
        if (err.code !== 'EEXIST') break // unwritable slot — try the next one
      }
      if (taken) {
        // A reclaimer may have judged this lock stale while it was still
        // empty; whoever's pid is in it now is the slot's real owner.
        if (readOwner(lock) !== process.pid) continue
        claimedLocks.push(lock)
        mkdirSync(dir, { recursive: true })
        // We hold the lock now, so anything still on this dir is an orphan —
        // true whether the lock was reclaimed or created fresh. Gating this on
        // "reclaimed" was the bug: a run stopped by SIGINT/SIGTERM removes its
        // lock on the way out but leaves its Chrome alive, so the next claim is
        // a *fresh* lock over a still-held profile — and every render on that
        // slot failed until someone killed the orphan by hand.
        killProfileHolders(dir)
        return dir
      }
      if (!reclaimStale(lock)) break // owner alive — try the next slot
    }
  }
  throw new Error('No free rendercraft profile slot (64 in use?) — remove stale rendercraft-profile-*.lock files from the temp dir.')
}

// Kill stray Chromes and release our locks however the process ends — an
// orphaned headless Chrome would hold its profile's singleton forever. Locks
// are only removed while we still own them, so a slot reclaimed from us in the
// meantime keeps its new owner's lock.
process.on('exit', () => {
  // SIGKILL, not the default SIGTERM: headless Chrome installs a SIGTERM
  // handler that starts a graceful shutdown, and during startup that shutdown
  // never completes — kill() reports success and the process lives on, still
  // holding its profile's singleton. That orphan is what wedges later renders.
  for (const c of liveChildren) { try { c.kill('SIGKILL') } catch {} }
  for (const l of claimedLocks) {
    try { if (readOwner(l) === process.pid) rmSync(l, { force: true }) } catch {}
  }
})
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => process.exit(130))
}

/* ── Stale theme copies ─────────────────────────────────────────────────── */

/**
 * Delete `.render-<pid>.html` copies in `dir` whose writer is gone. The copy has
 * to be a sibling of the input — the page's stylesheet link is relative and must
 * keep resolving — and it is removed on exit, but SIGKILL cannot be trapped, so
 * one can outlive its run. In a project without a matching .gitignore that
 * orphan is a hidden file `git add -A` would happily commit, so every run sweeps
 * the ones it can prove are dead. A live pid's copy is never touched, which is
 * also what makes this safe for concurrent renders of the same directory; a
 * recycled pid just means the orphan waits for a later run. Janitorial only —
 * every error here is swallowed rather than failing a render.
 */
export function sweepStaleCopies(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const m = /^\.render-(\d+)\.html$/.exec(name)
    if (!m || pidAlive(Number(m[1]))) continue
    try { rmSync(join(dir, name), { force: true }) } catch {}
  }
}

/**
 * Screenshot `url` (any file:// or http(s) URL, query strings allowed) to `out`.
 * Chrome often hangs after writing the screenshot, so this waits on the FILE,
 * not the process, then kills it.
 *
 * `profile` should come from claimProfile() whenever anything might run
 * concurrently. `abort` is an optional { aborted } token: set it true and
 * every in-flight shoot rejects promptly instead of waiting out its timeout.
 * `transparent` makes Chrome paint the default background fully transparent,
 * so pages that leave their background unpainted come out with real alpha.
 */
export function shoot(chrome, url, out, w, h, scale, profile = UNCLAIMED_PROFILE, abort = null, transparent = false) {
  mkdirSync(profile, { recursive: true })
  const target = resolve(out)
  // Chrome given an unwritable --screenshot path does not fail — it starts,
  // writes nothing, and sits there until the 120s timeout. Checked here, before
  // launch, for the same reason the stylesheet is: the alternative is two
  // minutes of silence per attempt.
  const outDir = dirname(target)
  if (!existsSync(outDir)) {
    throw new Error(`Output directory does not exist: ${outDir}\nCreate it first (mkdir -p) or write to a path that already exists.`)
  }
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
      // Chrome otherwise fills a throwaway profile with component-updater
      // downloads — safe-browsing lists, TTS wasm, suggest models — ~100MB over
      // a few dozen runs, none of which affects a screenshot. These disable
      // Chrome's own background services only; page requests (Google Fonts)
      // are untouched.
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--no-default-browser-check',
      '--no-pings',
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=8000',
      ...(transparent ? ['--default-background-color=00000000'] : []),
      `--screenshot=${target}`,
      url,
    ],
    { stdio: 'ignore' },
  )
  liveChildren.add(child)

  return new Promise((resolvePromise, reject) => {
    const started = Date.now()
    let exited = false
    child.on('error', () => { exited = true })
    child.on('close', () => { exited = true })

    const finish = (ok, err, settleMs) => {
      clearInterval(timer)
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch {} // SIGTERM is swallowed mid-startup
        liveChildren.delete(child)
        ok ? resolvePromise(target) : reject(err)
      }, settleMs)
    }

    const timer = setInterval(() => {
      // The file check runs first: Chrome may exit right after writing.
      // The extra 1200ms lets it finish flushing the file it just created.
      if (existsSync(target) && statSync(target).size > 0) return finish(true, null, 1200)
      if (abort?.aborted) return finish(false, new Error('aborted'), 0)
      if (exited && Date.now() - started > 3000) {
        // The one failure a different profile can fix, so the only one worth a
        // retry: Chrome refusing a slot another instance still holds.
        return finish(false, Object.assign(
          new Error(`Chrome exited without writing ${target} — is another instance using profile ${profile}?`),
          { retryable: true },
        ), 0)
      }
      if (Date.now() - started > 120_000) return finish(false, new Error('Timed out after 120s with no screenshot written.'), 0)
    }, 250)
  })
}

/* ── Deterministic preflight ────────────────────────────────────────────── */

const SLOT_RE = /^rendercraft-profile(-\d+)?$/
const LOCK_RE = /^rendercraft-profile(-\d+)?\.lock$/
const TOMB_RE = /^rendercraft-profile(-\d+)?\.lock\.(\d+)\.stale$/
const FRAMES_RE = /^rendercraft-frames-(\d+)-/

/**
 * Put the temp dir into a known state before a run: kill every rendercraft
 * Chrome whose slot has no live claimant, then clear what a hard kill leaves
 * behind — stale locks, rename tombs, frame dirs.
 *
 * Safe to call while other renders are in flight, and that is the point: a slot
 * whose lock is held by a live pid is never touched, so the only Chromes killed
 * are ones no launcher is waiting on. The unlocked fallback profile is skipped
 * entirely — it has no lock to prove it idle. Returns what it cleaned; the
 * whole function is janitorial and never throws.
 */
export function reapOrphans() {
  const report = { chromes: [], locks: [], frames: [] }
  const base = join(tmpdir(), 'rendercraft-profile')

  if (process.platform !== 'win32') {
    let out = ''
    try {
      out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout || ''
    } catch {}
    for (const line of out.split('\n')) {
      const dir = line.match(/--user-data-dir=(\S+)/)?.[1]
      if (!dir || !SLOT_RE.test(dir.split(/[\\/]/).pop() || '')) continue
      if (dir !== base && !dir.startsWith(`${base}-`)) continue // another tree's temp dir
      if (pidAlive(readOwner(`${dir}.lock`))) continue // a live render owns this slot
      const pid = Number(line.trim().split(/\s+/)[0])
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue
      try { process.kill(pid, 'SIGKILL'); report.chromes.push(pid) } catch {}
    }
  }

  const dir = tmpdir()
  let entries = []
  try { entries = readdirSync(dir) } catch { return report }
  for (const name of entries) {
    const full = join(dir, name)
    try {
      if (LOCK_RE.test(name)) {
        const owner = readOwner(full)
        if (pidAlive(owner)) continue
        // An empty lock is a claimant caught between open and write; only treat
        // it as abandoned once it is far too old to be one.
        if (!Number.isFinite(owner) || owner <= 0) {
          if (Date.now() - statSync(full).mtimeMs < 10_000) continue
        }
        rmSync(full, { force: true })
        report.locks.push(name)
      } else if (TOMB_RE.test(name)) {
        if (pidAlive(Number(TOMB_RE.exec(name)[2]))) continue
        rmSync(full, { force: true })
        report.locks.push(name)
      } else if (name.startsWith('rendercraft-frames-')) {
        const owner = FRAMES_RE.exec(name)?.[1]
        // Pid-tagged dirs go as soon as their writer is gone. Dirs from before
        // the tagging carry no owner, so age is all there is to go on.
        if (owner ? pidAlive(Number(owner)) : Date.now() - statSync(full).mtimeMs < 3_600_000) continue
        rmSync(full, { recursive: true, force: true })
        report.frames.push(name)
      }
    } catch {} // an entry we cannot remove is never worth failing a render over
  }
  return report
}

/**
 * shoot() with slot fallback. `slot` is a `{ dir }` holder kept across calls so
 * a worker reuses one warm profile; on failure the holder is emptied, so the
 * next attempt claims a different slot — the failed slot's lock is deliberately
 * held for the rest of the run to keep it out of the rotation. A profile
 * poisoned by an orphaned Chrome then costs one attempt, not the whole render.
 * Aborts are never retried.
 */
export async function shootResilient(chrome, url, out, w, h, scale, opts = {}) {
  const { attempts = 3, abort = null, transparent = false, slot = { dir: null } } = opts
  let last
  for (let i = 0; i < attempts; i++) {
    if (abort?.aborted) throw new Error('aborted')
    if (!slot.dir) {
      try {
        slot.dir = claimProfile()
      } catch (err) {
        throw last ?? err // out of slots: report the render failure, not the shortage
      }
    }
    try {
      return await shoot(chrome, url, out, w, h, scale, slot.dir, abort, transparent)
    } catch (err) {
      // Anything else — a bad output path, a 120s hang — fails the same way on
      // every slot. Retrying it just launches Chrome again and multiplies the
      // wait, which is worse than the original failure.
      if (abort?.aborted || !err?.retryable) throw err
      last = err
      slot.dir = null // rotate off this slot
    }
  }
  throw last
}

/**
 * Fail if `file` decoded to a near-solid image. The blank render — a stylesheet
 * that resolved but defined no tokens, content positioned outside the body box
 * — is the one defect Chrome reports as a complete success, and
 * assertStylesheets only catches the cause it can see before launch. Sampling
 * stops at the ninth distinct color, so a real figure costs a millisecond or
 * two; only a genuinely blank canvas scans the whole grid.
 */
export function assertRendered(file) {
  let rgb
  try {
    ;({ rgb } = decodePng(readFileSync(file)))
  } catch {
    return // a PNG we cannot decode is not evidence of a bad render
  }
  const seen = new Set()
  const step = Math.max(1, Math.floor(rgb.length / 3 / 20_000)) * 3
  for (let i = 0; i + 2 < rgb.length; i += step) {
    seen.add((rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2])
    if (seen.size > 8) return
  }
  throw new Error(
    `${file} rendered essentially blank (${seen.size} distinct color${seen.size === 1 ? '' : 's'} across the canvas). ` +
      'The usual causes are a stylesheet that loaded but defined none of the theme tokens, ' +
      'or content positioned outside the body box. The file is left in place for inspection.',
  )
}
