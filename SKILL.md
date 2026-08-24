---
name: render-visual
description: "**DELIVERY SKILL** — Produce polished diagrams, presentation slides, and social cards as crisp PNGs by authoring HTML/SVG and rendering it with a local headless Chromium. Eight built-in themes (ember, slate, paper, terminal, blueprint, frost, neon, sepia), swappable with a flag. Also frames your own screenshots and photos — in a browser, phone or terminal frame, or cropped to a shape. USE FOR: architecture and flow diagrams, slide decks, og/social cards, blog and README figures, banners, device mockups, any designed image a document needs. DO NOT USE FOR: data charts from datasets (use a plotting library), capturing a live UI, photo retouching, or any surface where you cannot run shell commands — write inline SVG instead. TRIGGERS: diagram, flow chart, architecture visual, swimlane, tree view, cluster, deployment, mind map, slide, slide deck, presentation, og card, social card, banner, cover image, blog figure, screenshot in a browser frame, device mockup, render a png, make an image, visual."
license: MIT
compatibility: "Requires shell command execution, Node 18+, and a local Chromium-based browser (Chrome, Chromium, Brave, or Edge); set CHROME_PATH if it is installed somewhere unusual. Theme fonts load from fonts.googleapis.com, so renders without network access fall back to system fonts. Cannot run where there is no shell or no browser: claude.ai chat, the Skills API, Cowork and cloud sessions, and most CI images."
metadata:
  version: "1.0.1"
---

# render-visual — designed PNGs from HTML, no design tool

Every image this skill produces is a small HTML/SVG page screenshotted by headless Chrome:
fully versioned, diffable, regenerable in seconds when the copy changes, and styled by a theme
file instead of hand-picked colors.

| Template | Canvas | For |
|---|---|---|
| `$SKILL/templates/diagram.html` | 1360×740 | Architecture and flow figures: nodes, labeled arrows, a return path, a line-crossing bridge |
| `$SKILL/templates/slide.html` | 1920×1080 | Presentation slides: kicker, headline with a gradient phrase, up to three points, footer |
| `$SKILL/templates/card.html` | 1200×630 | Social/og cards: mark, headline, one-paragraph pitch, chips, bottom rule |
| `$SKILL/templates/sequence.html` | 1360×740 | Sequence diagrams: lifelines, calls and returns, activations — static, or animated step by step |
| `$SKILL/templates/swimlane.html` | 1360×740 | Cross-functional flows: lanes that own the steps, labelled handoffs, an exception path that never leaves its lane |
| `$SKILL/templates/tree.html` | 1360×740 | Hierarchies, both idioms: an indented tree view (files, nav, an outline) beside the same tree drawn node-link |
| `$SKILL/templates/cluster.html` | 1360×740 | What runs inside a boundary: control plane, worker nodes, pods, and the state that outlives a rebuild |
| `$SKILL/templates/deployment.html` | 1360×740 | Which artifact lands on which machine, over which protocol: `el-cube` nodes, «stereotypes», artifact chips — see §5 |
| `$SKILL/templates/mindmap.html` | 1360×740 | A question in the middle and the answers around it: six branches, two leaves each, one branch emphasised |
| `$SKILL/templates/code.html` | 1360×740 | Code snippets in a themed window (Carbon-style): hand-highlighted tokens, line numbers, a highlight line, diff rows — see §7 |
| `$SKILL/templates/charts.html` | parts sheet | Browsable catalogue of the chart and BI parts — pie, donut, bar, line, area, stacked, scatter, funnel, gauge, heatmap, sparkline, KPI tile, table, dashboard. Schematic figures, not plotted data — see §5 |
| `$SKILL/templates/palette.html` | 1360×980 | Theme specimen: the tokens, both fonts, the gradient, the alpha ladders, the parts dressed by that theme. A catalogue, never a deliverable — see §4 |
| `$SKILL/templates/elements.html` | parts sheet | Browsable catalogue of the frames, infrastructure shapes, deployment node and icon glyphs in `$SKILL/parts/`. Reference them, don't copy them. Never a deliverable — see §5 |

