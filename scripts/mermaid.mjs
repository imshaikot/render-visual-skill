#!/usr/bin/env node
// Mermaid flowchart text -> a themed HTML/SVG page, laid out deterministically.
//
//   node scripts/mermaid.mjs <input.mmd|-> <output.html> [--theme name] [--direction TD|LR]
//                            [--title "..."] [--kicker "..."] [--note "..."] [--template file]
//
// This is a *generator*, not a renderer: it writes an HTML file that
// render.mjs then turns into a PNG, JPEG or PDF through the usual guards. Two
// steps, not one, because the intermediate file is the point — it is ordinary
// themed SVG, so a label can be reworded or a node nudged by hand before the
// shot, and the same file re-renders in any theme.
//
// The shell comes from templates/flowchart.html: everything between its
// FLOW:BEGIN/FLOW:END markers is replaced and its canvas is resized to whatever
// the layout needs. Nothing about colour is decided here — every class the
// generated markup carries is defined by that template, in theme tokens.
//
// The load-bearing rule is the same one the rest of the pipeline runs on: a
// plausible wrong picture is worse than a loud failure. Mermaid syntax this
// engine does not implement is fatal, quoting the line, because a silently
// dropped statement is a flowchart that is missing a step and screenshots
// perfectly. Nothing here ever guesses.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SKILL_ROOT, TEMPLATES_DIR, THEMES_DIR, distance, fail, parseArgs, resolveTheme } from './cli.mjs'

/* ═══ 1. Geometry constants ═══════════════════════════════════════════════
   One place, because the template's example block was generated with these
   numbers and the two have to keep agreeing. */

const PAD_X = 60          // canvas margin left/right
const PAD_TOP = 104       // room for the kicker
const PAD_BOTTOM = 84     // room for the note
const RANK_GAP = 76       // between rank bands — one edge label fits here
const SIB_GAP = 54        // between neighbours on a rank
const GROUP_GAP = 34      // extra separation at a subgraph boundary
const GROUP_PAD = 26      // subgraph box inset around its members
const GROUP_TITLE_H = 26
const DUMMY_W = 22        // the channel a long edge claims in the ordering
const LABEL_H = 20
const NODE_PAD_X = 26
const NODE_PAD_Y = 21
const NODE_MIN_W = 150
const LABEL_MAX_W = 260   // wrap wider labels rather than growing the canvas
const FONT = 15           // node label, display font
const LINE_H = 20
const MONO = 12.5         // edge labels
const CORNER = 12         // rounded elbow radius
const HOP = 9             // crossing bridge radius — SKILL.md §8
const BACK_GAP = 30       // first return channel, right of the layout
const BACK_STEP = 26      // between return channels

/* ═══ 2. The supported subset ═════════════════════════════════════════════ */

// Longest delimiters first: `[[` has to beat `[`, and `[/ … \]` has to beat
// `[/ … /]`. Every entry is matched on BOTH ends, so the order only has to
// separate the prefixes that nest.
const SHAPES = [
  { open: '[[', close: ']]', shape: 'subroutine' },
  { open: '[(', close: ')]', shape: 'cylinder' },
  { open: '[/', close: '\\]', shape: 'trapezoid' },
  { open: '[\\', close: '/]', shape: 'trapezoid-alt' },
  { open: '[/', close: '/]', shape: 'lean-r' },
  { open: '[\\', close: '\\]', shape: 'lean-l' },
  { open: '(((', close: ')))', shape: 'double-circle' },
  { open: '((', close: '))', shape: 'circle' },
  { open: '([', close: '])', shape: 'stadium' },
  { open: '{{', close: '}}', shape: 'hexagon' },
  { open: '{', close: '}', shape: 'diamond' },
  { open: '>', close: ']', shape: 'flag' },
  { open: '[', close: ']', shape: 'rect' },
  { open: '(', close: ')', shape: 'round' },
]

const SHAPE_HELP = `  A[rect]  A(round)  A([stadium])  A[[subroutine]]  A[(cylinder)]  A((circle))
  A(((double)))  A{decision}  A{{hexagon}}  A[/lean/]  A[\\lean\\]  A[/trapezoid\\]  A>flag]`

const LINK_HELP = `  A --> B   A --- B   A -.-> B   A ==> B   A --o B   A --x B   A <--> B
  A -->|label| B        A -- label --> B        A & B --> C        A --> B --> C`

/* ═══ 3. Parsing ══════════════════════════════════════════════════════════ */

class MermaidError extends Error {}
const bail = (line, msg, help) => {
  throw new MermaidError(
    `${msg}\n  line ${line.n}: ${line.raw.trim()}` + (help ? `\n${help}` : ''),
  )
}

/**
 * Strip `%%` comments outside quotes and bracketed labels.
 *
 * Mermaid treats `%%` as a comment wherever it appears, but a label may
 * legitimately hold one, so depth and quote state are tracked rather than the
 * whole line being split on the token.
 */
function stripComment(s) {
  let depth = 0, quote = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"') quote = !quote
    else if (!quote && '[({'.includes(c)) depth++
    else if (!quote && '])}'.includes(c)) depth--
    else if (!quote && depth <= 0 && c === '%' && s[i + 1] === '%') return s.slice(0, i)
  }
  return s
}

/** Does this text look like a mermaid flowchart? Used to refuse the wrong input loudly. */
export function looksLikeMermaid(text) {
  return /^\s*(?:---[\s\S]*?---\s*)?(?:%%[^\n]*\n\s*)*(?:flowchart|graph)\b/m.test(unfence(text))
}

/** Unwrap a ```mermaid fence, which is how the text almost always arrives. */
function unfence(text) {
  const m = text.match(/```+\s*mermaid[^\n]*\n([\s\S]*?)\n?```+/i)
  if (m) return m[1]
  const bare = text.match(/```+[^\n]*\n([\s\S]*?)\n?```+/)
  return bare ? bare[1] : text
}

const DIRECTIONS = ['TB', 'TD', 'BT', 'LR', 'RL']

/**
 * Split a statement into node chunks and the links between them.
 *
 * Scanned at bracket depth 0 only, so `A[a --> b]` is one node and not a link,
 * and the labelled form is tried before the bare one — `A -- yes --> B` is a
 * single labelled link, not `--` followed by `-->`.
 */
const TEXT_LINK = /^([<ox])?(--|==|-\.)[ \t]+([^|]*?)[ \t]+(-{2,}|={2,}|\.{1,3}-)([>ox])?(?=[\s]|$)/
const BARE_LINK = /^([<ox])?(-{2,}|={2,}|-\.{1,3}-)([>ox])?/

function splitChain(stmt, line) {
  const parts = []           // alternating: chunk, link, chunk, link, chunk…
  let buf = ''
  let depth = 0, quote = false
  for (let i = 0; i < stmt.length; ) {
    const c = stmt[i]
    if (c === '"') { quote = !quote; buf += c; i++; continue }
    if (!quote) {
      if ('[({'.includes(c)) depth++
      else if ('])}'.includes(c)) depth--
      if (depth === 0 && (c === '-' || c === '=' || c === '<' || c === 'o' || c === 'x')) {
        const rest = stmt.slice(i)
        const t = TEXT_LINK.exec(rest)
        const b = t ? null : BARE_LINK.exec(rest)
        const m = t ?? b
        // `o`/`x` only start a link when a dash run follows; otherwise they are
        // the first letter of an id, and eating them would rename the node.
        // `<` is never an id character, so it always is one.
        if (m && (t || /^[-=<]/.test(m[0]) || /^[ox][-=]/.test(m[0]))) {
          const link = readLink(m, t ? 'text' : 'bare', line)
          let taken = m[0].length
          // The other label form: `A -->|yes| B`. Consumed here rather than left
          // to the node reader, which would otherwise see `|yes| B` as an id.
          const pipe = /^\s*\|([^|]*)\|/.exec(rest.slice(taken))
          if (pipe) {
            if (link.label !== null) bail(line, 'This link carries two labels — one in the arrow and one in pipes.')
            link.label = unquote(pipe[1])
            taken += pipe[0].length
          }
          parts.push(buf.trim())
          parts.push(link)
          buf = ''
          i += taken
          continue
        }
      }
    }
    buf += c
    i++
  }
  parts.push(buf.trim())
  return parts
}

