#!/usr/bin/env node
// Deterministic invariant suite for the render pipeline.
//
//   node scripts/selftest.mjs [--keep] [--quick]
//
// Every child render runs with TMPDIR pointed at a throwaway root, so the suite
// claims its own profile slots, never races the machine's real renders, and can
// assert "the temp dir is empty afterwards" as an actual pass condition. That
// isolation is what makes it safe to run while you are working, and what makes
// the leak accounting in T7 meaningful. Cost: every profile is cold, so a render
// here takes about a second longer than a warm one.
//
// --quick skips the animation test, the slowest by some way.
// Exits non-zero on the first failing invariant.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPng, findChrome } from './chrome.mjs'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = dirname(SCRIPTS)
const keep = process.argv.includes('--keep')
const quick = process.argv.includes('--quick')

const root = mkdtempSync(join(tmpdir(), 'render-visual-selftest-'))
const work = join(root, 'work')   // stands in for a user's project directory
const iso = join(root, 'tmp')     // the isolated TMPDIR every child renders into
mkdirSync(work, { recursive: true })
mkdirSync(iso, { recursive: true })

// A faithful fixture: the real template and the real themes, with the relative
// link fixed the way SKILL.md tells you to fix it when copying a template out.
cpSync(join(SKILL_DIR, 'themes'), join(work, 'themes'), { recursive: true })
writeFileSync(
  join(work, 'fig.html'),
  readFileSync(join(SKILL_DIR, 'templates', 'diagram.html'), 'utf8').replace(/\.\.\/themes\//g, 'themes/'),
)
cpSync(join(SKILL_DIR, 'templates', 'sequence.html'), join(work, 'seq.html'))
writeFileSync(
  join(work, 'seq.html'),
  readFileSync(join(work, 'seq.html'), 'utf8').replace(/\.\.\/themes\//g, 'themes/'),
)

const env = { ...process.env, TMPDIR: iso, TMP: iso, TEMP: iso }
const render = (...args) => spawnSync(process.execPath, [join(SCRIPTS, 'render.mjs'), ...args], { cwd: work, env, encoding: 'utf8' })
/**
 * `closed` is attached at spawn, never at the point a test wants to wait. A render
 * that finished before the test got there has already emitted 'close', and a
 * listener added afterwards never fires: the await never settles, the loop drains,
 * and node exits 13 with no failing test named.
 */
const renderBg = (...args) => {
  const child = spawn(process.execPath, [join(SCRIPTS, 'render.mjs'), ...args], { cwd: work, env, stdio: 'ignore' })
  child.closed = new Promise((res) => child.once('close', res))
  return child
}
const sha = (f) => createHash('sha256').update(readFileSync(join(work, f))).digest('hex').slice(0, 16)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// All of this suite's temp state lives under one directory inside the isolated
// TMPDIR, which is what lets T8 assert "nothing else was created" rather than
// hunting for known patterns.
const isoState = join(iso, 'render-visual')

const WIN = process.platform === 'win32'

/**
 * One line per process, `"<pid> <full command line>"`.
 *
 * Git Bash ships the Cygwin `ps` — `ps [-aeflsW]`, no `-o` — and even `-W -f`
 * prints a native process's image path without its arguments, so it can never
 * see a `--user-data-dir`. `wmic` is gone from the current runner image, which
 * leaves CIM as the only thing on the box that reports a command line.
 *
 * Throws rather than returning nothing. `spawnSync` does not throw for a missing
 * binary — it hands back `{ error: ENOENT, stdout: undefined }` — so the previous
 * `.stdout || ''` turned "I cannot see" into "I see no Chromes". That made every
 * orphan assertion vacuously true on Windows: T5 reported PASS while testing
 * nothing at all, and T4 and T6 failed for a reason that had nothing to do with
 * the behaviour under test.
 */
function procLines() {
  const r = WIN
    ? spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '@(Get-CimInstance Win32_Process) | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
      ], { encoding: 'utf8' })
    : spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  // Three ways to come back empty, and all of them have to be fatal, because an
  // empty list makes every orphan assertion pass by seeing nothing:
  //   - error:  the binary is missing (spawnSync reports, never throws)
  //   - status: it ran and refused — a bad flag, a PowerShell execution policy
  //   - empty:  it succeeded but printed nothing, which no real process table does
  const lines = typeof r.stdout === 'string' ? r.stdout.split('\n').filter(Boolean) : []
  if (r.error || r.status !== 0 || lines.length === 0) {
    const why = r.error?.code ?? (r.status !== 0 ? `exit ${r.status}` : 'no processes listed')
    throw new Error(
      `process probe failed (${why}). Without it every assertion about orphaned ` +
        'Chromes would pass by seeing nothing, so this is fatal.',
    )
  }
  return lines
}