| Theme | Mood | Fonts |
|---|---|---|
| `ember` | Warm dark — amber-hued neutrals, cyan/ember/magenta accents | Inter Tight + JetBrains Mono |
| `slate` | Cool dark — violet-leaning neutrals, jewel accents | Space Grotesk + IBM Plex Mono |
| `paper` | Light editorial — warm paper, serif display, print restraint | Fraunces + IBM Plex Mono |
| `terminal` | Near-black phosphor — mono everything, green/amber | JetBrains Mono |
| `blueprint` | Drafting board — cyanotype navy, chalk lines, a grid that reads | Archivo + Roboto Mono |
| `frost` | Light UI — cool white, glass surfaces, indigo/teal | Manrope + JetBrains Mono |
| `neon` | After hours — indigo dark, high-chroma magenta and cyan | Chakra Petch + Fira Code |
| `sepia` | Aged press — cream stock, brown ink, typewriter mono | Newsreader + Courier Prime |

To see one whole, render the specimen sheet in it:

```bash
node "$SKILL/scripts/render.mjs" "$SKILL/templates/palette.html" palette.png --theme blueprint
```

## 0. Find the skill first

**Every path in this file is relative to the directory holding this `SKILL.md`, not to the
working directory.** You are almost never invoked from inside the skill — it is installed
somewhere central and you are working in someone's project — so resolve that directory once
and prefix every command below with it. `$SKILL` is written for it throughout.

```bash
SKILL=/absolute/path/to/the/directory/containing/this/SKILL.md
```

If you have lost that path, find it — the layout is always `<skill>/scripts/render.mjs`:

```bash
ls -d ~/.claude/skills/render-visual ~/.agents/skills/render-visual \
      ./.claude/skills/render-visual ./.agents/skills/render-visual 2>/dev/null
```

Nothing here needs the working directory to be the skill. Outputs go wherever you say.

## 1. Workflow

0. **Settle theme and template before touching a file.** Two choices shape everything
   after, and neither is yours to default silently:

   - **Theme.** A theme named in the request wins. Otherwise use the one recorded in
     `.render-visual.json` (below). Failing both, ask — offer the theme table above by
     mood and let the user pick. Never choose silently: the wrong palette is a re-render
     at best and an off-brand deliverable at worst.
   - **Template.** Read the task against the template table's "For" column and shortlist
     what fits. A request that names one — "a swimlane", "an og card" — is the answer.
     One clear match: take it and say which in the handoff. Several plausible: ask,
     naming the shortlist and what each would emphasise.

   Where nobody can answer — CI, a scripted run — fall back in the same order: the file,
   then the closest match, stated plainly in the output.

   **Remember the answers.** A project that has decided once should not be asked twice.
   Standing choices live in `.render-visual.json` at the project root — theme, where
   finished images land, scale, anything settled that would otherwise be re-asked:

   ```json
   { "theme": "slate", "output": "docs/figures/", "scale": 2 }
   ```

   Read it before asking anything; after a first round of answers, offer to write it —
   ask before creating it, it lives in the user's project. The prompt always beats the
   file. The renderer itself never reads it: pass `--theme` explicitly on every command,
   so a typo still fails loud instead of falling back to a wrong palette.

1. **Copy the nearest template** into the working directory (never edit the templates in
   place — they are the exemplars):

   ```bash
   cp "$SKILL/templates/diagram.html" my-figure.html
   ```

   Nothing else needs copying. `--theme` inlines the theme's CSS at render time, so no
   `themes/` directory has to sit beside your figure.
2. **Replace the placeholder content.** Structure before prose: nodes and arrows for a
   diagram, one claim per slide, one key fact per chip.
3. **Render:**

   ```bash
   node "$SKILL/scripts/render.mjs" my-figure.html my-figure.png --theme slate
   ```

4. **Look at the PNG.** Read it back and inspect it before calling it done — every first
   render has a defect a human spots instantly: a label overlapping a node, a line bisecting
   text, a heading a word too long for its box. Fix and re-render; iteration is cheap.

## 2. The renderer

`$SKILL/scripts/render.mjs` — plain Node, zero dependencies.

```
node "$SKILL/scripts/render.mjs" <input.html> <output.png> [--size WxH] [--scale N] [--theme name]
```

- **Size** is read from the `width: Npx; height: Mpx` on the input's `<body>` — keep that
  declaration intact. `--size` overrides.
- **Scale** defaults to 2: a 1360×740 canvas becomes a 2720×1480 PNG, right for retina,
  Medium, and READMEs.
- **`--theme`** inlines one of the skill's own themes into a temp copy of the page, so one
  source file renders in any theme and the figure needs no `themes/` directory beside it.
  An unknown name is fatal and lists what exists; a page with no theme stylesheet to
  replace is fatal too, because rendering it unthemed would quietly give you the wrong
  colours.