function readLink(m, kind, line) {
  const [, lh, a, third, fourth, fifth] = m
  const body = kind === 'text' ? a + fourth : a
  const label = kind === 'text' ? third.trim() : null
  const rh = kind === 'text' ? fifth : third
  const style = body.includes('=') ? 'thick' : body.includes('.') ? 'dotted' : 'solid'
  const heads = { '>': 'arrow', o: 'dot', x: 'cross' }
  if (lh && lh !== '<' && !heads[lh]) bail(line, `Unsupported link head "${lh}".`, LINK_HELP)
  return {
    style,
    label: label ? unquote(label) : null,
    end: rh ? heads[rh] : 'none',
    start: lh ? (lh === '<' ? 'arrow' : heads[lh]) : 'none',
  }
}

const unquote = (s) => (/^".*"$/s.test(s.trim()) ? s.trim().slice(1, -1) : s.trim())

/** `A[Label]:::cls` -> `{ id, label, shape, cls }`. */
function readNodeToken(chunk, line) {
  let cls = null
  const c = chunk.replace(/:::\s*([A-Za-z_][\w-]*)\s*$/, (_, name) => { cls = name; return '' }).trim()
  if (!c) bail(line, 'A link has nothing on one side of it.', LINK_HELP)
  if (/^[A-Za-z_][\w-]*@\{/.test(c)) {
    bail(line, `The @{ shape: … } node syntax is not implemented.`, `  Use a bracket shape instead:\n${SHAPE_HELP}`)
  }
  for (const s of SHAPES) {
    const i = c.indexOf(s.open)
    if (i > 0 && c.endsWith(s.close) && c.length >= i + s.open.length + s.close.length) {
      const id = c.slice(0, i).trim()
      const label = unquote(c.slice(i + s.open.length, c.length - s.close.length))
      if (!/^[\w.-]+$/.test(id)) bail(line, `"${id}" is not a usable node id.`, '  Ids are letters, digits, _ . and -')
      return { id, label: label || id, shape: s.shape, cls }
    }
  }
  if (/[[\](){}<>]/.test(c)) {
    bail(line, `Cannot read "${c}" as a node — the brackets do not pair up.`, `  Shapes this engine draws:\n${SHAPE_HELP}`)
  }
  if (!/^[\w.-]+$/.test(c)) bail(line, `"${c}" is not a usable node id.`, '  Ids are letters, digits, _ . and -')
  return { id: c, label: null, shape: null, cls }
}

/** Parse mermaid flowchart source into a graph. Anything unimplemented is fatal. */
export function parseMermaid(text) {
  const src = unfence(text)
  const notes = []
  let title = null

  // `---\ntitle: …\n---` front matter: mermaid's own, and the best title there is.
  let body = src
  const fm = src.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (fm) {
    const t = fm[1].match(/^\s*title\s*:\s*(.+?)\s*$/m)
    if (t) title = unquote(t[1])
    body = src.slice(fm[0].length)
  }

  const nodes = new Map()
  const edges = []
  const subgraphs = []
  const classDefs = []      // declaration order decides which accent a class gets
  const classOf = new Map()
  let direction = null
  const stack = []          // open subgraphs

  const rawLines = body.split(/\r?\n/)
  for (let n = 0; n < rawLines.length; n++) {
    const raw = rawLines[n]
    const line = { n: n + 1, raw }
    if (/^\s*%%\{/.test(raw)) { notes.push(`ignored an %%{init}%% directive on line ${n + 1} — the theme comes from --theme`); continue }
    const noComment = stripComment(raw).trim()
    if (!noComment) continue

    for (const stmt of splitStatements(noComment)) {
      if (!stmt) continue
      const head = /^(flowchart|graph)\b\s*(\S+)?/i.exec(stmt)
      if (head) {
        const d = (head[2] ?? 'TB').toUpperCase().replace(/;$/, '')
        if (!DIRECTIONS.includes(d)) {
          bail(line, `Unknown direction "${head[2]}".`, `  One of: ${DIRECTIONS.join(', ')}`)
        }
        if (direction && direction !== d) bail(line, `A second, different diagram header — one graph per file.`)
        direction = d
        continue
      }
      if (/^subgraph\b/i.test(stmt)) {
        if (stack.length) {
          bail(line, 'Nested subgraphs are not implemented.', '  Flatten them, or draw the nesting by hand from templates/cluster.html.')
        }
        const rest = stmt.replace(/^subgraph\s*/i, '').trim()
        const tok = rest ? readNodeToken(rest, line) : { id: `sg${subgraphs.length + 1}`, label: null }
        const g = { id: tok.id, title: tok.label ?? tok.id, members: [] }
        subgraphs.push(g)
        stack.push(g)
        continue
      }
      if (/^end\b/i.test(stmt)) {
        if (!stack.length) bail(line, 'An "end" with no open subgraph.')
        stack.pop()
        continue
      }
      if (/^direction\b/i.test(stmt)) {
        bail(line, 'A per-subgraph "direction" is not implemented.', '  One direction per diagram; set it on the header.')
      }
      if (/^classDef\b/i.test(stmt)) {
        const m = /^classDef\s+([\w,-]+)\s*(.*)$/i.exec(stmt)
        if (!m) bail(line, 'Could not read this classDef.', '  classDef <name> <properties>')
        for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
          if (!classDefs.includes(name)) classDefs.push(name)
        }
        if (m[2].trim()) notes.push(`classDef ${m[1]}: colour properties dropped — themes own colour here (SKILL.md §4)`)
        continue
      }
      if (/^class\b/i.test(stmt)) {
        const m = /^class\s+([\w,.-]+)\s+([\w-]+)\s*$/i.exec(stmt)
        if (!m) bail(line, 'Could not read this class assignment.', '  class <id>[,<id>…] <className>')
        if (!classDefs.includes(m[2])) classDefs.push(m[2])
        for (const id of m[1].split(',').map((s) => s.trim()).filter(Boolean)) classOf.set(id, m[2])
        continue
      }
      if (/^(style|linkStyle|click|callback|href|accTitle|accDescr)\b/i.test(stmt)) {
        const kw = /^(\w+)/.exec(stmt)[1]
        bail(
          line,
          `"${kw}" is not implemented, and ignoring it would quietly change the picture.`,
          kw === 'style' || kw === 'linkStyle'
            ? '  Colour comes from the theme — use classDef/:::name and let the accent be chosen (SKILL.md §4).'
            : '  Delete the line: a PNG has nothing to click and no accessibility tree.',
        )
      }

      // Anything left is a node/edge chain.
      const parts = splitChain(stmt, line)
      const groups = []
      for (let i = 0; i < parts.length; i += 2) {
        const chunk = parts[i]
        if (!chunk) bail(line, 'A link has nothing on one side of it.', LINK_HELP)
        const ids = splitAmp(chunk).map((c) => {
          const tok = readNodeToken(c, line)
          const node = nodes.get(tok.id) ?? { id: tok.id, label: tok.id, shape: 'rect', group: null }
          if (tok.label !== null) node.label = tok.label
          if (tok.shape !== null) { node.shape = tok.shape; node.declared = true }
          if (tok.cls) classOf.set(tok.id, tok.cls)
          if (tok.cls && !classDefs.includes(tok.cls)) classDefs.push(tok.cls)
          if (!nodes.has(tok.id)) nodes.set(tok.id, node)
          if (stack.length && node.group === null) {
            node.group = stack[0].id
            stack[0].members.push(tok.id)
          }
          return tok.id
        })
        groups.push(ids)
      }
      for (let i = 1; i < parts.length; i += 2) {
        for (const from of groups[(i - 1) / 2]) {
          for (const to of groups[(i + 1) / 2]) edges.push({ from, to, ...parts[i] })
        }
      }
    }
  }

  if (stack.length) throw new MermaidError(`Subgraph "${stack[0].id}" is never closed with "end".`)
  if (!direction) {
    throw new MermaidError(
      'No diagram header. The first statement must be "flowchart TD" or "graph LR".\n' +
        `  Directions: ${DIRECTIONS.join(', ')}`,
    )
  }
  if (!nodes.size) throw new MermaidError('The diagram declares no nodes.')

  // Four accents is the palette (SKILL.md §4); a fifth class would have to
  // reuse one, which merges two things the source draws as different.
  if (classDefs.length > 4) {
    throw new MermaidError(
      `${classDefs.length} classes (${classDefs.join(', ')}) but only four accents exist.\n` +
        '  Accents carry meaning here, not variety — merge the classes down to at most four.',
    )
  }
  const accentOfClass = new Map()
  classDefs.forEach((name, i) => {
    // A class literally named for an accent takes that one; the rest are handed
    // out in declaration order. Either way the mapping is printed, never guessed at.
    const explicit = /^(?:a|accent)([1-4])$/i.exec(name)
    accentOfClass.set(name, explicit ? Number(explicit[1]) : i + 1)
  })
  for (const [id] of classOf) {
    if (!nodes.has(id)) throw new MermaidError(`class assigned to "${id}", which is not a node in this diagram.`)
  }
  for (const g of subgraphs) if (!g.members.length) notes.push(`subgraph "${g.id}" holds no nodes — not drawn`)

  // `X --> CI`, where CI is a subgraph, is an edge to a cluster. It is attached
  // to the nodes the cluster starts and ends at, and said so out loud: silently
  // inventing a node called CI — which is what an unresolved id would do — puts
  // a box in the picture that the source never asked for.
  const byGroup = new Map(subgraphs.map((g) => [g.id, g]))
  for (const g of subgraphs) {
    const ghost = nodes.get(g.id)
    if (!ghost) continue
    if (ghost.declared) {
      throw new MermaidError(`"${g.id}" is used as both a subgraph and a node. Give one of them another id.`)
    }
    nodes.delete(g.id)
    classOf.delete(g.id)
  }
  const inner = (g, dir) => {
    const mem = new Set(g.members)
    const touched = new Set(
      edges.filter((e) => mem.has(e.from) && mem.has(e.to)).map((e) => (dir === 'in' ? e.to : e.from)),
    )
    const open = g.members.filter((id) => !touched.has(id))
    return open.length ? open : [dir === 'in' ? g.members[0] : g.members[g.members.length - 1]]
  }
  const resolved = []
  for (const e of edges) {
    const fromG = byGroup.get(e.from), toG = byGroup.get(e.to)
    if (!fromG && !toG) { resolved.push(e); continue }
    for (const g of [fromG, toG]) {
      if (g && !g.members.length) throw new MermaidError(`edge references subgraph "${g.id}", which holds no nodes.`)
    }
    const froms = fromG ? inner(fromG, 'out') : [e.from]
    const tos = toG ? inner(toG, 'in') : [e.to]
    notes.push(
      `edge ${e.from} -> ${e.to} names a subgraph; attached to ` +
        `${froms.join('/')} -> ${tos.join('/')}`,
    )
    for (const f of froms) for (const t of tos) resolved.push({ ...e, from: f, to: t })
  }
  edges.length = 0
  edges.push(...resolved)

  for (const e of edges) {
    for (const side of [e.from, e.to]) {
      if (!nodes.has(side)) {
        const near = [...nodes.keys()].map((k) => [k, distance(side, k)]).sort((x, y) => x[1] - y[1])[0]
        throw new MermaidError(
          `edge references "${side}", which is not a node or a subgraph.` +
            (near && near[1] <= 2 ? ` Did you mean "${near[0]}"?` : ''),
        )
      }
    }
  }

  for (const [id, node] of nodes) node.accent = accentOfClass.get(classOf.get(id)) ?? null
  return {
    direction, title, notes,
    nodes: [...nodes.values()],
    edges,
    subgraphs: subgraphs.filter((g) => g.members.length),
    classes: [...accentOfClass].map(([name, accent]) => ({ name, accent })),
  }
}

/** `;`-separated statements, at depth 0. */
function splitStatements(s) {
  const out = []
  let buf = '', depth = 0, quote = false
  for (const c of s) {
    if (c === '"') quote = !quote
    else if (!quote && '[({'.includes(c)) depth++
    else if (!quote && '])}'.includes(c)) depth--
    if (c === ';' && !quote && depth === 0) { out.push(buf.trim()); buf = '' } else buf += c
  }
  out.push(buf.trim())
  return out.filter(Boolean)
}

/** `A & B` -> two chunks, at depth 0. */
function splitAmp(s) {
  const out = []
  let buf = '', depth = 0, quote = false
  for (const c of s) {
    if (c === '"') quote = !quote
    else if (!quote && '[({'.includes(c)) depth++
    else if (!quote && '])}'.includes(c)) depth--
    if (c === '&' && !quote && depth === 0) { out.push(buf.trim()); buf = '' } else buf += c
  }
  out.push(buf.trim())
  return out.filter(Boolean)
}

/* ═══ 4. Measuring ════════════════════════════════════════════════════════
   There is no browser at generate time, so every box is sized from an
   estimate. The estimate is deliberately generous and long labels wrap rather
   than stretch: a box a little too wide is invisible, a label that overflows
   its box is the one defect assertPng cannot see. */

const NARROW = "iljI.,;:'|!()[]{}/\\`"
const THIN = 'ftr-'
const WIDE = 'mwMW'

/** Width of one line in px, for the display font at `size`. */
function textWidth(s, size) {
  let em = 0
  for (const ch of s) {
    if (ch === ' ') em += 0.26
    else if (NARROW.includes(ch)) em += 0.3
    else if (THIN.includes(ch)) em += 0.4
    else if (WIDE.includes(ch)) em += 0.86
    else if (ch >= 'A' && ch <= 'Z') em += 0.66
    else if (ch >= '0' && ch <= '9') em += 0.58
    else em += 0.55
  }
  return em * size
}

/** Mono is the one font with a width you can state: SKILL.md §8, ~0.6em. */
const monoWidth = (s, size = MONO) => s.length * 0.6 * size

/**
 * What to size a box by.
 *
 * The display font is the theme's, and the themes disagree: `terminal` sets it
 * to a monospace, `paper` and `sepia` to a serif, both wider than the sans the
 * table above is tuned for. Every box is therefore sized by whichever is wider,
 * the estimate or a near-mono run — the box being a little roomy costs nothing,
 * and a label wider than the box it sits in is a defect no guard downstream can
 * see.
 */
const labelWidth = (s, size) => Math.max(textWidth(s, size), monoWidth(s, size) * 0.92)

/** Break a label into lines: explicit `<br/>` first, then greedy wrap. */
function wrapLabel(label, maxW, size) {
  const out = []
  for (const chunk of label.split(/<br\s*\/?>/i)) {
    const words = chunk.trim().split(/\s+/).filter(Boolean)
    if (!words.length) continue
    let line = words[0]
    for (const w of words.slice(1)) {
      if (labelWidth(`${line} ${w}`, size) <= maxW) line += ` ${w}`
      else { out.push(line); line = w }
    }
    out.push(line)
  }
  return out.length ? out : ['']
}

/** The same greedy wrap against the mono metric, for the footnote. */
function wrapMono(text, maxW) {
  const words = String(text).trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const out = []
  let line = words[0]
  for (const w of words.slice(1)) {
    if (monoWidth(`${line} ${w}`) <= maxW) line += ` ${w}`
    else { out.push(line); line = w }
  }
  out.push(line)
  return out
}

/** Fix each node's drawn size from its wrapped label and its shape. */
function measure(nodes) {
  for (const n of nodes) {
    n.lines = wrapLabel(n.label, LABEL_MAX_W, FONT)
    const tw = Math.max(...n.lines.map((l) => labelWidth(l, FONT)))
    const th = n.lines.length * LINE_H
    let w = Math.max(NODE_MIN_W, tw + 2 * NODE_PAD_X)
    let h = Math.max(60, th + 2 * NODE_PAD_Y)
    switch (n.shape) {
      case 'diamond': w = tw * 1.7 + 48; h = th * 1.75 + 36; break
      case 'circle': case 'double-circle': {
        const r = Math.hypot(tw / 2 + 10, th / 2 + 10) + (n.shape === 'circle' ? 12 : 20)
        w = h = Math.max(2 * r, 104)
        break
      }
      case 'hexagon': w += 44; break
      case 'stadium': w += 18; break
      case 'cylinder': h += 24; break
      case 'lean-r': case 'lean-l': w += 40; break
      case 'trapezoid': case 'trapezoid-alt': w += 52; break
      case 'subroutine': w += 28; break
      case 'flag': w += 22; break
    }
    n.w = Math.round(w)
    n.h = Math.round(h)
  }
}

/* ═══ 5. Layout ═══════════════════════════════════════════════════════════
   Everything below works in (along, across): `along` is the rank axis and runs
   in the flow direction, `across` is the one nodes on a rank spread over. The
   direction only decides how that pair maps to x/y at the very end, so TD and
   LR share one layout engine instead of two that can disagree. */

/** Depth-first pass that names the edges closing a cycle. They are routed as returns. */
function findBackEdges(nodes, edges) {
  const out = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges) if (e.from !== e.to) out.get(e.from).push(e)
  const state = new Map(nodes.map((n) => [n.id, 0])) // 0 unseen, 1 on stack, 2 done
  const back = new Set()
  const walk = (id) => {
    state.set(id, 1)
    for (const e of out.get(id)) {
      const s = state.get(e.to)
      if (s === 1) back.add(e)
      else if (s === 0) walk(e.to)
    }
    state.set(id, 2)
  }
  // Declaration order, so the same source always produces the same picture.
  for (const n of nodes) if (state.get(n.id) === 0) walk(n.id)
  return back
}

