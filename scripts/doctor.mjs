#!/usr/bin/env node
// Preflight and cleanup for the render pipeline. Run it before a batch, or any
// time renders start failing with "is another instance using profile".
//
//   node scripts/doctor.mjs [--json] [--prune]
//
// Reaps Chromes left holding a profile slot by an interrupted run, clears stale
// locks, rename tombs and abandoned frame dirs, then reports what it found.
// --prune additionally deletes the warm profile dirs that nothing is using;
// they are rebuilt on next use, at about a second of first-launch setup each.

import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome, reapOrphans } from './chrome.mjs'

const json = process.argv.includes('--json')
const prune = process.argv.includes('--prune')

const dirSize = (dir) => {
  let total = 0
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const full = join(dir, e.name)
    try { total += e.isDirectory() ? dirSize(full) : statSync(full).size } catch {}
  }
  return total
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const chrome = findChrome() // exits 1 with its own message when nothing is installed
const reaped = reapOrphans()

// Anything left with a lock is a live render; everything else is ours to prune.
const entries = readdirSync(tmpdir()).sort()
const slots = []
for (const name of entries) {
  if (!/^rendercraft-profile(-\d+)?$/.test(name)) continue
  const dir = join(tmpdir(), name)
  const busy = entries.includes(`${name}.lock`)
  const bytes = dirSize(dir)
  slots.push({ name, bytes, busy })
  if (prune && !busy) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

const total = slots.reduce((sum, s) => sum + s.bytes, 0)
const report = { chrome, reaped, slots, totalBytes: total, pruned: prune }

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`chrome    ${chrome}`)
  console.log(`reaped    ${reaped.chromes.length} orphan Chrome process(es)${reaped.chromes.length ? ` (pids ${reaped.chromes.join(', ')})` : ''}`)
  console.log(`cleared   ${reaped.locks.length} stale lock/tomb file(s), ${reaped.frames.length} abandoned frame dir(s)`)
  if (slots.length) {
    console.log(`profiles  ${slots.length} slot(s), ${mb(total)} total${prune ? ' — pruned the idle ones' : ''}`)
    for (const s of slots) console.log(`          ${s.name.padEnd(28)} ${mb(s.bytes).padStart(9)}${s.busy ? '  (in use)' : ''}`)
    if (!prune && total > 200 * 1024 * 1024) console.log('          run with --prune to reclaim the idle ones')
  } else {
    console.log('profiles  none yet')
  }
  console.log('\nready.')
}