// join(), not a literal '/': on Windows the profile path Chrome was launched with
// carries backslashes, so a hard-coded forward slash matches nothing even once the
// probe can see. `profile` is a prefix of `profile-1`, so this catches every slot.
const PROFILE_NEEDLE = `--user-data-dir=${join(isoState, 'profile')}`

/** Chrome processes holding one of THIS suite's profile slots. */
const isoChromes = () => procLines().filter((l) => l.includes(PROFILE_NEEDLE))
const ls = (dir, re) => {
  try { return readdirSync(dir).filter((n) => re.test(n)) } catch { return [] }
}
/** Entries under the suite's state root. */
const isoTemp = (re) => ls(isoState, re)
/** Entries at the top level of the isolated TMPDIR — should only ever be our root. */
const isoTop = (re) => ls(iso, re)

/**
 * SIGKILL anything still on this suite's profiles. A failing run is exactly the
 * run that leaves Chromes behind, and they hold the scratch tree open — so the
 * teardown has to reap before it deletes, on every exit path.
 */
const killIsoChromes = () => {
  // Teardown must never throw: it runs from the exit handler, and a probe failure
  // here would replace a real test result with a crash on the way out.
  let lines = []
  try { lines = isoChromes() } catch { return }
  for (const line of lines) {
    const pid = Number(line.trim().split(/\s+/)[0])
    if (Number.isFinite(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL') } catch {} }
  }
}
process.on('exit', () => {
  killIsoChromes()
  if (!keep) rmSync(root, { recursive: true, force: true })
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))
// A hard kill's litter is now a work dir in the temp root, plus anything an
// older version left beside the input.
const strays = () => [...isoTemp(/^work-\d+$/), ...ls(work, /^\.render-\d+\.html$/)]

/** Poll until `pred()` is true, or give up. Keeps the timing tests honest. */
async function until(pred, ms = 20_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(100)
  }
  return false
}

const results = []
/** Long enough for the slowest invariant (the animation) on a cold Windows runner. */
const TIMEOUT = 180_000
async function test(name, fn, { skip = null, timeout = TIMEOUT } = {}) {
  const started = Date.now()
  const n = String(results.length + 1)
  process.stdout.write(`[T${n}] ${name} … `)
  if (skip) {
    console.log(`SKIP — ${skip}`)
    results.push({ name, ok: true, skipped: true })
    return
  }
  try {
    // A test that hangs must fail by name. Without this the suite dies on an
    // unsettled await, and the log ends mid-line with exit code 13.
    let timer
    const guard = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timed out after ${timeout / 1000}s`)), timeout)
    })
    try { await Promise.race([fn(), guard]) } finally { clearTimeout(timer) }
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`PASS (${secs}s)`)
    results.push({ name, ok: true })
  } catch (err) {
    console.log('FAIL')
    console.log(`      ${err.message.split('\n').join('\n      ')}`)
    results.push({ name, ok: false })
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

/* ───────────────────────────────────────────────────────────────────────── */

let baseline

await test('baseline render writes a real PNG', async () => {
  const r = render('fig.html', 'base.png', '--theme', 'slate', '--scale', '1')
  assert(r.status === 0, `exit ${r.status}: ${r.stderr.trim()}`)
  assert(existsSync(join(work, 'base.png')), 'no PNG written')
  baseline = sha('base.png')
})

await test('6 concurrent renders agree, byte for byte', async () => {
  const kids = Array.from({ length: 6 }, (_, i) =>
    new Promise((res) => {
      const c = renderBg('fig.html', `par-${i}.png`, '--theme', 'slate', '--scale', '1')
      c.on('close', (code) => res(code))
    }))
  const codes = await Promise.all(kids)
  assert(codes.every((c) => c === 0), `exit codes ${codes.join(',')}`)
  // Identical output from six processes that each picked their own profile slot
  // is the strongest statement of both isolation and determinism.
  const hashes = codes.map((_, i) => sha(`par-${i}.png`))
  assert(hashes.every((h) => h === baseline), `hashes diverged: ${[...new Set(hashes)].join(' ')}`)
})

await test('overlapping themes never cross-contaminate', async () => {
  const refs = {}
  for (const t of ['slate', 'paper']) {
    const r = render('fig.html', `ref-${t}.png`, '--theme', t, '--scale', '1')
    assert(r.status === 0, `ref ${t} exit ${r.status}: ${r.stderr.trim()}`)
    refs[t] = sha(`ref-${t}.png`)
  }
  assert(refs.slate !== refs.paper, 'the two themes rendered identically — the --theme rewrite did nothing')
  const jobs = []
  for (const round of [1, 2]) {
    for (const t of ['slate', 'paper']) {
      jobs.push(new Promise((res) => {
        const c = renderBg('fig.html', `cc-${round}-${t}.png`, '--theme', t, '--scale', '1')
        c.on('close', () => res({ round, t }))
      }))
    }
  }
  for (const { round, t } of await Promise.all(jobs)) {
    assert(sha(`cc-${round}-${t}.png`) === refs[t], `cc-${round}-${t}.png does not match the ${t} reference`)
  }
  const link = readFileSync(join(work, 'fig.html'), 'utf8')
  assert(link.includes('themes/ember.css'), 'the source file was mutated by --theme')
})

await test('an unowned Chrome on a slot is reaped, not tripped over', async () => {
  // The deterministic form of the SIGTERM regression. Rather than racing to
  // interrupt a render at exactly the wrong moment, put the machine straight
  // into the state a bad interrupt leaves behind — a live Chrome holding slot
  // 0's profile with no lock claiming it — and require the pipeline to cope.
  const slot0 = join(isoState, 'profile')
  assert(!existsSync(`${slot0}.lock`), 'slot 0 was still claimed; an earlier test did not clean up')
  const orphan = spawn(findChrome(),
    ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${slot0}`, 'about:blank'],
    { stdio: 'ignore' })
  // Watch the exit event, not process.kill(pid, 0): a killed child sits as a
  // zombie until this process reaps it, and signal 0 succeeds on a zombie.
  let orphanExited = false
  orphan.on('exit', () => { orphanExited = true })
  try {
    // SingletonLock is the symlink Chrome drops once it actually owns the
    // profile; before it exists the render could win the race and prove nothing.
    const held = await until(() => { try { return !!lstatSync(join(slot0, 'SingletonLock')) } catch { return false } })
    assert(held, 'the stand-in orphan never took the profile')
    // Stop it. A *healthy* Chrome holding a profile is not the failure state —
    // the two instances negotiate and the render goes through. What wedges the
    // pipeline is a holder that cannot answer, which is precisely what a
    // half-shut-down Chrome is. SIGSTOP reproduces that without racing a
    // signal into Chrome's startup window.
    process.kill(orphan.pid, 'SIGSTOP')
    const r = render('fig.html', 'orphaned.png', '--theme', 'slate', '--scale', '1')
    assert(r.status === 0, `a render was blocked by an unowned Chrome: ${r.stderr.trim()}`)
    assert(sha('orphaned.png') === baseline, 'output differed from the baseline')
    const reaped = await until(() => orphanExited, 5000)
    assert(reaped, 'the unowned Chrome was left running to block later renders')
  } finally {
    try { process.kill(orphan.pid, 'SIGCONT') } catch {}
    try { process.kill(orphan.pid, 'SIGKILL') } catch {}
  }
}, {
  // The only invariant here that Windows genuinely cannot express, on three
  // counts: Chrome drops no `SingletonLock` symlink there (it uses a lockfile),
  // there is no SIGSTOP to wedge the holder with, and the behaviour under test —
  // killProfileHolders reaping a Chrome nobody owns — is a documented no-op on
  // win32, where Chrome reports "another instance is using the profile" instead.
  // T5 and T6 stay enabled: their earlier Windows results were an artefact of a
  // blind process probe, not of the platform.
  skip: WIN ? 'POSIX only: no SingletonLock, no SIGSTOP, and killProfileHolders is a no-op on win32' : null,
})