/** Longest-path ranking over the acyclic part. */
function assignRanks(nodes, edges, back) {
  const forward = edges.filter((e) => !back.has(e) && e.from !== e.to)
  const rank = new Map(nodes.map((n) => [n.id, 0]))
  // Relaxed |V| times: enough for any DAG, and a hard stop rather than a loop
  // that could spin if the back-edge pass ever missed one.
  for (let i = 0; i < nodes.length; i++) {
    let moved = false
    for (const e of forward) {
      const want = rank.get(e.from) + 1
      if (want > rank.get(e.to)) { rank.set(e.to, want); moved = true }
    }
    if (!moved) break
  }
  return rank
}

const sep = (a, b) => SIB_GAP + (a.group !== b.group ? GROUP_GAP : 0)

/** Does the flow run down the page? Decides how (along, across) maps to (x, y). */
const isVertical = (d) => d === 'TB' || d === 'TD' || d === 'BT'

function layout(model) {
  const { nodes, edges } = model
  measure(nodes)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const back = findBackEdges(nodes, edges)
  const rankOf = assignRanks(nodes, edges, back)
  const depth = Math.max(...nodes.map((n) => rankOf.get(n.id))) + 1

  // Ranks hold real nodes and the dummies a multi-rank edge needs. A dummy
  // claims a channel in the ordering, which is what keeps a long edge from
  // being drawn straight through whatever happens to sit under it.
  const ranks = Array.from({ length: depth }, () => [])
  // A node is measured in page terms — a label is wide, not "long along the
  // flow" — so which of its two sides faces the rank axis depends on the
  // direction. Getting this backwards transposes every box on the page.
  const vertical = isVertical(model.direction)
  for (const n of nodes) {
    n.rank = rankOf.get(n.id)
    n.aSize = vertical ? n.h : n.w
    n.cSize = vertical ? n.w : n.h
    n.preds = []
    n.succs = []
    ranks[n.rank].push(n)
  }
  for (const e of edges) {
    e.back = back.has(e)
    e.self = e.from === e.to
    e.chain = null
    if (e.back || e.self) continue
    const a = byId.get(e.from), b = byId.get(e.to)
    const span = b.rank - a.rank
    if (span <= 1) { a.succs.push(b); b.preds.push(a); continue }
    const chain = []
    let prev = a
    for (let r = a.rank + 1; r < b.rank; r++) {
      const d = { id: `~${e.from}~${e.to}~${r}`, dummy: true, owner: e, rank: r, aSize: 0, cSize: DUMMY_W, group: a.group === b.group ? a.group : null, preds: [], succs: [] }
      ranks[r].push(d)
      prev.succs.push(d)
      d.preds.push(prev)
      chain.push(d)
      prev = d
    }
    prev.succs.push(b)
    b.preds.push(prev)
    e.chain = chain
  }

  orderRanks(ranks)
  placeAcross(ranks)
  separateGroups(ranks, model.subgraphs, byId)

  // Cross-axis placement is independent of the flow axis, so which edges turn
  // in which gap is already known — and that is what the gap has to be sized
  // for. Two elbows sharing one gap draw the same horizontal twice and read as
  // a single line joining four nodes that are not joined.
  const lanes = assignLanes(edges, byId)
  const gaps = Array.from({ length: depth }, (_, r) => Math.max(RANK_GAP, 26 * ((lanes.perGap.get(r)?.length ?? 0) + 1)))
  const bands = placeAlong(ranks, gaps)
  return { ranks, byId, depth, bands, gaps, laneOf: lanes.laneOf }
}

