---
name: rendercraft
description: "**DELIVERY SKILL** — Produce polished diagrams, presentation slides, and social cards as crisp PNGs by authoring HTML/SVG and rendering it with the headless Chromium already on the machine. Four built-in themes (warm dark, cool dark, light editorial, terminal), swappable with a flag. USE FOR: architecture and flow diagrams, slide decks, talk slides, og/social cards, blog and README figures, banners, any designed image a document needs. DO NOT USE FOR: data charts from datasets (use a plotting library), screenshots of real UIs, or photo editing. TRIGGERS: diagram, flow chart, architecture visual, slide, slide deck, presentation, og card, social card, banner, cover image, blog figure, render a png, make an image, visual."
argument-hint: "What to make, e.g. 'a diagram of our auth flow', 'a 6-slide deck from these notes', 'an og card for the repo'"
---

# rendercraft — designed PNGs from HTML, no design tool

Every image this skill produces is a small HTML/SVG page screenshotted by headless Chrome:
fully versioned, diffable, regenerable in seconds when the copy changes, and styled by a theme
file instead of hand-picked colors.

| Template | Canvas | For |
|---|---|---|
| `templates/diagram.html` | 1360×740 | Architecture and flow figures: nodes, labeled arrows, a return path, a line-crossing bridge |
| `templates/slide.html` | 1920×1080 | Presentation slides: kicker, headline with a gradient phrase, up to three points, footer |
| `templates/card.html` | 1200×630 | Social/og cards: mark, headline, one-paragraph pitch, chips, bottom rule |
| `templates/sequence.html` | 1360×740 | Sequence diagrams: lifelines, calls and returns, activations — static, or animated step by step |
| `templates/code.html` | 1360×740 | Code snippets in a themed window (Carbon-style): hand-highlighted tokens, line numbers, a highlight line, diff rows — see §6 |
| `templates/elements.html` | parts sheet | Copy-paste elements: app/browser/terminal/phone frames, database, server, queue, cloud, router, actor, shield, and a 22-glyph icon set. Never a deliverable — see §5 |

| Theme | Mood | Fonts |
|---|---|---|
| `ember` | Warm dark — amber-hued neutrals, cyan/ember/magenta accents | Inter Tight + JetBrains Mono |
| `slate` | Cool dark — violet-leaning neutrals, jewel accents | Space Grotesk + IBM Plex Mono |
| `paper` | Light editorial — warm paper, serif display, print restraint | Fraunces + IBM Plex Mono |
| `terminal` | Near-black phosphor — mono everything, green/amber | JetBrains Mono |

## 1. Workflow

1. **Copy the nearest template** into the working directory (never edit the templates in
   place — they are the exemplars). Copy the chosen theme file beside it and point the
   `<link rel="stylesheet">` at `./<theme>.css`, or leave the link alone and pass `--theme`
   to the renderer.
2. **Replace the placeholder content.** Structure before prose: nodes and arrows for a
   diagram, one claim per slide, one key fact per chip.
3. **Render:**

   ```bash
   node scripts/render.mjs my-figure.html my-figure.png --theme slate
   ```

4. **Look at the PNG.** Read it back and inspect it before calling it done — every first
   render has a defect a human spots instantly: a label overlapping a node, a line bisecting
   text, a heading a word too long for its box. Fix and re-render; iteration is cheap.

## 2. The renderer

`scripts/render.mjs` — plain Node, zero dependencies.

```
node scripts/render.mjs <input.html> <output.png> [--size WxH] [--scale N] [--theme name]
```

- **Size** is read from the `width: Npx; height: Mpx` on the input's `<body>` — keep that
  declaration intact. `--size` overrides.
- **Scale** defaults to 2: a 1360×740 canvas becomes a 2720×1480 PNG, right for retina,
  Medium, and READMEs.
- **`--theme`** rewrites the stylesheet link to `themes/<name>.css` in a temp copy, so one
  source file renders in any theme.