- **`--transparent`** renders with a real alpha channel: the body's ground is unpainted and
  the glow/dots furniture is stripped, so the figure drops onto any surface — docs and
  slides with their own backgrounds, web pages, video overlays. Composes with `--theme`
  (pick `paper` over light surroundings, a dark theme over dark). Note `--surface` keeps its
  8% translucency, so a busy backdrop shows through faintly — a frosted-glass look; if that
  fights the content, place the PNG on a calmer area.
- **`<g data-part="...">` is replaced with that part's markup** from `$SKILL/parts/` before
  the render, so a figure references shapes instead of carrying copies of them. See §5.
- **`data-image="./shot.png"` puts an image on the page** — inside a device frame, cropped to
  a shape, or as a background. Local files only; they are read and inlined before the render,
  and anything unreadable is fatal rather than an invisible hole. See §6.
- **A missing local stylesheet is fatal, and checked before Chrome launches.** Every color
  is a theme token, so a broken `<link>` does not degrade the render — it empties it, into a
  blank white page that screenshots as a perfect success. Passing `--theme` sidesteps this
  entirely; without it, keep the page's own stylesheet resolvable.
- **A contentless render is fatal too.** After the screenshot the PNG is decoded and
  rejected if its luminance spread says nothing but background and furniture got painted —
  the failure a resolved-but-empty stylesheet or content positioned outside the body box
  produces, which Chrome otherwise reports as a perfect success. A truncated PNG and one
  that came out the wrong size are rejected in the same pass. The file is left in place so
  you can look at it.
- **Chrome discovery**: standard install paths on macOS, Linux, and Windows are probed,
  then `PATH`; `CHROME_PATH` overrides and is fatal if it does not resolve. Any Chromium
  works (Chrome, Chromium, Brave, Edge). On Ubuntu the snap-packaged Chromium gets a
  private `/tmp` and cannot see the paths written for it — prefer a deb Chrome or Brave
  there, or set `CHROME_PATH`.
- **Chrome often hangs after writing the screenshot.** The renderer waits on the output
  *file*, not the process, then kills it — with `SIGKILL`, not `SIGTERM`: headless Chrome
  swallows `SIGTERM` during startup and lives on holding its profile. Do the same in any
  custom pipeline.
- **Everything temporary lives in one place**, `$TMPDIR/render-visual/`: warm Chrome
  profiles (`profile`, `profile-1`, …) claimed per process via pid lockfiles, the prepared
  page copies, and animation frames. Concurrent renders never share a profile (Chrome would
  refuse) and each stays warm; a cold one costs first-launch setup. Every run reaps Chromes
  left on an unclaimed slot before it starts, and a render that still hits a bad slot
  retries on another, so an interrupted run cannot wedge the next one. **Nothing is written
  into the directory you are rendering from** — a read-only input directory works fine.
- **Theme fonts come from `fonts.googleapis.com`.** With no network the render still
  succeeds, but falls back to system fonts and will not match the previews. If that matters,
  render on a connected machine or accept the substitution — the layout is unaffected.

### The harness

Two scripts back the guarantees above. Neither is needed for a normal render.

```bash
node "$SKILL/scripts/doctor.mjs"            # preflight: reap orphans, clear stale locks, report
node "$SKILL/scripts/doctor.mjs" --prune    # also delete idle warm profiles to reclaim disk
node "$SKILL/scripts/selftest.mjs"          # ~2m: assert every concurrency and cleanup invariant
node "$SKILL/scripts/selftest.mjs" --quick  # ~90s: same, minus the animation test
```

Reach for `doctor.mjs` when renders fail with *"is another instance using profile"* — that
is an orphaned Chrome holding a slot, and `--prune` also answers "why is my temp dir
hundreds of MB". Run `selftest.mjs` after changing anything in `scripts/`: it renders into
a throwaway `TMPDIR`, so it never touches the machine's warm profiles and can assert that
it left nothing behind. It covers concurrent renders agreeing byte for byte, overlapping
`--theme` runs not contaminating each other, interrupted runs leaving no orphan, and both
blank-render guards.

## 3. Animated sequence diagrams — no ffmpeg required