/** Barycentre sweeps, with subgraph members kept together. */
function orderRanks(ranks) {
  const index = () => ranks.forEach((r) => r.forEach((n, i) => { n.order = i }))
  index()
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0
    const seq = down ? [...ranks.keys()].slice(1) : [...ranks.keys()].reverse().slice(1)
    for (const ri of seq) {
      const rank = ranks[ri]
      const was = new Map(rank.map((n) => [n, n.order]))
      for (const n of rank) {
        const nbrs = down ? n.preds : n.succs
        n.bary = nbrs.length ? nbrs.reduce((s, m) => s + m.order, 0) / nbrs.length : n.order
      }
      // A subgraph's members share the group's mean, so they sort as one block
      // and the boundary drawn round them afterwards has nothing else inside it.
      const means = new Map()
      for (const n of rank) if (n.group) means.set(n.group, [...(means.get(n.group) ?? []), n.bary])
      for (const [g, vals] of means) means.set(g, vals.reduce((s, v) => s + v, 0) / vals.length)
      const primary = (n) => (n.group ? means.get(n.group) : n.bary)
      rank.sort((a, b) => primary(a) - primary(b) || a.bary - b.bary || was.get(a) - was.get(b))
      index()
    }
  }
}

/** Cross-axis positions: pack, then pull each node toward its neighbours. */
function placeAcross(ranks) {
  for (const rank of ranks) {
    let right = 0
    rank.forEach((n, i) => {
      const gap = i === 0 ? 0 : sep(rank[i - 1], n)
      n.c = right + gap + n.cSize / 2
      right = n.c + n.cSize / 2
    })
  }
  for (let sweep = 0; sweep < 8; sweep++) {
    const down = sweep % 2 === 0
    const seq = down ? [...ranks.keys()].slice(1) : [...ranks.keys()].reverse().slice(1)
    for (const ri of seq) {
      const rank = ranks[ri]
      const want = rank.map((n) => {
        const nbrs = down ? n.preds : n.succs
        return nbrs.length ? nbrs.reduce((s, m) => s + m.c, 0) / nbrs.length : n.c
      })
      const floor = (i) => (i === 0 ? -Infinity : rank[i - 1].c + rank[i - 1].cSize / 2 + sep(rank[i - 1], rank[i]) + rank[i].cSize / 2)
      for (let i = 0; i < rank.length; i++) rank[i].c = Math.max(want[i], floor(i))
      for (let i = rank.length - 1; i >= 0; i--) {
        const ceil = i === rank.length - 1
          ? Infinity
          : rank[i + 1].c - rank[i + 1].cSize / 2 - sep(rank[i], rank[i + 1]) - rank[i].cSize / 2
        rank[i].c = Math.max(floor(i), Math.min(rank[i].c, Math.max(ceil, floor(i))))
      }
    }
  }
  const min = Math.min(...ranks.flat().map((n) => n.c - n.cSize / 2))
  for (const n of ranks.flat()) n.c -= min
}

/**
 * Push anything that is not a member out of a subgraph's box.
 *
 * Barycentre ordering keeps a group's members adjacent on each rank, which is
 * not the same as keeping outsiders out of the rectangle drawn round them: a
 * group two ranks tall and wide on one of them encloses whatever sits beside it
 * on the other. The boundary is the claim the figure makes about what is inside
 * the system, so a node that is not in the subgraph must not be in the box.
 */
