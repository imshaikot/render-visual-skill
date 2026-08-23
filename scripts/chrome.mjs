// Shared headless-Chrome screenshotter. Zero dependencies.
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { decodePng, inspectPng } from './gif.mjs'

// Ordered by preference: Chrome first because it is the most-tested engine here.
// CHROME_PATH is handled separately in findChrome — it is an override, and an
// override that silently falls through to a different browser is not one.
//
// Note on Linux: since 20.04 both /usr/bin/chromium-browser and /snap/bin/chromium
// are usually snap-confined, and a strictly-confined snap gets a private /tmp —
// so it cannot see the profile and screenshot paths written to the host's temp
// dir. Prefer a deb/rpm Chrome or Brave there, or set CHROME_PATH.
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/brave-browser',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/snap/bin/chromium',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
].filter((p) => p && !p.startsWith('\\'))

// Names to look for on PATH, which is how a Chromium installed anywhere unusual
// — a distro that packages it elsewhere, a Nix or Homebrew prefix, a container
// image — gets found without the user having to discover CHROME_PATH first.
const PATH_NAMES = process.platform === 'win32'
  ? ['chrome.exe', 'msedge.exe', 'brave.exe', 'chromium.exe']
  : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge', 'microsoft-edge-stable']

const runnable = (p) => {
  try {
    accessSync(p, constants.X_OK)
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function searchPath() {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of PATH_NAMES) {
      const full = join(dir, name)
      if (runnable(full)) return full
    }
  }
  return null
}

/**
 * Locate a Chromium-based browser, or explain why there isn't one.
 *
 * `required: false` is for the janitorial tools, which must keep working on a
 * machine with no browser at all — cleaning up after Chrome should never depend
 * on Chrome still being installed.
 */
export function findChrome({ required = true } = {}) {
  // An explicitly set CHROME_PATH is an instruction, not a hint. Falling through
  // to a different browser when it does not resolve means the user asked for one
  // engine and silently got another.
  const explicit = process.env.CHROME_PATH
  if (explicit) {
    if (runnable(explicit)) return explicit
    const why = existsSync(explicit) ? 'is not an executable file' : 'does not exist'
    if (!required) return null
    console.error(`CHROME_PATH=${explicit} ${why}.`)
    process.exit(1)
  }

  const chrome = CANDIDATES.find(runnable) ?? searchPath()
  if (!chrome) {
    if (!required) return null
    console.error(
      'No Chromium-based browser found (looked in the standard install paths and on PATH).\n' +
        '  Install Chrome, Chromium, Brave or Edge, or set CHROME_PATH to one.\n' +
        '  Without root: npx @puppeteer/browsers install chrome@stable',
    )
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
const UNCLAIMED_PROFILE = join(TEMP_ROOT, 'profile-unlocked')

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
  mkdirSync(TEMP_ROOT, { recursive: true })
  for (let i = 0; i < 64; i++) {
    const dir = join(TEMP_ROOT, i === 0 ? 'profile' : `profile-${i}`)
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
        // Now that nothing is running on this slot, the scratch directory its
        // last Chrome created is garbage — see reapSingleton.
        reapSingleton(dir)
        return dir
      }
      if (!reclaimStale(lock)) break // owner alive — try the next slot
    }
  }
  throw new Error(`No free profile slot (64 in use?) — remove stale profile-*.lock files from ${TEMP_ROOT}.`)
}

/**
 * Delete the `com.google.Chrome.XXXXXX` scratch directory this profile's last
 * Chrome created.
 *
 * Chrome removes it on a graceful shutdown, but this pipeline kills with
 * SIGKILL — the only signal that reliably ends a Chrome wedged in startup — so
 * every render used to leave one behind: 501 of them accumulated on the author's
 * machine before anyone noticed, because they match none of this module's
 * patterns.
 *
 * They cannot be globbed away: the user's own browser has one too, and deleting
 * a live singleton breaks it. But the profile names its own, as a symlink —
 * `<profile>/SingletonSocket -> <TMPDIR>/com.google.Chrome.XXXXXX/SingletonSocket`
 * — so the directory is derivable rather than guessed. Called only where the
 * caller holds the lock and has just killed anything still on the slot, so
 * whatever it names is provably finished with.
 */