`$SKILL/templates/sequence.html` marks every message with `data-step="N"`. Opened plain it renders
the complete diagram (a static figure). Opened with `?step=N` it shows steps below N dimmed,
step N highlighted, and the rest hidden. `?f=0..1` is the tween fraction within that step's
reveal, and `?fx=` picks the reveal preset — so every frame of a smooth animation is still
just a URL.

`$SKILL/scripts/animate.mjs` renders each step as a short tween (several frames at `--fps`, in
parallel Chrome instances) plus a dwell frame, and assembles a looping GIF **in pure Node**:
Chrome's PNG frames are decoded with the built-in `zlib`, median-cut quantized to a shared
palette with ordered dithering, and LZW-encoded by hand. Frames after the first store only
the changed region (transparent-pixel deltas), so tween frames cost little. GIF is a 1989
format; it does not need ffmpeg.

```bash
node "$SKILL/scripts/animate.mjs" my-sequence.html my-sequence.gif --theme ember --fx pop
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

Images (§6) work here too and are read once for the whole run, not once per frame — but
every frame still carries them, so keep a source that appears in a GIF small.

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

**Alpha grades** — every colour token has a component twin: `--a1-raw`…`--a4-raw`,
`--ink-raw`, `--ground-raw`, `--surface-raw`, each three bare OKLCH numbers. Ask them for any
transparency you need:

```css
.badge { background: oklch(var(--a1-raw) / 12%); border: 1px solid oklch(var(--a1-raw) / 45%); color: var(--a1); }
.scrim { background: oklch(var(--ground-raw) / 72%); }   /* a caption band over a photo */
```

The solid token is built from the same components (`--a1: oklch(var(--a1-raw))`), so a wash
can never drift from the colour it is a wash of. Grades that read: **6–12%** a wash to sit
text on, **20–35%** a fill meant to be seen, **45%** an edge, **70%+** a scrim over an image.
A grade is still the accent — the semantics above hold, so a 12% `--a3` wash means *external*,
not *a nice pink*. In SVG this needs a CSS class like every other `var()`; a presentation
attribute will not resolve it. `templates/palette.html` renders the whole ladder for whichever
theme you hand it, which is the fastest way to pick a grade.

**Gradient text** (`--grad`) is for one phrase per image, on the headline. The ramp is
tuned per theme; do not compose your own across near-complementary hues — the midpoint
greys out.

**Furniture** stack, bottom to top: ground → blurred glow circles (`--glow1`/`--glow2` at
`--glow-opacity`; `paper` and `sepia` set it to 0, `frost` keeps a pale one) → the dot lattice (masked radially so it
fades at the edges) → content. Do not add new furniture kinds; restraint is the style.

**Diagrams**: nodes are rounded rects (`rx=14`) in `--surface` with a `--line` border, a
small stroke glyph in the node's accent, a display-font title, and a mono subtitle. Arrows
are 1.8px with 7px triangle markers **in the line's own color**; labels sit above the line
in the same color. In SVG, set colors via CSS classes (`.s1`/`.f1` etc.) — `var()` does not
resolve in presentation attributes.

**Type**: display font for titles only; mono for labels, chips, kickers, footers, and
anything technical. Kickers are small mono, letter-spaced, uppercase, `--ink-faint`.

## 5. The element library

`$SKILL/parts/` holds 57 ready-made pieces, one `.svg` per part, each a single `<g>` anchored
at its own top-left and built purely from theme tokens. **Reference one instead of copying
it** — a `data-part` attribute is replaced with the part's markup at render time:

```html
<g data-part="el-database" transform="translate(70,452)"/>
<g data-part="g-key" data-accent="3" transform="translate(20,30)"/>
```

| | |
|---|---|
| Frames | `el-window` `el-browser` `el-terminal` `el-phone` |
| Nodes | `el-cube` — the 3-D deployment box; front face 240×150 at (+0,+20) |
| Shapes | `el-database` `el-server` `el-queue` `el-cloud` `el-router` `el-actor` `el-shield` |
| Charts | `el-chart-pie` `el-chart-donut` `el-chart-bar` `el-chart-hbar` `el-chart-line` `el-chart-area` `el-chart-stacked` `el-chart-scatter` `el-chart-funnel` `el-chart-gauge` `el-chart-heatmap` `el-sparkline` |
| BI | `el-dashboard` `el-stat-tile` `el-table` |
| Glyphs (28×28) | `g-user` `g-users` `g-db` `g-cloud` `g-gear` `g-lock` `g-key` `g-globe` `g-bolt` `g-mail` `g-clock` `g-folder` `g-term` `g-file` `g-mobile` `g-screen` `g-api` `g-chip` `g-layers` `g-net` `g-search` `g-check` `g-warn` `g-chart-pie` `g-chart-bar` `g-chart-line` `g-gauge` `g-dashboard` `g-filter` `g-table` |

`cat "$SKILL/parts/el-server.svg"` shows one part's footprint and which coordinates move
together when you stretch it. To see them drawn, render `templates/elements.html` (frames,
shapes, the deployment cube, glyphs) or `templates/charts.html` (charts and BI) — catalogues, never deliverables,
and both built from the same includes.

- **`data-accent="1..4"`** recolors the part's accent pieces to `--a1`…`--a4` (§4). Anything
  the part colors deliberately — `el-server`'s health LEDs are `f4` — is left alone, as is
  the neutral frame. Putting an accent class in `class=` instead is fatal: which one won
  would be CSS source order rather than intent.
- **An accent the part already uses is fatal.** `data-accent="4"` on `el-server` would paint
  the rack the same colour as its health LEDs, and on `el-stat-tile` the same colour as its
  delta chip. Every other part spends exactly one accent, so `data-accent` works on all of
  them.
- **Call-site attributes win** over the part's own, and anything you nest inside the call
  site is kept after the part's markup — so a caption can ride along with the shape:

  ```html
  <g data-part="el-window" transform="translate(70,124)"><text class="title" x="0" y="228">Editor</text></g>
  ```
- **The page must define the element utilities** — `.node`, `.s1`–`.s4`, `.f1`–`.f4`,
  `.sline .fline .sfaint .ffaint .fground .glyph`. `diagram.html`, `sequence.html` and
  `elements.html` already carry the block. A page missing them is fatal before Chrome
  launches, because parts carry no color of their own and undefined utilities render as
  invisible or unstroked shapes on an otherwise perfect PNG.
- **Includes are not recursive.** A `data-part` inside another part's call site is skipped
  and then fatal — the substitution runs one pass. Place the part, then draw its contents in a
  *sibling* `<g>` on the same origin; `templates/deployment.html` fills `el-cube` that way.
- An unknown part id is fatal too, and lists what exists.

Frames are nodes in their own right: caption them with a `.title`/`.sub` pair beneath, or
replace the faint skeleton bars with real mono `<text>` when the content matters. They also
take a real screenshot — `data-image` fills the frame's screen, see §6. Glyphs drop
into a standard node card at `transform="translate(20,30)"` in place of the stock circle
glyph; they inherit stroke 1.6 and round caps from `.glyph`.

**The chart parts are schematics of charts, not charts.** Every proportion in them is fixed
and arbitrary — `el-chart-pie` is always 40/25/20/15, `el-chart-gauge` always reads 68%. They
exist to say *"a dashboard goes here"* in an architecture figure, the way `el-database` says
*"a database goes here"*. Never present one as data. If the numbers are the point, edit the
geometry to the real values and say so, or plot the dataset with a real charting library —
that is still the answer this skill's own description gives for data charts.

Charts hold to the same accent discipline as everything else (§4): **one accent per part**,
graded by opacity where categories have to read apart — pie wedges, funnel stages, stack
levels, heatmap cells. `el-chart-scatter` separates its two series by solid dots against
hollow rings rather than by spending a second hue. Nothing here treats an accent as
decoration, so a chart sits inside a figure without competing with the arrows around it.

Copying a part's geometry into your figure still works and renders identically — reach for it
only when you need to edit the shape itself.

## 6. Images

Any image on disk can go into a figure: a screenshot inside a device frame, a photo cropped
to a circle, a logo on a card, a photograph behind a headline. One attribute does all of it.

```html
<g data-part="el-browser" data-image="./shot.png" transform="translate(60,80)"/>
<image data-image="./avatar.jpg" data-shape="circle" x="60" y="420" width="160" height="160"/>
<div data-image="./texture.jpg" style="position:absolute;inset:0"></div>
<img src="./logo.png" style="width:120px">
```

**On a framing part, `data-image` fills its screen.** `el-browser`, `el-window`,
`el-terminal`, `el-phone` and `el-dashboard` each declare the rectangle their content sits
in; the image is cropped to the shell's own corners and covers the skeleton bars the frame
ships with. Every other part refuses `data-image` and lists the ones that take it — for any
other shape, place an `<image>` yourself.

| Knob | Default | |
|---|---|---|
| `data-fit` | `cover` | `cover` fills the box and crops the overflow · `contain` fits the whole image and letterboxes it · `stretch` distorts to fill |
| `data-align` | `center` | which part survives a `cover` crop: `center` `top` `bottom` `left` `right`. `top` is what a long page screenshot wants |
| `data-shape` | `rect` | on `<image>` and `<img>` only: `rect` `rounded` `circle` `hex` |
| `data-radius` | `16` | corner radius for `data-shape="rounded"` |

- **Sources are local files.** A relative path resolves **against the HTML file's own
  directory**, not the working directory; absolute paths and `file:` URLs work too. A remote
  URL is refused: one that 404s or loads slowly leaves an invisible hole in a figure that
  still screenshots as a success. `curl -fsSL -o image.png "…"` first.
- **The bytes are inlined** as `data:` URIs into the temp copy before Chrome launches, so the
  prepared page is self-contained and your source file is untouched. PNG, JPEG, GIF, WebP,
  AVIF, BMP and SVG. HEIC and TIFF are refused with the command to convert them — Chrome
  decodes neither.
- **Every failure is fatal and pre-launch**, naming the path it resolved: a missing file, a
  directory, an empty file, a file that is not an image whatever its extension, one over
  12 MB, or a page whose images total more than 32 MB.
- **An `<image>` needs an explicit `width` and `height`.** Sized only by its intrinsic
  dimensions it is a coin flip across Chrome builds, and the losing side is an invisible
  image inside a frame that drew perfectly. The error reports the image's natural size so you
  can paste it in.
- **`url()` in a `<style>` block or a `style=` attribute is inlined too**, so
  `background-image: url(./hero.jpg)` works as written. A remote `url()` is passed through to
  Chrome untouched, like the theme's font import.
- **A plain `<img src>` is inlined and otherwise left exactly as written.** The `data-*`
  vocabulary is opt-in; nothing here restyles markup that did not ask for it.
- **The render reports what it placed** — name, pixel size, format, weight. Read that line:
  it is the cheapest way to notice you just framed last week's screenshot.

Discipline: an image is content, not furniture. One per figure carries a point; three compete
for it. Crop to what matters with `data-align` rather than shrinking the whole thing so it
fits, and caption a frame the way you would any other node. A raw rectangle of UI dropped on
a themed ground reads as a mistake — put screenshots in a frame.

## 7. Code snippets

`$SKILL/templates/code.html` is a Carbon-style code window — surface, traffic dots, filename, a
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

## 8. Layout discipline

Check these before rendering, not after:

- **Measure labels against gaps.** Mono runs ≈ 0.6 em per character; a 12.5px label needs
  ~7.5px per character, and centred between two nodes it must clear both edges.
- **Crossings get a bridge.** Where a vertical line must cross a horizontal one, hop it
  with a small half-circle: `V y+9  A 9 9 0 0 0 x y-9  V …` — never just draw through.
- **The body is the canvas.** Its CSS width/height must equal the render size exactly,
  with `overflow: hidden`. Anything positioned outside is silently cropped.
- Three points per slide is the ceiling. A diagram that needs more than ~7 nodes is two
  diagrams.

## 9. Presentations

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
  node "$SKILL/scripts/render.mjs" "$s" "out/$(basename "${s%.html}").png" --theme ember
done
```

Keep one theme per deck. The footer's `NN / NN` is manual — update it per slide. To ship a
single file, combine the PNGs into a PDF with whatever the machine has
(`magick out/*.png deck.pdf`, or print the folder from any viewer).

## 10. QA checklist

Before delivering any image:

- [ ] Rendered and **viewed** — not assumed
- [ ] Code figures: highlighting spot-checked token by token; at most one `.hl` line
- [ ] Images: the file the log named is the one you meant, and the crop kept the point
- [ ] Transparent renders: viewed composited over a sample background, not just alone
- [ ] No text touches a node edge, a line, or the canvas edge
- [ ] Every line crossing is bridged
- [ ] One gradient phrase at most; accents used by meaning, not variety
- [ ] Facts in the copy verified against the project (counts, versions, names)
- [ ] Output at 2x unless the destination demands otherwise (GIFs: 1x)
- [ ] Animations: every step present in order, and the final frame holds long enough to read
- [ ] Every output PNG opened and looked at — the renderer catches a blank or mis-sized
      figure, but only you catch an ugly one