function separateGroups(ranks, subgraphs, byId) {
  if (!subgraphs.length) return
  const spread = (rank) => {
    rank.sort((a, b) => a.c - b.c)
    for (let i = 1; i < rank.length; i++) {
      const min = rank[i - 1].c + rank[i - 1].cSize / 2 + sep(rank[i - 1], rank[i]) + rank[i].cSize / 2
      if (rank[i].c < min) rank[i].c = min
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    let moved = false
    for (const g of subgraphs) {
      const mem = g.members.map((id) => byId.get(id))
      const ranksUsed = new Set(mem.map((n) => n.rank))
      const r0 = Math.min(...ranksUsed), r1 = Math.max(...ranksUsed)
      const c0 = Math.min(...mem.map((n) => n.c - n.cSize / 2)) - GROUP_PAD
      const c1 = Math.max(...mem.map((n) => n.c + n.cSize / 2)) + GROUP_PAD
      const mid = (c0 + c1) / 2
      for (let r = r0; r <= r1; r++) {
        for (const n of ranks[r]) {
          if (n.group === g.id) continue
          // A line entering or leaving the cluster is allowed through; a line
          // that has no business with it is not.
          if (n.dummy && n.owner && (byId.get(n.owner.from)?.group === g.id || byId.get(n.owner.to)?.group === g.id)) continue
          if (n.c + n.cSize / 2 <= c0 || n.c - n.cSize / 2 >= c1) continue
          n.c = n.c < mid ? c0 - SIB_GAP - n.cSize / 2 : c1 + SIB_GAP + n.cSize / 2
          moved = true
        }
        spread(ranks[r])
      }
    }
    if (!moved) break
  }
  const min = Math.min(...ranks.flat().map((n) => n.c - n.cSize / 2))
  for (const n of ranks.flat()) n.c -= min
}

/**
 * Give every elbow in a gap its own lane across that gap.
 *
 * Widest turn first, nearest the rank it leaves: an edge that has a long way to
 * go across gets out of the way early, so the shorter turns behind it stay
 * short instead of running the length of the gap beside it.
 */
function assignLanes(edges, byId) {
  const perGap = new Map()
  for (const e of edges) {
    if (e.back || e.self) continue
    const a = byId.get(e.from), b = byId.get(e.to)
    const cs = [a.c, ...(e.chain ?? []).map((d) => d.c), b.c]
    for (let i = 0; i < cs.length - 1; i++) {
      const span = Math.abs(cs[i] - cs[i + 1])
      if (span <= 0.5) continue
      const g = a.rank + i
      perGap.set(g, [...(perGap.get(g) ?? []), { e, g, span }])
    }
  }
  const frac = new Map()
  for (const [, list] of perGap) {
    list.sort((x, y) => y.span - x.span)
    list.forEach((item, i) => frac.set(`${edges.indexOf(item.e)}:${item.g}`, (i + 1) / (list.length + 1)))
  }
  return { perGap, laneOf: (ei, g) => frac.get(`${ei}:${g}`) ?? 0.5 }
}

/** Rank bands along the flow axis, separated by the gaps their elbows need. */
function placeAlong(ranks, gaps) {
  const bands = []
  let a = 0
  ranks.forEach((rank, r) => {
    const size = Math.max(40, ...rank.map((n) => n.aSize))
    for (const n of rank) n.a0 = a + (size - n.aSize) / 2
    bands.push({ start: a, end: a + size })
    a += size + gaps[r]
  })
  return bands
}

/* ═══ 6. Routing ══════════════════════════════════════════════════════════ */

const eq = (p, q) => Math.abs(p.a - q.a) < 0.5 && Math.abs(p.c - q.c) < 0.5

/** Collapse duplicate and collinear vertices — they would round to nothing. */
function tidy(verts) {
  const out = []
  for (const v of verts) if (!out.length || !eq(out[out.length - 1], v)) out.push(v)
  for (let i = 1; i < out.length - 1; ) {
    const [p, q, r] = [out[i - 1], out[i], out[i + 1]]
    const collinear = (Math.abs(p.a - q.a) < 0.5 && Math.abs(q.a - r.a) < 0.5) || (Math.abs(p.c - q.c) < 0.5 && Math.abs(q.c - r.c) < 0.5)
    if (collinear) out.splice(i, 1)
    else i++
  }
  return out
}

// A shape with a flat top can take a second arrival beside the first; a diamond
// or a circle cannot, because a point 24px off its centre is off the shape.
const POINTED = new Set(['diamond', 'circle', 'double-circle'])
const offsetOf = (n) => (POINTED.has(n.shape) ? 0 : Math.min(24, n.cSize * 0.22))

/** Orthogonal vertices for one edge, in layout space. */
function route(e, ei, byId, L) {
  const a = byId.get(e.from), b = byId.get(e.to)
  if (e.self) {
    const out = a.c + a.cSize / 2
    return tidy([
      { a: a.a0 + a.aSize * 0.32, c: out },
      { a: a.a0 + a.aSize * 0.32, c: out + 38 },
      { a: a.a0 + a.aSize * 0.68, c: out + 38 },
      { a: a.a0 + a.aSize * 0.68, c: out },
    ])
  }
  if (e.back) {
    // Out of the bottom, along a return channel, and back in from above. The
    // long run across happens in the gaps between rank bands and never inside
    // one, which is the whole reason for this shape: a return that cut straight
    // across a band would be drawn through whatever node sits on it.
    const exit = L.after(a.rank)
    const enter = L.before(b.rank)
    const off = e.side * 1
    return tidy([
      { a: a.a0 + a.aSize, c: a.c + off * offsetOf(a) },
      { a: exit, c: a.c + off * offsetOf(a) },
      { a: exit, c: e.channel },
      { a: enter, c: e.channel },
      { a: enter, c: b.c + off * offsetOf(b) },
      { a: b.a0, c: b.c + off * offsetOf(b) },
    ])
  }
  const pts = [
    { a: a.a0 + a.aSize, c: a.c },
    ...(e.chain ?? []).map((d) => ({ a: d.a0, c: d.c })),
    { a: b.a0, c: b.c },
  ]
  const verts = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const p = verts[verts.length - 1], q = pts[i]
    if (Math.abs(p.c - q.c) > 0.5) {
      const g = a.rank + i - 1
      const at = L.lane(ei, g)
      verts.push({ a: at, c: p.c }, { a: at, c: q.c })
    }
    verts.push(q)
  }
  return tidy(verts)
}

/**
 * Where an along-segment crosses another edge's across-segment, so it can hop
 * it instead of running through it — SKILL.md §8. Computed on the vertices
 * before any corner is rounded, and kept clear of the corners by a margin, so
 * a bridge can never land inside an elbow.
 */
function crossings(routes) {
  const across = []
  routes.forEach((verts, ei) => {
    for (let i = 0; i < verts.length - 1; i++) {
      const [p, q] = [verts[i], verts[i + 1]]
      if (Math.abs(p.a - q.a) < 0.5 && Math.abs(p.c - q.c) > 0.5) {
        across.push({ ei, a: p.a, c0: Math.min(p.c, q.c), c1: Math.max(p.c, q.c) })
      }
    }
  })
  return routes.map((verts, ei) => {
    const per = []
    for (let i = 0; i < verts.length - 1; i++) {
      const [p, q] = [verts[i], verts[i + 1]]
      if (Math.abs(p.c - q.c) >= 0.5 || Math.abs(p.a - q.a) < 0.5) { per.push([]); continue }
      const lo = Math.min(p.a, q.a) + CORNER + HOP, hi = Math.max(p.a, q.a) - CORNER - HOP
      const hits = across
        .filter((s) => s.ei !== ei && s.a > lo && s.a < hi && s.c0 < p.c - 1 && s.c1 > p.c + 1)
        .map((s) => s.a)
      hits.sort((x, y) => (q.a > p.a ? x - y : y - x))
      per.push([...new Set(hits)])
    }
    return per
  })
}

/* ═══ 7. Emission ═════════════════════════════════════════════════════════ */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const r1 = (n) => Math.round(n * 10) / 10

/** (along, across) -> (x, y), and whether that mapping mirrors the plane. */
function projector(direction, alongEnd, padA, padC) {
  const map = {
    TB: (a, c) => ({ x: c + padC, y: a + padA }),
    TD: (a, c) => ({ x: c + padC, y: a + padA }),
    BT: (a, c) => ({ x: c + padC, y: alongEnd - a + padA }),
    LR: (a, c) => ({ x: a + padA, y: c + padC }),
    RL: (a, c) => ({ x: alongEnd - a + padA, y: c + padC }),
  }[direction]
  const flip = direction === 'TB' || direction === 'TD' || direction === 'RL'
  return { map, flip }
}

/** A node's drawn box in page space. */
function boxOf(n, P, vertical) {
  const corners = [P.map(n.a0, n.c - n.cSize / 2), P.map(n.a0 + n.aSize, n.c + n.cSize / 2)]
  return {
    x: Math.min(corners[0].x, corners[1].x),
    y: Math.min(corners[0].y, corners[1].y),
    w: vertical ? n.cSize : n.aSize,
    h: vertical ? n.aSize : n.cSize,
  }
}