- **`--transparent`** renders with a real alpha channel: the body's ground is unpainted and
  the glow/dots furniture is stripped, so the figure drops onto any surface — docs and
  slides with their own backgrounds, web pages, video overlays. Composes with `--theme`
  (pick `paper` over light surroundings, a dark theme over dark). Note `--surface` keeps its
  8% translucency, so a busy backdrop shows through faintly — a frosted-glass look; if that
  fights the content, place the PNG on a calmer area.
- **A missing local stylesheet is fatal, and checked before Chrome launches.** Every color
  is a theme token, so a broken `<link>` does not degrade the render — it empties it, into a
  blank white page that screenshots as a perfect success. If you copy a template out of the
  skill, copy the theme file beside it and link it directly (`href="./slate.css"`); `--theme`
  only swaps the name inside a `themes/…` path, it cannot repair one.
- **A blank render is fatal too.** After the screenshot, the PNG is decoded and rejected
  if the whole canvas is one flat color — the failure mode a resolved-but-empty stylesheet
  or content positioned outside the body box produces, which Chrome otherwise reports as a
  perfect success. The file is left in place so you can look at it.
- **Chrome discovery**: standard install paths on macOS, Linux, and Windows are probed;
  `CHROME_PATH` overrides. Any Chromium works (Chrome, Chromium, Brave, Edge).
- **Chrome often hangs after writing the screenshot.** The renderer waits on the output
  *file*, not the process, then kills it — with `SIGKILL`, not `SIGTERM`: headless Chrome
  swallows `SIGTERM` during startup and lives on holding its profile. Do the same in any
  custom pipeline.
- Profiles are reused at the OS temp dir (`rendercraft-profile`, `-1`, `-2`, …), claimed
  per process via pid lockfiles — concurrent renders never share one (Chrome would refuse)
  and each slot stays warm; a cold profile costs first-launch setup. Every run reaps
  Chromes left on an unclaimed slot before it starts, and a render that still hits a bad
  slot retries on another, so an interrupted run cannot wedge the next one.
- **`--theme` and `--transparent` write a hidden `.render-<pid>.html` beside the input**
  (the stylesheet link is relative, so the copy has to be a sibling). It is removed on
  every exit path except `SIGKILL`, and the next run in that directory sweeps what a
  `SIGKILL` left. If you render inside a user's repo, add `.render-*.html` to its
  `.gitignore` — `git add -A` would otherwise commit one.
- Google Fonts load fine headlessly; keep the theme files' `@import` lines.

### The harness

Two scripts back the guarantees above. Neither is needed for a normal render.

```bash
node scripts/doctor.mjs            # preflight: reap orphans, clear stale locks, report
node scripts/doctor.mjs --prune    # also delete idle warm profiles to reclaim disk
node scripts/selftest.mjs          # ~60s: assert every concurrency and cleanup invariant
node scripts/selftest.mjs --quick  # ~45s: same, minus the animation test
```

Reach for `doctor.mjs` when renders fail with *"is another instance using profile"* — that
is an orphaned Chrome holding a slot, and `--prune` also answers "why is my temp dir
hundreds of MB". Run `selftest.mjs` after changing anything in `scripts/`: it renders into
a throwaway `TMPDIR`, so it never touches the machine's warm profiles and can assert that
it left nothing behind. It covers concurrent renders agreeing byte for byte, overlapping
`--theme` runs not contaminating each other, interrupted runs leaving no orphan, and both
blank-render guards.

## 3. Animated sequence diagrams — no ffmpeg required

`templates/sequence.html` marks every message with `data-step="N"`. Opened plain it renders
the complete diagram (a static figure). Opened with `?step=N` it shows steps below N dimmed,
step N highlighted, and the rest hidden. `?f=0..1` is the tween fraction within that step's
reveal, and `?fx=` picks the reveal preset — so every frame of a smooth animation is still
just a URL.