await test('SIGTERM at any point in startup leaves no orphan', async () => {
  // Chrome only swallows SIGTERM inside a window during startup, so a single
  // well-timed kill is a coin flip. Sampling fixed points across the window
  // keeps the test deterministic while actually covering the band.
  let interrupted = 0
  for (const delay of [300, 900, 1500, 2100]) {
    const child = renderBg('fig.html', `term-${delay}.png`, '--theme', 'slate', '--scale', '1')
    await sleep(delay)
    // On a fast machine the later samples land after the render already finished.
    // Killing a dead child proves nothing, so count the ones that hit a live one.
    if (child.exitCode === null && child.signalCode === null) interrupted += 1
    child.kill('SIGTERM')
    await child.closed
    const gone = await until(() => isoChromes().length === 0, 10_000)
    assert(gone, `${isoChromes().length} Chrome process(es) survived SIGTERM sent ${delay}ms in`)
  }
  assert(interrupted > 0, 'every sample landed after the render had finished — the startup window was never hit')
  const after = render('fig.html', 'after-term.png', '--theme', 'slate', '--scale', '1')
  assert(after.status === 0, `the next render failed: ${after.stderr.trim()}`)
  assert(sha('after-term.png') === baseline, 'the next render produced different output')
})

await test('SIGKILL is recovered from by the following run', async () => {
  const child = renderBg('fig.html', 'kill.png', '--theme', 'slate', '--scale', '1')
  const appeared = await until(() => isoChromes().length > 0)
  assert(appeared, 'Chrome never started')
  child.kill('SIGKILL')
  await child.closed
  // Nothing ran on the way out, so the litter is real: a stale lock, an orphaned
  // Chrome, and the hidden theme copy sitting in the project directory.
  assert(strays().length > 0 || isoTemp(/\.lock$/).length > 0, 'expected a hard kill to leave something behind')
  const after = render('fig.html', 'after-kill.png', '--theme', 'slate', '--scale', '1')
  assert(after.status === 0, `the next render failed: ${after.stderr.trim()}`)
  assert(strays().length === 0, `hidden theme copies left in the project dir: ${strays().join(', ')}`)
})