function shapeMarkup(n, box, cls) {
  const { x, y, w, h } = box
  const [cx, cy] = [x + w / 2, y + h / 2]
  const a = (d, extra = '') => `<path class="${cls}" d="${d}"${extra}/>`
  switch (n.shape) {
    case 'round': return `<rect class="${cls}" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="24"/>`
    case 'stadium': return `<rect class="${cls}" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${r1(h / 2)}"/>`
    case 'subroutine':
      return `<rect class="${cls}" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="14"/>` +
        a(`M${r1(x + 13)} ${r1(y + 3)}V${r1(y + h - 3)}M${r1(x + w - 13)} ${r1(y + 3)}V${r1(y + h - 3)}`, ' fill="none"')
    case 'cylinder': {
      const ry = 12
      return a(`M${r1(x)} ${r1(y + ry)}A${r1(w / 2)} ${ry} 0 0 1 ${r1(x + w)} ${r1(y + ry)}V${r1(y + h - ry)}A${r1(w / 2)} ${ry} 0 0 1 ${r1(x)} ${r1(y + h - ry)}Z`) +
        a(`M${r1(x)} ${r1(y + ry)}A${r1(w / 2)} ${ry} 0 0 0 ${r1(x + w)} ${r1(y + ry)}`, ' fill="none"')
    }
    case 'circle': return `<circle class="${cls}" cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(Math.min(w, h) / 2)}"/>`
    case 'double-circle':
      return `<circle class="${cls}" cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(Math.min(w, h) / 2)}"/>` +
        `<circle class="${cls}" cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(Math.min(w, h) / 2 - 7)}" fill="none"/>`
    case 'diamond': return a(`M${r1(cx)} ${r1(y)}L${r1(x + w)} ${r1(cy)}L${r1(cx)} ${r1(y + h)}L${r1(x)} ${r1(cy)}Z`)
    case 'hexagon': return a(`M${r1(x + 22)} ${r1(y)}H${r1(x + w - 22)}L${r1(x + w)} ${r1(cy)}L${r1(x + w - 22)} ${r1(y + h)}H${r1(x + 22)}L${r1(x)} ${r1(cy)}Z`)
    case 'lean-r': return a(`M${r1(x + 26)} ${r1(y)}H${r1(x + w)}L${r1(x + w - 26)} ${r1(y + h)}H${r1(x)}Z`)
    case 'lean-l': return a(`M${r1(x)} ${r1(y)}H${r1(x + w - 26)}L${r1(x + w)} ${r1(y + h)}H${r1(x + 26)}Z`)
    case 'trapezoid': return a(`M${r1(x + 30)} ${r1(y)}H${r1(x + w - 30)}L${r1(x + w)} ${r1(y + h)}H${r1(x)}Z`)
    case 'trapezoid-alt': return a(`M${r1(x)} ${r1(y)}H${r1(x + w)}L${r1(x + w - 30)} ${r1(y + h)}H${r1(x + 30)}Z`)
    case 'flag': return a(`M${r1(x + 20)} ${r1(y)}H${r1(x + w)}V${r1(y + h)}H${r1(x + 20)}L${r1(x)} ${r1(cy)}Z`)
    default: return `<rect class="${cls}" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="14"/>`
  }
}

/** One edge's `d`, with rounded elbows and a bridge at every crossing. */
function pathData(verts, hops, P, flip, insetEnd) {
  const pts = verts.map((v) => P.map(v.a, v.c))
  if (insetEnd && pts.length > 1) {
    const [p, q] = [pts[pts.length - 2], pts[pts.length - 1]]
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1
    pts[pts.length - 1] = { x: q.x - ((q.x - p.x) / len) * 4, y: q.y - ((q.y - p.y) / len) * 4 }
  }
  const seg = (i) => Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
  const radius = (i) => Math.min(CORNER, seg(i - 1) / 2, seg(i) / 2)
  const towards = (from, to, dist) => {
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1
    return { x: from.x + ((to.x - from.x) / len) * dist, y: from.y + ((to.y - from.y) / len) * dist }
  }
  let d = ''
  for (let i = 0; i < pts.length - 1; i++) {
    const start = i === 0 ? pts[0] : towards(pts[i], pts[i + 1], radius(i))
    const end = i === pts.length - 2 ? pts[i + 1] : towards(pts[i + 1], pts[i], radius(i + 1))
    if (i === 0) d += `M${r1(start.x)} ${r1(start.y)}`
    for (const at of hops[i] ?? []) {
      const from = P.map(at - HOP, verts[i].c)
      const to = P.map(at + HOP, verts[i].c)
      const forward = Math.hypot(from.x - start.x, from.y - start.y) < Math.hypot(to.x - start.x, to.y - start.y)
      const [enter, leave] = forward ? [from, to] : [to, from]
      d += `L${r1(enter.x)} ${r1(enter.y)}A${HOP} ${HOP} 0 0 ${flip ? 1 : 0} ${r1(leave.x)} ${r1(leave.y)}`
    }
    d += `L${r1(end.x)} ${r1(end.y)}`
    if (i < pts.length - 2) {
      const next = towards(pts[i + 1], pts[i + 2], radius(i + 1))
      d += `Q${r1(pts[i + 1].x)} ${r1(pts[i + 1].y)} ${r1(next.x)} ${r1(next.y)}`
    }
  }
  return d
}

/** The point half way along a polyline, where an edge label goes. */
function midpoint(pts) {
  const lens = []
  let total = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
    lens.push(l)
    total += l
  }
  let want = total / 2
  for (let i = 0; i < lens.length; i++) {
    if (want <= lens[i]) {
      const t = lens[i] ? want / lens[i] : 0
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t }
    }
    want -= lens[i]
  }
  return pts[pts.length - 1]
}

const MARKER_SHAPE = {
  arrow: (a) => `<path class="f${a}" d="M0 0 L10 5 L0 10 z"/>`,
  dot: (a) => `<circle class="f${a}" cx="5" cy="5" r="4"/>`,
  cross: (a) => `<path class="s${a}" d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" fill="none" stroke-width="1.8"/>`,
}
const MARKER_REFX = { arrow: 8, dot: 5.5, cross: 5 }