`scripts/animate.mjs` renders each step as a short tween (several frames at `--fps`, in
parallel Chrome instances) plus a dwell frame, and assembles a looping GIF **in pure Node**:
Chrome's PNG frames are decoded with the built-in `zlib`, median-cut quantized to a shared
palette with ordered dithering, and LZW-encoded by hand. Frames after the first store only
the changed region (transparent-pixel deltas), so tween frames cost little. GIF is a 1989
format; it does not need ffmpeg.

```bash
node scripts/animate.mjs my-sequence.html my-sequence.gif --theme ember --fx pop
```

| Flag | Default | |
|---|---|---|
| `--fx` | slide | reveal preset: `slide` (fade + drop-in), `fade`, `pop` (scale overshoot); `data-fx="name"` on any element overrides per element |
| `--fps` | 25 | tween frame rate; 20/25/50 play back exactly (GIF timing is 10ms units, 50fps is the format's ceiling) |
| `--transition` | 450 | ms of tween per step reveal; `0` = the old one-frame-per-step look |
| `--delay` | 900 | ms of dwell on each completed step |
| `--hold` | 2600 | ms on the final, complete frame before the loop restarts |
| `--jobs` | 4 | parallel Chrome instances (each keeps its own warm profile) |
| `--scale` | 1 | GIFs get heavy fast — stay at 1x unless the canvas is small |
| `--theme` / `--size` | — | as in render.mjs |
| `--keep-frames` | off | keep the per-frame PNGs for inspection |

Rules of thumb: steps are numbered 1..N with no gaps; give activations the step of the call
that starts them; a GIF that tells the story in under ~8 steps is one people actually watch.
GitHub READMEs autoplay GIFs; Medium accepts them as uploads.

## 4. The aesthetic rules

Themes define tokens; templates consume only tokens. Never hard-code a color in a template.

**Accent semantics** — one accent per meaning, never decoration:

| Token | Meaning |
|---|---|
| `--a1` | The primary thing, forward paths |
| `--a2` | Actions, returns, what flows back |
| `--a3` | External parties, alternates, alerts |
| `--a4` | Success, confirmation |

**Gradient text** (`--grad`) is for one phrase per image, on the headline. The ramp is
tuned per theme; do not compose your own across near-complementary hues — the midpoint
greys out.

**Furniture** stack, bottom to top: ground → blurred glow circles (`--glow1`/`--glow2` at
`--glow-opacity`; the light theme sets it to 0) → the dot lattice (masked radially so it
fades at the edges) → content. Do not add new furniture kinds; restraint is the style.

**Diagrams**: nodes are rounded rects (`rx=14`) in `--surface` with a `--line` border, a
small stroke glyph in the node's accent, a display-font title, and a mono subtitle. Arrows
are 1.8px with 7px triangle markers **in the line's own color**; labels sit above the line
in the same color. In SVG, set colors via CSS classes (`.s1`/`.f1` etc.) — `var()` does not
resolve in presentation attributes.

**Type**: display font for titles only; mono for labels, chips, kickers, footers, and
anything technical. Kickers are small mono, letter-spaced, uppercase, `--ink-faint`.

## 5. The element library

`templates/elements.html` is a parts sheet, not a canvas: render it only to browse what
exists. Every part is a self-contained `<g id="el-…">` (shapes and frames) or
`<g id="g-…">` (28×28 glyphs), anchored at its own top-left, built purely from theme
tokens — so it matches whatever theme the page links, like everything else here.

To use a part:

1. Copy the group into your figure's `<svg>` and place it with `transform="translate(x,y)"`.
2. Make sure the page's `<style>` has the `/* element utilities */` block
   (`.sline .fline .sfaint .ffaint .fground .glyph` plus `s4`/`f4`) — `diagram.html` and
   `sequence.html` already carry it; copy it from `elements.html` into anything older.
3. Recolor by swapping the accent class on the part's accent pieces (`s1` → `s2`/`s3`/`s4`).
   The neutral frame never changes — accents stay semantic (§4).

Frames (`el-window`, `el-browser`, `el-terminal`, `el-phone`) are nodes in their own right:
caption them with a `.title`/`.sub` pair beneath, or replace the faint skeleton bars with
real mono `<text>` when the content matters. The comment above each part records its
footprint and which coordinates move together when you stretch it.

Glyphs drop into a standard node card at `transform="translate(20,30)"`, replacing the
stock circle glyph; they inherit stroke 1.6 and round caps from `.glyph`.

## 6. Code snippets

`templates/code.html` is a Carbon-style code window — surface, traffic dots, filename, a
language chip — floating on the themed ground with a `--shadow` (a token, like every other
color). The window's width is the one layout knob; height follows the lines.

**You are the highlighter.** There is no highlighting library; wrap tokens by hand in
exactly these six classes, and no others:

| Class | Token kind | Color |
|---|---|---|
| `.kw` | keywords, control flow | `--a3` |
| `.fn` | functions and methods | `--a1` |
| `.ty` | types, classes | `--a1`, weight 500 |
| `.str` | strings | `--a2` |
| `.num` | numbers, booleans, constants | `--a4` |
| `.com` | comments | `--ink-faint`, italic |

Everything else (variables, properties, punctuation) stays `--ink`. The mapping is fixed
across themes — don't invent per-language variations.

**Line rows**: one `<div class="line">` per line (empty divs render as blank lines; numbers
come from a CSS counter). `.hl` marks *the* line the figure is about — one per figure, like
the gradient phrase. `.add`/`.del` rows make a diff; their gutter sign replaces the line
number. Escape `&`, `<`, `>` in the code text.

**Discipline**: ~18 lines is the ceiling — a snippet that needs more is two figures. Keep
2-space indents so long lines survive. Real code beats lorem: verify the snippet compiles
in your head before shipping it. Rendered with `--transparent`, the window becomes a
shadowed sticker for embedding anywhere.

## 7. Layout discipline

Check these before rendering, not after:

- **Measure labels against gaps.** Mono runs ≈ 0.6 em per character; a 12.5px label needs
  ~7.5px per character, and centred between two nodes it must clear both edges.
- **Crossings get a bridge.** Where a vertical line must cross a horizontal one, hop it
  with a small half-circle: `V y+9  A 9 9 0 0 0 x y-9  V …` — never just draw through.
- **The body is the canvas.** Its CSS width/height must equal the render size exactly,
  with `overflow: hidden`. Anything positioned outside is silently cropped.
- Three points per slide is the ceiling. A diagram that needs more than ~7 nodes is two
  diagrams.

## 8. Presentations

A deck is one HTML file per slide, numbered so order is explicit:

```
deck/
├── 01-title.html      (copy of slide.html, headline only, points removed)
├── 02-problem.html
├── 03-how.html        (a diagram canvas resized to 1920×1080 works as a full-bleed slide)
└── ...
```

Render the deck:

```bash
mkdir -p out
for s in deck/*.html; do
  node scripts/render.mjs "$s" "out/$(basename "${s%.html}").png" --theme ember
done
```

Keep one theme per deck. The footer's `NN / NN` is manual — update it per slide. To ship a
single file, combine the PNGs into a PDF with whatever the machine has
(`magick out/*.png deck.pdf`, or print the folder from any viewer).

## 9. QA checklist

Before delivering any image:

- [ ] Rendered and **viewed** — not assumed
- [ ] Code figures: highlighting spot-checked token by token; at most one `.hl` line
- [ ] Transparent renders: viewed composited over a sample background, not just alone
- [ ] No text touches a node edge, a line, or the canvas edge
- [ ] Every line crossing is bridged
- [ ] One gradient phrase at most; accents used by meaning, not variety
- [ ] Facts in the copy verified against the project (counts, versions, names)
- [ ] Output at 2x unless the destination demands otherwise (GIFs: 1x)
- [ ] Animations: every step present in order, and the final frame holds long enough to read
- [ ] Batch or deck renders: no `.render-*.html` left in the working directory afterwards