if (!quick) {
  await test('animation cleans up its frame directory', async () => {
    const r = spawnSync(process.execPath,
      [join(SCRIPTS, 'animate.mjs'), 'seq.html', 'anim.gif', '--theme', 'ember', '--transition', '0', '--jobs', '2', '--scale', '1'],
      { cwd: work, env, encoding: 'utf8' })
    assert(r.status === 0, `exit ${r.status}: ${r.stderr.trim()}`)
    const gif = readFileSync(join(work, 'anim.gif'))
    assert(gif.subarray(0, 6).toString('ascii') === 'GIF89a', 'not a GIF89a')
    assert(isoTemp(/^frames-/).length === 0, 'frame directory left behind')
  })
}

await test('temp dir is left clean', async () => {
  const locks = isoTemp(/\.lock$/)
  const tombs = isoTemp(/\.stale$/)
  const frames = isoTemp(/^frames-/)
  assert(locks.length === 0, `locks left: ${locks.join(', ')}`)
  assert(tombs.length === 0, `rename tombs left: ${tombs.join(', ')}`)
  assert(frames.length === 0, `frame dirs left: ${frames.join(', ')}`)
  assert(strays().length === 0, `hidden theme copies left: ${strays().join(', ')}`)
  assert(isoChromes().length === 0, `${isoChromes().length} Chrome process(es) still running`)
})

await test('a missing stylesheet fails before Chrome launches', async () => {
  writeFileSync(join(work, 'broken.html'),
    '<html><head><link rel="stylesheet" href="themes/nope.css"></head><body style="width:400px;height:200px"></body></html>')
  const started = Date.now()
  const r = render('broken.html', 'broken.png', '--scale', '1')
  assert(r.status !== 0, 'a missing stylesheet was accepted')
  assert(/Stylesheet not found/.test(r.stderr), `unexpected message: ${r.stderr.trim()}`)
  assert(Date.now() - started < 2000, 'the check ran too late to have preceded Chrome')
  assert(!existsSync(join(work, 'broken.png')), 'a PNG was written anyway')
})

await test('a blank canvas is rejected, not shipped', async () => {
  writeFileSync(join(work, 'blank.css'), '/* resolves, defines nothing */')
  writeFileSync(join(work, 'blank.html'),
    '<html><head><link rel="stylesheet" href="blank.css"></head>' +
    '<body style="width:400px;height:200px;background:#fff;overflow:hidden"></body></html>')
  const r = render('blank.html', 'blank.png', '--scale', '1')
  assert(r.status !== 0, 'an all-white canvas was reported as a success')
  assert(/no content/.test(r.stderr), `unexpected message: ${r.stderr.trim()}`)
})