export function build(model, opts = {}) {
  const { ranks, byId, bands, gaps, laneOf } = layout(model)
  const all = ranks.flat()
  const direction = model.direction
  const vertical = isVertical(direction)

  // Accents carry meaning (SKILL.md §4): a class from the source wins; failing
  // that, where the flow enters is primary and where it stops is a result.
  // Asymmetric on purpose: a return arriving does not stop a node being the
  // entry, but a return leaving does stop it being a terminus — something that
  // loops back has not finished.
  const forward = model.edges.filter((e) => !e.back && !e.self)
  const hasIn = new Set(forward.map((e) => e.to))
  const hasOut = new Set(model.edges.filter((e) => e.from !== e.to).map((e) => e.from))
  for (const n of model.nodes) {
    if (n.accent === null) n.accent = !hasIn.has(n.id) ? 1 : !hasOut.has(n.id) ? 4 : null
  }
  // Where a decision splits, the branch that carries on down the longest
  // remaining path is the main line and keeps a1; the others are what a1 is
  // not — alternates, which is a3. Longest path, not declaration order: the
  // reader's eye follows the spine of the chart, and the colour should agree
  // with it rather than with whichever branch happened to be typed first.
  const reach = new Map(model.nodes.map((n) => [n.id, 0]))
  const outOf = new Map(model.nodes.map((n) => [n.id, []]))
  for (const e of forward) outOf.get(e.from).push(e.to)
  for (const rank of [...ranks].reverse()) {
    for (const n of rank) {
      if (n.dummy) continue
      const kids = outOf.get(n.id)
      reach.set(n.id, kids.length ? Math.max(...kids.map((k) => reach.get(k) + 1)) : 0)
    }
  }
  const spineTaken = new Set()
  for (const e of model.edges) {
    if (e.back || e.self) { e.accent = 2; continue }
    const siblings = forward.filter((o) => o.from === e.from)
    if (siblings.length < 2) { e.accent = 1; continue }
    const best = siblings.reduce((x, y) => (reach.get(y.to) > reach.get(x.to) ? y : x))
    if (e === best && !spineTaken.has(e.from)) { spineTaken.add(e.from); e.accent = 1 } else e.accent = 3
  }

  // Return channels sit outside everything the layout placed, one per edge so
  // two returns never share a line — and on whichever side is nearer to both
  // ends. A return always sent round the right is a line dragged the width of
  // the figure to reach a node on the left, straight across whatever it passes.
  const minC = Math.min(...all.map((n) => n.c - n.cSize / 2))
  const maxC = Math.max(...all.map((n) => n.c + n.cSize / 2))
  const returns = model.edges.filter((e) => e.back || e.self)
  const used = { 1: 0, '-1': 0 }
  for (const e of model.edges) {
    if (!e.back) continue
    const [x, y] = [byId.get(e.from), byId.get(e.to)]
    const leftRun = Math.min(x.c - x.cSize / 2, y.c - y.cSize / 2) - minC
    const rightRun = maxC - Math.max(x.c + x.cSize / 2, y.c + y.cSize / 2)
    e.side = rightRun <= leftRun ? 1 : -1
    const k = used[e.side]++
    e.channel = e.side === 1 ? maxC + BACK_GAP + k * BACK_STEP : minC - BACK_GAP - k * BACK_STEP
  }

  // The gap a return turns in, on either side of a rank band. Outside the first
  // and last band there is no gap, so one is made — and because the canvas is
  // sized from what is actually drawn, making it simply grows the page.
  const L = {
    lane: (ei, g) => bands[g].end + (bands[g + 1].start - bands[g].end) * laneOf(ei, g),
    after: (r) => (r < bands.length - 1 ? bands[r].end + gaps[r] / 2 : bands[r].end + 40),
    before: (r) => (r > 0 ? bands[r].start - gaps[r - 1] / 2 : bands[r].start - 40),
  }

  const routes = model.edges.map((e, i) => route(e, i, byId, L))
  const hops = crossings(routes)

  // The canvas is sized from the geometry, not the other way round: a return
  // channel, a loop above the first rank, a subgraph's title band all push the
  // extent out, and anything positioned past the body box is cropped in silence
  // (SKILL.md §8) inside a figure the guards still call a success.
  const pts = [
    ...all.flatMap((n) => [{ a: n.a0, c: n.c - n.cSize / 2 }, { a: n.a0 + n.aSize, c: n.c + n.cSize / 2 }]),
    ...routes.flat(),
  ]
  for (const g of model.subgraphs) {
    const ms = g.members.map((id) => byId.get(id))
    pts.push(
      { a: Math.min(...ms.map((n) => n.a0)) - GROUP_PAD - (vertical ? GROUP_TITLE_H : 0), c: Math.min(...ms.map((n) => n.c - n.cSize / 2)) - GROUP_PAD - (vertical ? 2 : GROUP_TITLE_H) },
      { a: Math.max(...ms.map((n) => n.a0 + n.aSize)) + GROUP_PAD, c: Math.max(...ms.map((n) => n.c + n.cSize / 2)) + GROUP_PAD },
    )
  }
  const aMin = Math.min(...pts.map((p) => p.a)), aMax = Math.max(...pts.map((p) => p.a))
  const cMin = Math.min(...pts.map((p) => p.c)), cMax = Math.max(...pts.map((p) => p.c))

  const kicker = opts.kicker ?? null
  const title = opts.title ?? model.title ?? null
  const note = opts.note ?? null

  // The header and the footnote are content too, and the canvas has to hold
  // them: a note running off the right edge is cropped just as silently.
  const graphW = (vertical ? cMax - cMin : aMax - aMin)
  const headW = Math.max(
    kicker ? monoWidth(kicker, 14) * 1.05 + 12 : 0,   // 0.04em letter-spacing
    title ? labelWidth(title, 20) + 8 : 0,
  )
  const noteLines = note ? wrapMono(note, Math.max(graphW, headW, 520)) : []
  const noteW = noteLines.length ? Math.max(...noteLines.map((l) => monoWidth(l))) + 8 : 0
  const headH = (kicker ? 26 : 0) + (title ? 32 : 0)
  const padTop = Math.max(60, headH + 46)
  const padBottom = noteLines.length ? 34 + noteLines.length * 19 : 52
  const padA = (vertical ? padTop : PAD_X) - aMin
  const padC = (vertical ? PAD_X : padTop) - cMin
  const P = projector(direction, aMax + aMin, padA, padC)
  const width = Math.round(2 * PAD_X + Math.max(vertical ? cMax - cMin : aMax - aMin, headW, noteW))
  const height = Math.round((vertical ? aMax - aMin : cMax - cMin) + padTop + padBottom)

  /* defs — only the markers this diagram actually spends */
  const markers = new Map()
  for (const e of model.edges) {
    for (const head of [e.end, e.start]) {
      if (head && head !== 'none') markers.set(`${head}${e.accent}`, { head, accent: e.accent })
    }
  }
  const defs = [...markers].map(([id, { head, accent }]) =>
    `<marker id="mk-${id}" viewBox="0 0 10 10" refX="${MARKER_REFX[head]}" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">${MARKER_SHAPE[head](accent)}</marker>`,
  ).join('')

  const out = []
  out.push(`<defs>${defs}</defs>`)

  /* subgraph boundaries, behind everything they hold */
  for (const g of model.subgraphs) {
    const boxes = g.members.map((id) => boxOf(byId.get(id), P, vertical))
    const x = Math.min(...boxes.map((b) => b.x)) - GROUP_PAD
    const y = Math.min(...boxes.map((b) => b.y)) - GROUP_PAD
    const w = Math.max(...boxes.map((b) => b.x + b.w)) + GROUP_PAD - x
    const h = Math.max(...boxes.map((b) => b.y + b.h)) + GROUP_PAD - y
    out.push(
      `<rect class="grouparea" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="18"/>` +
      `<rect class="groupline" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="18"/>` +
      // Above the box, not inside it: the band inside a boundary's top edge is
      // where the edges entering the cluster turn, and a caption sitting in it
      // is a caption with an arrow through it.
      `<text class="glbl" x="${r1(x + 2)}" y="${r1(y - 10)}">${esc(g.title.toUpperCase())}</text>`,
    )
  }

  /* edges, then their labels, so no line is drawn over a chip */
  const labels = []
  model.edges.forEach((e, i) => {
    const cls = ['edge', `s${e.accent}`, e.style === 'dotted' ? 'dotted' : '', e.style === 'thick' ? 'thick' : ''].filter(Boolean).join(' ')
    const mEnd = e.end !== 'none' ? ` marker-end="url(#mk-${e.end}${e.accent})"` : ''
    const mStart = e.start !== 'none' ? ` marker-start="url(#mk-${e.start}${e.accent})"` : ''
    out.push(`<path class="${cls}" d="${pathData(routes[i], hops[i], P, P.flip, e.end !== 'none')}"${mEnd}${mStart}/>`)
    if (!e.label) return
    const at = midpoint(routes[i].map((v) => P.map(v.a, v.c)))
    const w = monoWidth(e.label) + 16
    labels.push(
      `<rect class="chip" x="${r1(at.x - w / 2)}" y="${r1(at.y - LABEL_H / 2)}" width="${r1(w)}" height="${LABEL_H}" rx="5"/>` +
      `<text class="lbl f${e.accent}" x="${r1(at.x)}" y="${r1(at.y + 4.5)}" text-anchor="middle">${esc(e.label)}</text>`,
    )
  })
  out.push(...labels)

  /* nodes */
  for (const n of model.nodes) {
    const box = boxOf(n, P, vertical)
    out.push(shapeMarkup(n, box, n.accent ? `node a${n.accent}` : 'node'))
    const first = box.y + box.h / 2 - ((n.lines.length - 1) * LINE_H) / 2 + 5.2
    for (const [k, line] of n.lines.entries()) {
      out.push(`<text class="nlbl" x="${r1(box.x + box.w / 2)}" y="${r1(first + k * LINE_H)}" text-anchor="middle">${esc(line)}</text>`)
    }
  }

  /* header and footnote */
  const head = []
  if (kicker) head.push(`<text class="kicker" x="${PAD_X}" y="${title ? 40 : 54}">${esc(kicker.toUpperCase())}</text>`)
  if (title) head.push(`<text class="title" x="${PAD_X}" y="${kicker ? 72 : 58}">${esc(title)}</text>`)
  noteLines.forEach((line, k) => {
    const y = height - 26 - (noteLines.length - 1 - k) * 19
    head.push(`<text class="sub" x="${PAD_X}" y="${r1(y)}" opacity="0.75">${esc(line)}</text>`)
  })
  out.splice(1, 0, ...head)   // after <defs>, before the figure

  // Internal consistency, cheap and worth having: the canvas is computed from
  // the geometry, so a box outside it means the two came apart in a refactor —
  // and anything outside the body box is cropped in silence (SKILL.md §8).
  for (const n of model.nodes) {
    const b = boxOf(n, P, vertical)
    if (b.x < -1 || b.y < -1 || b.x + b.w > width + 1 || b.y + b.h > height + 1) {
      throw new MermaidError(
        `Laid "${n.id}" outside the ${width}x${height} canvas (${r1(b.x)},${r1(b.y)} ${r1(b.w)}x${r1(b.h)}).\n` +
          '  It would be cropped in silence, so this is a bug in the layout rather than in the input.',
      )
    }
  }

  return {
    svg: out.join('\n      '),
    width,
    height,
    stats: { nodes: model.nodes.length, edges: model.edges.length, ranks: ranks.length, returns: returns.length, crossings: hops.flat().flat().length },
  }
}