function reapSingleton(profileDir) {
  try {
    const target = readlinkSync(join(profileDir, 'SingletonSocket'))
    const scratch = dirname(target)
    if (/[\\/]com\.google\.Chrome\.[A-Za-z0-9]+$/.test(scratch)) {
      rmSync(scratch, { recursive: true, force: true })
    }
  } catch {} // no socket, not a symlink, already gone — all fine
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
    try {
      if (readOwner(l) !== process.pid) continue
      // Still holding the lock, and every child above is dead, so this slot's
      // Chrome scratch dir is finished with. Reaping it here as well as at claim
      // time is what keeps a clean run from leaving even one behind.
      reapSingleton(l.slice(0, -'.lock'.length))
      rmSync(l, { force: true })
    } catch {}
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
        // Every launch gets its own scratch dir and relinks the profile's
        // SingletonSocket at it, so the previous one becomes unreachable the
        // moment the next Chrome starts. Reaping per shot rather than per claim
        // is what keeps a 60-frame animation from leaving 60 directories behind.
        reapSingleton(profile)
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

const SLOT_RE = /^profile(-\d+)?$/
const LOCK_RE = /^profile(-\d+)?\.lock$/
const TOMB_RE = /^profile(-\d+)?\.lock\.(\d+)\.stale$/
const FRAMES_RE = /^frames-(\d+)-/
const WORK_RE = /^work-(\d+)$/

// Everything this pipeline wrote before the state was consolidated under
// TEMP_ROOT, still loose in the shared temp dir of anyone upgrading. Swept once,
// under the same liveness rules. Remove after v1.2.
const LEGACY_SLOT_RE = /^rendercraft-profile(-\d+)?$/
const LEGACY_LOCK_RE = /^rendercraft-profile(-\d+)?\.lock(\.(\d+)\.stale)?$/
const LEGACY_FRAMES_RE = /^rendercraft-frames-(?:(\d+)-)?/

/**
 * Put the temp dir into a known state before a run: kill every Chrome of ours
 * whose slot has no live claimant, then clear what a hard kill leaves behind —
 * stale locks, rename tombs, frame dirs, work dirs, and the scratch directories
 * Chrome itself abandons.
 *
 * Safe to call while other renders are in flight, and that is the point: a slot
 * whose lock is held by a live pid is never touched, so the only Chromes killed
 * are ones no launcher is waiting on. The unlocked fallback profile is skipped
 * entirely — it has no lock to prove it idle. Returns what it cleaned; the
 * whole function is janitorial and never throws.
 */
export function reapOrphans() {
  const report = { chromes: [], locks: [], frames: [], legacy: [] }
  const base = join(TEMP_ROOT, 'profile')

  if (process.platform !== 'win32') {
    let out = ''
    try {
      out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout || ''
    } catch {}
    for (const line of out.split('\n')) {
      const dir = line.match(/--user-data-dir=(\S+)/)?.[1]
      if (!dir) continue
      const leaf = dir.split(/[\\/]/).pop() || ''
      if (!SLOT_RE.test(leaf) && !LEGACY_SLOT_RE.test(leaf)) continue
      // Ours only: a slot under our root, or a legacy flat name in this temp dir.
      if (!dir.startsWith(base) && !dir.startsWith(join(tmpdir(), 'rendercraft-profile'))) continue
      if (pidAlive(readOwner(`${dir}.lock`))) continue // a live render owns this slot
      const pid = Number(line.trim().split(/\s+/)[0])
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue
      try { process.kill(pid, 'SIGKILL'); report.chromes.push(pid) } catch {}
      reapSingleton(dir) // nothing is on the slot now, so its scratch dir is dead
    }
  }

  // An empty lock is a claimant caught between open and write; only treat it as
  // abandoned once it is far too old to be one.
  const lockIsDead = (full) => {
    const owner = readOwner(full)
    if (pidAlive(owner)) return false
    if (!Number.isFinite(owner) || owner <= 0) return Date.now() - statSync(full).mtimeMs >= 10_000
    return true
  }

  for (const name of safeReaddir(TEMP_ROOT)) {
    const full = join(TEMP_ROOT, name)
    try {
      if (LOCK_RE.test(name)) {
        if (!lockIsDead(full)) continue
        rmSync(full, { force: true })
        report.locks.push(name)
      } else if (TOMB_RE.test(name)) {
        if (pidAlive(Number(TOMB_RE.exec(name)[2]))) continue
        rmSync(full, { force: true })
        report.locks.push(name)
      } else if (FRAMES_RE.test(name) || WORK_RE.test(name)) {
        // Pid-tagged, so a dir goes as soon as its writer is gone.
        const owner = Number((FRAMES_RE.exec(name) ?? WORK_RE.exec(name))[1])
        if (pidAlive(owner)) continue
        rmSync(full, { recursive: true, force: true })
        report.frames.push(name)
      }
    } catch {} // an entry we cannot remove is never worth failing a render over
  }

  for (const name of safeReaddir(tmpdir())) {
    const full = join(tmpdir(), name)
    try {
      if (LEGACY_LOCK_RE.test(name)) {
        const tombPid = LEGACY_LOCK_RE.exec(name)[3]
        if (tombPid ? pidAlive(Number(tombPid)) : !lockIsDead(full)) continue
        rmSync(full, { force: true })
        report.legacy.push(name)
      } else if (LEGACY_SLOT_RE.test(name) || LEGACY_FRAMES_RE.test(name)) {
        if (pidAlive(readOwner(`${full}.lock`))) continue
        const owner = LEGACY_FRAMES_RE.exec(name)?.[1]
        if (owner && pidAlive(Number(owner))) continue
        if (LEGACY_SLOT_RE.test(name)) reapSingleton(full)
        rmSync(full, { recursive: true, force: true })
        report.legacy.push(name)
      }
    } catch {}
  }
  return report
}

const safeReaddir = (dir) => {
  try { return readdirSync(dir) } catch { return [] }
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
// Luminance spread below this means nothing but background and furniture got
// painted. Measured, not guessed: across the six shipped previews the spread
// runs 152-240, and across content-stripped renders in all four themes it runs
// 16-32. 64 sits ~2.4x below the worst real render and 2x above the worst
// degenerate one. See also INK_FLOOR_RATIO.
const INK_SPREAD_MIN = 64
// Luma buckets holding fewer than this fraction of samples are ignored, so a
// handful of stray antialiased pixels cannot fake a spread.
const INK_FLOOR_RATIO = 0.0002

/**
 * Reject a PNG that is corrupt, the wrong size, or carries no content.
 *
 * Three distinct failures, and they need different treatment:
 *
 *  - **Corrupt** (no signature, no IEND, a chunk running past the end) is a
 *    failed write and always fatal. This used to be swallowed: any decode error
 *    was treated as "not evidence of a bad render", so a PNG truncated to 60%
 *    of its bytes was reported as a success.
 *  - **Wrong dimensions** catches the whole --size/--scale class from the output
 *    side, after Chrome rather than before it.
 *  - **No content** is the render that Chrome reports as a complete success. The
 *    old distinct-colour test cannot see it: the templates' own .glow/.dots
 *    gradient paints 169 colours on a canvas with every element stripped, so
 *    the colour count sails past any sane threshold while the image is empty.
 *    Luminance spread separates them, because content means ink against ground.
 *
 * A PNG variant this decoder does not support is *not* a failure — it warns and
 * abstains, so an unusual Chrome build cannot start rejecting good images.
 */
export function assertPng(file, expect = null) {
  const buf = readFileSync(file)
  const info = inspectPng(buf)
  if (!info.signature) {
    throw new Error(`${file} is not a PNG (${buf.length} bytes). Chrome wrote something else, or nothing.`)
  }
  if (!info.hasIhdr || info.truncated) {
    throw new Error(
      `${file} is a truncated PNG — ${buf.length} bytes with no IEND chunk. ` +
        'The screenshot was interrupted mid-write. The file is left in place for inspection.',
    )
  }
  if (expect && (info.width !== expect.w || info.height !== expect.h)) {
    throw new Error(
      `${file} is ${info.width}x${info.height}, expected ${expect.w}x${expect.h}. ` +
        'The page rendered at a size the arguments did not ask for — check the body\'s ' +
        'width/height declaration and --size.',
    )
  }

  let rgb
  try {
    ;({ rgb } = decodePng(buf))
  } catch (err) {
    if (err.unsupported) {
      console.error(`note: ${file} is a PNG variant this build cannot inspect (${err.message}) — content not verified.`)
      return info
    }
    throw err
  }

  const step = Math.max(1, Math.floor(rgb.length / 3 / 20_000)) * 3
  const seen = new Set()
  const buckets = new Int32Array(32)
  let samples = 0
  for (let i = 0; i + 2 < rgb.length; i += step) {
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2]
    if (seen.size <= 4096) seen.add((r << 16) | (g << 8) | b)
    buckets[Math.min(31, (0.2126 * r + 0.7152 * g + 0.0722 * b) >> 3)]++
    samples++
  }
  const floor = Math.max(1, Math.round(samples * INK_FLOOR_RATIO))
  let lo = -1, hi = -1
  for (let i = 0; i < 32; i++) if (buckets[i] >= floor) { if (lo < 0) lo = i; hi = i }
  const spread = lo < 0 ? 0 : (hi - lo) * 8

  if (spread < INK_SPREAD_MIN) {
    throw new Error(
      `${file} rendered with no content (${seen.size} distinct colour${seen.size === 1 ? '' : 's'}, ` +
        `luminance spread ${spread} of a required ${INK_SPREAD_MIN}). ` +
        'The usual causes are a stylesheet that loaded but defined none of the theme tokens, ' +
        'or content positioned outside the body box. The file is left in place for inspection.',
    )
  }
  return info
}