await test('a real template with no content is rejected, furniture and all', async () => {
  // The blank test above uses an empty body, so a distinct-colour count alone is
  // enough to fail it. This one is the case that count cannot see: a real
  // template whose content is gone but whose .glow/.dots gradient still paints
  // 169 distinct colours. Only the luminance spread separates it from a figure.
  writeFileSync(join(work, 'furniture.html'),
    readFileSync(join(work, 'fig.html'), 'utf8').replace(/<svg[\s\S]*?<\/svg>/gi, ''))
  const r = render('furniture.html', 'furniture.png', '--theme', 'ember', '--scale', '1')
  assert(r.status !== 0, 'a content-free render of a real template was reported as a success')
  assert(/no content/.test(r.stderr), `unexpected message: ${r.stderr.trim()}`)
})

await test('a truncated PNG is rejected, not reported as a success', async () => {
  const r = render('fig.html', 'trunc.png', '--theme', 'slate', '--scale', '1')
  assert(r.status === 0, `setup render failed: ${r.stderr.trim()}`)
  const full = readFileSync(join(work, 'trunc.png'))
  writeFileSync(join(work, 'trunc.png'), full.subarray(0, Math.floor(full.length * 0.6)))
  let caught = null
  try { assertPng(join(work, 'trunc.png')) } catch (err) { caught = err }
  assert(caught, 'a PNG cut to 60% of its bytes was accepted')
  assert(/truncated/.test(caught.message), `unexpected message: ${caught.message}`)
})

await test('every shipped preview still passes the content guard', async () => {
  // The false-positive guard, and the reason the ink threshold can be trusted:
  // six real pipeline outputs across four themes and five templates, no Chrome
  // launched. A stricter guard's real risk is rejecting good renders.
  const dir = join(SKILL_DIR, '..', '..', 'previews')
  const pngs = ls(dir, /\.png$/)
  assert(pngs.length >= 5, `expected the shipped previews, found ${pngs.length}`)
  for (const f of pngs) assertPng(join(dir, f))
})

await test('bad flag values are refused before Chrome starts', async () => {
  for (const args of [
    ['--size', 'zzz'], ['--size', '100'], ['--scale', 'abc'], ['--scale', '0'],
    ['--theme', 'nosuch'], ['--them', 'paper'],
  ]) {
    const r = render('fig.html', 'never.png', ...args)
    assert(r.status !== 0, `${args.join(' ')} was accepted`)
    assert(!existsSync(join(work, 'never.png')), `${args.join(' ')} wrote a PNG anyway`)
  }
})

await test('doctor cleans up on a machine with no browser', async () => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'doctor.mjs'), '--json'],
    { cwd: work, env: { ...env, CHROME_PATH: '/nonexistent/chrome' }, encoding: 'utf8' })
  assert(r.status === 0, `doctor exited ${r.status}: ${r.stderr.trim()}`)
  const report = JSON.parse(r.stdout)
  assert(report.chrome === null, `expected no browser, got ${report.chrome}`)
  assert(report.reaped, 'no reap report — cleanup did not run')
})

await test('an impossible render fails fast instead of relaunching Chrome', async () => {
  // Regression guard. A --screenshot path Chrome cannot write does not make it
  // exit; it waits out the full 120s timeout. While every failure was treated as
  // worth another slot, one typo meant three Chrome launches over six minutes.
  const started = Date.now()
  const r = render('fig.html', 'nosuchdir/out.png', '--scale', '1')
  const took = Date.now() - started
  assert(r.status !== 0, 'a bad output path was accepted')
  assert(/Output directory does not exist/.test(r.stderr), `unexpected message: ${r.stderr.trim()}`)
  assert(took < 3000, `took ${took}ms — Chrome was launched and waited on`)
  assert(isoChromes().length === 0, 'Chrome was launched for a render that could never succeed')
})

/* ───────────────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok)
const skipped = results.filter((r) => r.skipped)
// Skips are counted separately rather than folded into the pass tally: "16/16
// hold" on a platform where three were never run is the kind of green that hides
// a regression.
const held = results.length - failed.length - skipped.length
console.log(
  `\n${held}/${results.length - skipped.length} invariants hold` +
    (skipped.length ? `, ${skipped.length} skipped on ${process.platform}` : '') +
    (keep ? `  (scratch kept at ${root})` : ''),
)
if (skipped.length) console.log(`skipped: ${skipped.map((s) => s.name).join('; ')}`)
if (failed.length) {
  console.log(`failed: ${failed.map((f) => f.name).join('; ')}`)
  process.exit(1)
}