/* ═══ 8. The template contract ════════════════════════════════════════════ */

const FLOW_BEGIN = /<!--\s*FLOW:BEGIN[\s\S]*?-->/
const FLOW_END = /<!--\s*FLOW:END\s*-->/
const BODY_SIZE = /width:\s*\d+px;\s*height:\s*\d+px/
const SVG_OPEN = /<svg\b[^>]*>/

/**
 * Every class the generated markup carries has to be defined by the template.
 *
 * The generator decides shape and position; the template decides colour, and
 * the two only meet through these class names. A rule the template has lost —
 * or a class a change here started emitting — paints unstroked, unfilled or
 * invisible geometry on a page that is otherwise perfect, which is the one
 * defect a screenshot cannot show you. So it is checked, before Chrome, in the
 * same spirit as assertPartClasses in parts.mjs.
 */
function assertGeneratedClasses(template, svg) {
  const css = [...template.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
  const used = new Set()
  for (const [, cls] of svg.matchAll(/class="([^"]*)"/g)) for (const c of cls.split(/\s+/)) if (c) used.add(c)
  const missing = [...used].filter((c) => !new RegExp(`\\.${c}\\b`).test(css)).sort()
  if (!missing.length) return
  throw new MermaidError(
    `The template defines no CSS for ${missing.map((c) => `.${c}`).join(', ')}.\n` +
      '  Generated markup carries no colour of its own, so an undefined class renders as\n' +
      '  invisible or unstroked geometry on an otherwise perfect PNG. Restore the rules in\n' +
      '  templates/flowchart.html, or pass a --template that has them.',
  )
}

/**
 * Drop generated markup into the template shell.
 *
 * Every one of these four edits is checked, because the shell is the only thing
 * standing between this generator and an unthemed page: a template that lost its
 * markers would otherwise produce a file that renders — as the template's own
 * placeholder text, at the template's own size, and exits 0.
 */
export function fillTemplate(template, { svg, width, height }, themeHref) {
  const need = (re, what) => {
    if (!re.test(template)) {
      throw new MermaidError(
        `The flowchart template has no ${what}, so the generated figure cannot be placed in it.\n` +
          '  templates/flowchart.html must keep its FLOW:BEGIN/FLOW:END markers, the\n' +
          '  "width: Npx; height: Mpx" on its <body>, and one <svg> opening tag.',
      )
    }
  }
  assertGeneratedClasses(template, svg)
  need(FLOW_BEGIN, 'FLOW:BEGIN marker')
  need(FLOW_END, 'FLOW:END marker')
  need(BODY_SIZE, '"width: Npx; height: Mpx" on its <body>')
  need(SVG_OPEN, '<svg> tag')

  const begin = template.match(FLOW_BEGIN)
  const endAt = template.search(FLOW_END)
  if (endAt < begin.index) throw new MermaidError('The flowchart template has FLOW:END before FLOW:BEGIN.')

  let out = template.slice(0, begin.index) +
    `<!-- FLOW:BEGIN — generated by scripts/mermaid.mjs; edit freely, or regenerate -->\n      ${svg}\n      ` +
    template.slice(endAt)
  out = out.replace(BODY_SIZE, `width: ${width}px; height: ${height}px`)
  out = out.replace(SVG_OPEN, `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">`)
  if (themeHref) {
    const link = out.match(/<link\b[^>]*\brel=["']?stylesheet[^>]*>/i)
    if (!link) throw new MermaidError('The flowchart template links no stylesheet, so the page would render unthemed.')
    // The template's own THEME note goes with it: it tells you to edit a
    // filename that is no longer there, and a stale instruction in generated
    // output is worse than none.
    const note = out.match(/<!--\s*THEME:[\s\S]*?-->\s*/i)
    if (note) out = out.replace(note[0], '')
    out = out.replace(
      link[0],
      '<!-- THEME: this points back at the theme inside the skill, which is where it lives.\n' +
        `         Moving this file breaks the link — pass --theme <name> to render.mjs and it\n` +
        '         inlines the theme instead, from any directory, in any of the eight. -->\n' +
        `    <link rel="stylesheet" href="${esc(themeHref)}" />`,
    )
  }
  return out
}

/* ═══ 9. CLI ══════════════════════════════════════════════════════════════ */

const USAGE =
  'mermaid.mjs <input.mmd|-> <output.html> [--theme name] [--direction TD|LR] [--title "..."] [--kicker "..."] [--note "..."] [--template file]'

// Importable as a module (the invariant suite does), executable as a command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = parseArgs({ usage: USAGE, bool: [], value: ['theme', 'direction', 'title', 'kicker', 'note', 'template'] })
  const [input, output] = cli.positional
  if (!input || !output) fail('Both a mermaid source (or -) and an output .html are required.', USAGE)
  if (!/\.html?$/i.test(output)) {
    fail(
      `Output must be an .html file, got "${output}".\n` +
        '  This step generates the page; render.mjs turns it into a PNG, JPEG or PDF.',
      USAGE,
    )
  }

  let text
  if (input === '-') {
    text = readFileSync(0, 'utf8')
    if (!text.trim()) fail('Nothing arrived on stdin.', USAGE)
  } else {
    const abs = resolve(input)
    if (!existsSync(abs)) fail(`Input not found: ${abs}\n  (resolved against cwd ${process.cwd()})`)
    text = readFileSync(abs, 'utf8')
  }

  if (!looksLikeMermaid(text)) {
    fail(
      'This does not look like a mermaid flowchart: no "flowchart"/"graph" header was found.\n' +
        '  Mermaid flowcharts open with a header naming the direction, e.g.\n' +
        '      flowchart TD\n' +
        `        A[Start] --> B{Choice}\n` +
        '  Other mermaid diagram kinds (sequence, class, state, gantt, ER, pie) are not\n' +
        '  implemented — templates/sequence.html draws sequence diagrams by hand.',
    )
  }

  const themeName = cli.opt('theme') ?? 'ember'
  try { resolveTheme(themeName) } catch (err) { fail(err.message, USAGE) }
  const dirOverride = cli.opt('direction')?.toUpperCase()
  if (dirOverride && !DIRECTIONS.includes(dirOverride)) {
    fail(`--direction must be one of: ${DIRECTIONS.join(', ')} — got "${cli.opt('direction')}".`, USAGE)
  }
  const templateFile = cli.opt('template') ? resolve(cli.opt('template')) : join(TEMPLATES_DIR, 'flowchart.html')
  if (!existsSync(templateFile)) fail(`Template not found: ${templateFile}`)

  try {
    const model = parseMermaid(text)
    if (dirOverride) model.direction = dirOverride
    const built = build(model, { title: cli.opt('title'), kicker: cli.opt('kicker'), note: cli.opt('note') })

    // A relative href, so the generated page resolves its theme from wherever it
    // was written — the skill is installed centrally and the figure is not.
    const outAbs = resolve(output)
    const href = relative(dirname(outAbs), join(THEMES_DIR, `${themeName}.css`)).split(/[\\/]/).join('/')
    writeFileSync(outAbs, fillTemplate(readFileSync(templateFile, 'utf8'), built, href))

    const s = built.stats
    console.log(
      `wrote ${output} (${built.width}x${built.height}, ${s.nodes} nodes, ${s.edges} edges, ` +
        `${s.ranks} ranks${s.returns ? `, ${s.returns} return${s.returns > 1 ? 's' : ''}` : ''}` +
        `${s.crossings ? `, ${s.crossings} bridged crossing${s.crossings > 1 ? 's' : ''}` : ''}, ${model.direction}, theme ${themeName})`,
    )
    for (const c of model.classes) console.log(`class ${c.name} -> accent ${c.accent} (--a${c.accent})`)
    for (const n of model.notes) console.log(`note: ${n}`)
    console.log(`next: node "${join(SKILL_ROOT, 'scripts', 'render.mjs')}" ${output} ${output.replace(/\.html?$/i, '.png')} --theme ${themeName}`)
  } catch (err) {
    if (!(err instanceof MermaidError)) throw err
    fail(err.message)
  }
}
