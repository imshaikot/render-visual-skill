// Shared entry-point plumbing: where the skill lives, and argument parsing that
// refuses to guess.
//
// Both renderers used to carry their own copy of the positional/opt parser, and
// only animate.mjs validated its numbers — so `render.mjs in.html out.png --size
// zzz` printed "wrote out.png (zzzxundefined @2x = NaNxNaN)" and exited 0. A
// wrong image reported as a success is the worst thing this pipeline can do, so
// every value is parsed through something that can fail here.

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ── Where the skill lives ──────────────────────────────────────────────── */
// Anchored to this file, never to the working directory. Installed under
// ~/.claude/skills, ~/.agents/skills or a plugin cache, the renderer is invoked
// from whatever project the user happens to be in, and every relative path
// resolved against that cwd would point at nothing. Node resolves ESM specifiers
// through symlinks, so a symlinked dev install reports its real location, which
// is the one that actually holds templates/ and themes/.
export const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
export const SKILL_ROOT = dirname(SCRIPTS_DIR)
export const TEMPLATES_DIR = join(SKILL_ROOT, 'templates')
export const THEMES_DIR = join(SKILL_ROOT, 'themes')

/* ── Themes ─────────────────────────────────────────────────────────────── */

/** Every theme the skill ships, by bare name, sorted. */
export function listThemes() {
  try {
    return readdirSync(THEMES_DIR)
      .filter((f) => f.endsWith('.css'))
      .map((f) => f.slice(0, -4))
      .sort()
  } catch {
    return []
  }
}

/**
 * Absolute path to a theme's stylesheet, or a fatal error naming what exists.
 *
 * Rejecting an unknown name here is what stops `--theme slat` from silently
 * rendering the page's own stylesheet, and the allowlist doubles as the reason
 * a name can never escape THEMES_DIR.
 */
export function resolveTheme(name) {
  const available = listThemes()
  if (!available.includes(name)) {
    throw new Error(
      `Unknown theme "${name}". Available: ${available.join(', ') || '(none found — is themes/ missing?)'}`,
    )
  }
  return join(THEMES_DIR, `${name}.css`)
}

/* ── Argument parsing ───────────────────────────────────────────────────── */

const distance = (a, b) => {
  // Levenshtein, small enough to inline and only ever run on a typo path.
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

/**
 * Parse argv against a declared spec.
 *
 * `bool` flags take no value; `value` flags consume the next token. Anything
 * else beginning with `--` is a typo, and a typo that parses is how `--them
 * paper` used to render the default theme and exit 0 — so it is fatal, with a
 * did-you-mean when one is close enough to be useful.
 */
export function parseArgs(spec, argv = process.argv.slice(2)) {
  const bool = new Set(spec.bool ?? [])
  const value = new Set(spec.value ?? [])
  const known = [...bool, ...value]

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const name = a.slice(2).split('=')[0]
    if (bool.has(name) || value.has(name)) {
      if (value.has(name) && !a.includes('=') && argv[i + 1] === undefined) {
        fail(`--${name} needs a value.`, spec.usage)
      }
      continue
    }
    const near = known.map((k) => [k, distance(name, k)]).sort((x, y) => x[1] - y[1])[0]
    const hint = near && near[1] <= 2 ? ` Did you mean --${near[0]}?` : ''
    fail(`Unknown option "${a}".${hint}`, spec.usage)
  }

  const positional = argv.filter((a, i) => {
    const prev = argv[i - 1] || ''
    // A bare token is positional unless the token before it was a value-taking
    // flag still waiting for its value.
    return !a.startsWith('--') && !(prev.startsWith('--') && value.has(prev.slice(2)) && !prev.includes('='))
  })

  const opt = (name) => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`))
    if (inline) return inline.slice(name.length + 3)
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const flag = (name) => argv.some((a) => a === `--${name}`)

  const num = (name, def, { min = 0, integer = false } = {}) => {
    const v = opt(name)
    if (v === undefined) return def
    const n = Number(v)
    if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
      fail(`--${name} needs a ${integer ? 'whole ' : ''}number >= ${min}, got "${v}".`, spec.usage)
    }
    return n
  }

  /** `--scale` must be a positive finite number, never NaN dressed up as one. */
  const scale = (name = 'scale', def = 2) => {
    const v = opt(name)
    if (v === undefined) return def
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) fail(`--${name} needs a positive number, got "${v}".`, spec.usage)
    return n
  }

  /** `WxH`, both positive integers. Returns numbers, so no NaN reaches Chrome. */
  const size = (name = 'size') => {
    const v = opt(name)
    if (v === undefined) return undefined
    const m = /^(\d+)x(\d+)$/.exec(v.trim())
    if (!m) fail(`--${name} must look like WxH, e.g. 1360x740 — got "${v}".`, spec.usage)
    const [w, h] = [Number(m[1]), Number(m[2])]
    if (w <= 0 || h <= 0) fail(`--${name} needs positive dimensions, got "${v}".`, spec.usage)
    return { w, h }
  }

  const theme = (name = 'theme') => {
    const v = opt(name)
    if (v === undefined) return undefined
    try {
      return { name: v, file: resolveTheme(v) }
    } catch (err) {
      fail(err.message, spec.usage)
    }
  }

  return { argv, positional, opt, flag, num, scale, size, theme }
}

export function fail(message, usage) {
  console.error(message)
  if (usage) console.error(`usage: ${usage}`)
  process.exit(1)
}

/**
 * Read the input HTML, failing with the resolved path and the cwd it was
 * resolved against. A bare ENOENT stack is useless when the whole class of bug
 * is "the agent ran this from the wrong directory".
 */
export function readInput(input) {
  const abs = resolve(input)
  if (!existsSync(abs)) {
    fail(`Input not found: ${abs}\n  (resolved against cwd ${process.cwd()})`)
  }
  return abs
}
