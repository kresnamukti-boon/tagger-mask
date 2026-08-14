# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Client-side workflow enhancers for the Constructions Tagger annotation platform
(`constructions-tagger-web.onrender.com`). This is **not a normal web app** — there's no
server, no framework, no package.json. It's a set of plain-JS modules that get concatenated
into a single script and pasted into the browser DevTools console (or loaded via a
Tampermonkey userscript) to run inside the live annotation page. Nothing here runs standalone
or has its own runtime; every module assumes it's executing inside the Constructions Tagger
page and reaches into that page's globals (`annotationState`, `editHistory`,
`createHistoryEntry`, DOM ids like `pdf-canvas`/`annotation-canvas`/`pdf-container`).

Two builds exist from the same module set:
- **Console loader** (`console_loader.js`) — paste into DevTools console. Rebuilt by `build_loader.sh`.
- **Tampermonkey userscript** (`region-workbench.user.js`) — auto-injects on page load. Rebuilt by `build_userscript.sh`.
- `console_loader_sam.js` — SAM-enabled variant (adds `rw_sam.js`), rebuilt by `build_loader_sam.sh`.

Nothing auto-draws or auto-submits annotations. Every commit action stages an edit through
the app's own `annotationState`/`editHistory` contract as an unsaved pending edit — the user
must always click the app's own **Save** button. The activity tracker
(`/analytics/api/events/`) is read-only observed, never spoofed. Preserve this boundary in
any change.

## Build / verify commands

There is no package manager, linter, or test suite. The only "build" step is concatenation,
and the only verification is `node --check` (syntax-only — it can't validate against the
live page's DOM/globals).

```bash
# After editing any rw_*.js or wf_helpers.js source module:
bash build_loader.sh          # rebuilds console_loader.js (runs node --check on the result)
bash build_loader_sam.sh      # rebuilds console_loader_sam.js (SAM-enabled variant; doesn't
                               # run node --check itself — run it manually after)
bash build_userscript.sh      # rebuilds region-workbench.user.js (Tampermonkey build)
```

Always rebuild the relevant loader after touching a source module — the loader files are
generated output and edits to them alone will be lost/inconsistent. To actually verify a
change works, it has to be pasted into a real annotation-job page in Chrome (see README.md
"Injection" / README.txt for the manual steps); there's no headless harness for
`annotationState`.

## Architecture

### Load order is the architecture

Every module is an IIFE that mutates a single shared global, `window.__RW`, and each one
guards its own entry point by checking a version flag set by the *previous* module in the
chain — e.g. `rw_masktools.js` bails with `'need RW v2 first'` if `RW.v !== 2`. This makes
load order load-bearing, not cosmetic. The canonical order (see `build_loader.sh`'s file
list) is:

1. **rw_panelux.js** (v2.8) — loads FIRST, before `__RW` even exists. Wraps
   `annotation-canvas.addEventListener` so every handler registered by later modules is
   auto-gated on `RW.enabled`; also owns the collapsible panel UI and master on/off killswitch.
2. **rw_install.js** (v2) — creates `window.__RW`. Core: flood-fill region segmentation from
   canvas linework, region list panel, Pick mode, Merge/Cut.
3. **rw_masktools.js** (v2.1) — unified Rect mask tool (`block`/`open`/`add` actions, shared
   with v2.6 via `RW.maskAction`), operates on `RW.wall`/`RW.labels`. Also owns the global area
   floor input + Relabel button, the `W` wall/floodable overlay, and the live area hint.
4. **rw_stable.js** (v2.2) — pan/zoom-stable preview rendering; introduces the
   `_toNorm`/`_toPx` normalized-coordinate helpers that everything downstream uses so previews
   stay glued to the drawing while the user pans/zooms.
5. **rw_undo.js** (v2.3) — snapshot-based undo stack (`RW._undoStack`, `RW._snapshot`,
   `RW.undo`) plus poly-specific vertex undo.
6. **rw_commit.js** (v2.5) — turns mask contours into real pending annotations by directly
   pushing onto `annotationState.annotations` and `editHistory`, mirroring the app's own
   `createPolygonPolylineAnnotation` mechanism exactly (see the file's header comment for the
   4-step mechanism). This is the only module that writes annotation state.
7. **rw_healinterior.js** (v3) — "Heal Interior?"/"Apply Heal" for the Pick-mode selection (see
   below). Wraps `RW.toggleGroup` to keep its preview in sync when the selection changes.
8. **rw_brushpoly.js** (v2.6) — Poly2 (freeform vertex) and Brush (freehand stroke) mask tools.
   Owns the `A` add-mode toggle and the `_actionLabel`/`_actionColor`/`_syncToolButtons` helpers.
9. **rw_snap.js** (v2.7) — Poly2 vertex snapping (see below). Wraps `RW._relabel`/`RW.extract`
   to invalidate its cache and wraps `RW._renderPreview` again to draw the snap-hit marker —
   third layer of wrapping on that function after `rw_stable.js`'s original and
   `rw_brushpoly.js`'s recolor wrap.
10. **rw_textdetect.js** (v2.9) — "Text? (density)" detection-only overlay (see below). Wraps
    `RW._buildSnapPoints` again to invalidate its own dirty flag on the same schedule.
11. **rw_sam.js** (v2-sam, SAM build only) — SAM3-via-Replicate box segmentation, talks to a
    local proxy on port 5001 (`sam3_proxy.py`, not in this repo).
12. **wf_helpers.js** — intentionally independent of the `__RW` chain (no version-flag guard).
    Page nav (`[`/`]`), tag-search focus (`/`), coverage heatmap (`H`).

When adding a new module or reordering, replicate this pattern: check the previous module's
version flag at the top, set your own flag, and only proceed if the check passes. When adding
new instance state, put it on `RW` (or `RW._` prefixed for internals) rather than a new global.

### Keybindings can shadow the app's own shortcuts

Workbench keydown handlers are attached on `document`/`annotation-canvas` in the **capture
phase** with `stopPropagation()`, so they run before — and block — the app's own keydown
handlers for the same key. This is deliberate (it's how `RW.enabled`'s killswitch and mode
switching work reliably), but it means picking a key already used by the app's own tool
palette silently disables that app shortcut entirely while the workbench is loaded, with no
error or warning. Confirmed example: the workbench's **K** (Cut mode) fully shadows the app's
own **K = Magic Wand** tool. Before adding a new keybinding, check the app's built-in keymap
(`README.md`'s "App built-in keymap" section — extracted from their JS, but verify live since
it can drift, as the Magic Wand/Wrap tools weren't in it) for a collision, and if one exists,
document it there rather than silently living with it.

### Coordinate systems

Two coordinate spaces are in play and mixing them up is the most common bug source:
- **Pixel space** on an internal extraction canvas (`RW.W` x `RW.H`, scaled from the native
  `pdf-canvas` resolution — see the scaling logic in `RW.extract`).
- **Normalized page space** (0-1 relative to `pdf-container`'s bounding rect), used for
  anything that must survive pan/zoom — in-progress tool geometry, previews, annotation
  coordinates. Convert via `RW._toNorm`/`RW._toPx` (defined in `rw_stable.js`, with a
  pre-load-order fallback shim in `rw_masktools.js`).

### Region model

`RW.extract()` reads the drawing canvas, treats any non-white pixel as a "wall", flood-fills
from the canvas border to find background, then labels enclosed connected components as
candidate regions (`RW.labels`, `RW.regions`). Existing annotations are painted onto the wall
mask first so already-annotated areas are excluded. Regions can be merged (grouped by
`region.group`) or cut (split via `RW.applyCut`). Mask edit tools (rect/poly/brush) write
directly into `RW.wall` and trigger a re-label that preserves group identity via centroid
matching. `RW.commitSelected` traces the final region group contours (Moore-neighbor tracing
in `rw_commit.js`), smooths the traced pixel staircase with Chaikin corner-cutting
(`RW.smoothPasses`, default 4 passes) so DP simplification sees curves rather than stairsteps,
then simplifies with Douglas-Peucker (`RW.smoothEps`, default ~1.2) before writing the result
out as pending polygon annotations.

### Known edge case

Spec sheets with colored/faint linework at extreme zoom extract poorly — the min-RGB-channel
threshold in `RW.extract` can miss faint lines or over-include noise at those zoom levels.
Not yet fixed; if you touch the extraction threshold, keep this case in mind.

## Mask action modes (`RW.maskAction`)

Three shared states control what every mask tool (Rect B, Poly2 N, Brush J) does when it
commits a stroke. `RW.maskAction` is set on `window.__RW` and read by both `rw_masktools.js`
and `rw_brushpoly.js`:

- **`block`** — paint `wall = 1` (add walls). Default. Used inside existing enclosed areas.
- **`open`** — paint `wall = 0` (erase walls / heal splits).
- **`add`** — create a new region from scratch in empty whitespace. This is the state that
  makes the tools work on sparse/white pages where there are no existing enclosures.

Keybindings:
- **`A`** toggles add mode on/off (`block` ↔ `add`) — a simple boolean toggle, not a 3-way cycle.
- **`Shift+B` / `Shift+N` / `Shift+J`** cycle all three states (`block → open → add → block`).
- The **Add ⊕ (A)** panel button mirrors the `A` key. `RW._syncToolButtons()` and
  `RW._syncRectBtn()` re-label the tool buttons with the current action symbol
  (`−`/`+`/`⊕`) and highlight green when add is active.

### Add-mode region creation algorithm

Add mode works by **fill-then-hollow** so the result has a gapless 2px wall border (a raw 1px
Bresenham perimeter leaks through diagonal gaps during flood-fill, producing phantom regions):

1. Build a **skip mask** from `RW.labels`/`RW.regions` — mark every pixel already belonging to
   an `included` region (scanned only within the drawn shape's bounding box, never the full
   `W×H` grid — this is an important perf constraint).
2. Paint the shape as `wall = 1`, then clear the interior `wall = 0` — **skipping** the
   skip-mask pixels so existing regions are never overwritten. (Rect shrinks 2px inward; poly
   shrinks vertices 2px toward centroid; brush paints a `r+2` outer wall ring then `r-1`
   interior clear.)
3. Call `RW._relabel()`, then **force-include** the single region at the drawn shape's centroid
   (`RW.regions[l].included = true`) — this intentionally bypasses `_areaFloor` so a
   deliberately drawn shape appears even when small.

## Poly2 vertex snapping (`rw_snap.js`)

Poly2 vertices snap to two distinct kinds of target, merged into one spatial index:
line endpoints/intersections detected on `RW.wall` (point snap — see pipeline below), and any
point along an included region's outline (edge snap — lets a vertex slide along a boundary's
length, not just its corners; green/cyan marker ring for point snap, yellow for edge snap).
Hold **Shift** while clicking a vertex to bypass snapping for that click; the panel
**Snap On/Off** button toggles both globally (`RW._snapEnabled`).

Pipeline, rebuilt lazily (only when `RW._snapDirty` — set by wrapping `RW._relabel`/`RW.extract`
— and only on the next actual snap query, not eagerly):
1. **Density-prefilter** `RW.wall` (`RW._buildThinMask`) via an integral image (summed-area
   table): any wall pixel whose local window (`RW._snapFillRadiusPx`, ~10px at the 2592
   baseline) is more than `RW._snapFillDensityThresh` (0.55) wall gets excluded before
   skeletonizing. **This step is load-bearing, not an optimization nicety** — on a real
   pavement-hatch job this measured at 36% of the *entire* canvas marked as wall, and (a)
   skeletonizing that many pixels synchronously hangs the tab for tens of seconds, and (b)
   hatch fill has no meaningful line endpoints/junctions anyway, so without this step the
   result is both slow and wrong. The prefilter cut that drawing's candidate set by ~19x
   (3.95M → ~200K wall pixels) in ~300ms.
2. **Skeletonize** the filtered mask with Zhang-Suen thinning (`RW._skeletonize`), using an
   active-list optimization (cost scales with surviving-pixel count, not full `W×H`) and
   reading the 8-neighborhood as plain locals rather than a per-pixel allocation — this runs
   over the active list up to ~120 times, so avoiding allocation-per-pixel here is the
   difference between sub-second and tens of seconds.
3. **Classify** each surviving skeleton pixel by 8-neighbor count (`RW._classifySkeleton`):
   1 neighbor = endpoint, 3+ = junction, 2 = ordinary skeleton point (not a candidate).
4. **Cluster** nearby candidates (`RW._clusterPoints`) since a real junction typically yields
   several adjacent classified pixels; junction wins over endpoint when a cluster mixes both.
5. **Region-outline edge points** (`RW._buildEdgePoints`): every included region's boundary
   pixel is added as its own *unclustered* snap candidate (`kind:'edge'`) in a single O(W×H)
   pass over `RW.labels`/`RW.regions` (a pixel is a boundary pixel if any 4-neighbor belongs to
   a different group or isn't included). These deliberately bypass `_clusterPoints` — merging
   them would defeat the point of edge-snapping, since the whole point is fine-grained density
   along the boundary's length, not consolidation into corners. **Do not reuse
   `RW._rawContour`** (the existing per-group Moore-neighbor tracer in `rw_install.js`, used for
   the commit preview) for this — it re-scans the *entire* `W×H` image on every single call,
   which is fine for the handful of `RW.selected` groups it was written for but would be
   `O(W×H × region count)` here, hanging far worse than the density-fill issue above.
6. **Index** the combined point-snap + edge-snap candidates in a bucket grid
   (`RW._buildSnapIndex`) for nearest-point lookup. The catch radius (`RW._snapCatchPx`) is
   recomputed per query from the current `pdf-container` width so it stays ~14 screen px
   regardless of zoom — the same zoom-invariance principle used for stroke widths elsewhere in
   the workbench — while the grid's own bucket size stays fixed in mask-px terms (it only needs
   to be cheap to build).

Because `RW.wall` already has already-annotated regions painted in (see `RW.extract`'s
"knock out existing annotations" step) and mask-tool edits write directly into `wall`, both
point-snap candidates AND region-outline edge points naturally include existing annotation
boundaries and freshly-drawn block/open/add shapes, not just the original drawing linework —
this is intentional, not a special case to special-case around. One consequence worth knowing:
an edge-snap point sourced from an existing annotation's boundary won't show up in a screenshot
of `pdf-canvas` alone, since that boundary is rendered as a separate overlay by the app, not
baked into the base drawing image — don't mistake a blank crop of `pdf-canvas` at a snap
point's coordinates for a bug; cross-check `annotationState.annotations` (point-to-segment
distance, not point-to-vertex) before concluding a snap target is spurious.

If snapping ever again appears to "do nothing" on a real job, suspect wall density first:
check `RW.wall.reduce((a,b)=>a+b,0) / (RW.W*RW.H)` before assuming the skeletonization or
classification logic itself is broken — this was the actual root cause the one time it came up
(verified live against a real annotation page via `opencli`, not just synthetic test data; see
the `boon-tagger-opencli-testing` memory for that workflow).

## Text/interior-noise detection & healing (`rw_textdetect.js`, `rw_healinterior.js`)

Two shipped features (both in the main and SAM console loaders) address "text/dimension marks
getting treated as wall, distorting region shapes" — the practical problem behind the old
"Text exclusion" roadmap item. They solve different halves of it and don't depend on each other.

- **`rw_textdetect.js`** — whole-page, detection-only. A "Text? (density)" panel toggle
  highlights areas where `RW._skeletonCandidates` (reused from `rw_snap.js`, see below) cluster
  more densely than real linework does — text glyphs are small, stroke-heavy shapes, so they
  produce far more skeleton points per unit area. Tunable live via `cell`/`min` panel inputs.
  **Never edits `RW.wall`** — purely a manual-review aid. Confirmed live: works well for real
  text (including rotated text) on a page with no pre-existing annotations, but also flags
  repeated line symbols (a fence/tick-mark pattern chained into one page-spanning false
  positive) and, on a page with existing annotations, is dominated by annotation-interior
  artifacts unless filtered out.
- **`rw_healinterior.js`** — scoped to the Pick-mode **selection** (`RW.selected`), not the
  whole page. A "Heal Interior?" panel button previews which wall pixels inside the selected
  region(s) are safe to erase without merging the region into a neighbor (`RW._computeInteriorNoise`);
  a separate "Apply Heal" button commits it (with an undo snapshot, like other mask edits). The
  `hole≤` input tunes how big a non-included neighboring area can be before it's protected
  rather than treated as negligible noise (deliberately separate from `RW._areaFloor` — that one
  tunes what counts as a selectable candidate region, not what counts as noise).

  **Read the file's own header comment in full before changing this logic.** It documents five
  distinct failure modes found through live testing against real jobs, each requiring a
  genuinely different kind of fix rather than a tuning tweak — a "one more patch" mentality
  bit this feature repeatedly: component-veto too strict → fixed-window padding too narrow for
  hatch-heavy pages → unbounded search wandering the whole page when a region has no nearby
  neighbor → a real building floor plan merged into one label via a door-opening gap
  (indistinguishable from noise by pure topology) → existing annotations' wall-knockout treated
  as erasable noise. The throughline: this can only ever reason from wall/label topology, and
  real drawings have cases where topology alone doesn't encode what a human would recognize by
  looking at the content. If a sixth failure mode turns up, check whether it's actually a new
  case or a regression of one of the five documented ones first.

## Wall overlay & relabel controls

- **`W`** (or the **Walls (W)** button) cycles a 3-state diagnostic overlay on `#rw-wall-overlay`:
  1. **Red** — every `wall === 1` pixel.
  2. **Cyan** — "floodable" white space: border flood-fill then highlight whatever was NOT
     reached (i.e. enclosed areas that would become regions). The cyan flood must mirror
     `_relabel()`'s border flood **including** treating existing `included` region pixels as
     barriers, or the preview will disagree with the real relabel.
  3. Off. (`RW.wallOverlayState`: 0/1/2.)
- **Global area floor** — a numeric input (`#rw-relabel-inp`, default `2500`) whose `onchange`
  writes `RW._areaFloor`. This is read by `_relabel()` AND `RW.extract()`, so it affects every
  mask tool, Re-extract, and Relabel. The adjacent **Relabel** button just calls
  `RW.relabelAll()` → `_relabel()` + re-render without discarding edits (unlike Re-extract,
  which re-reads the raw canvas and wipes all brush/rect/poly work).
- **Live area hint** — while dragging, `RW._showAreaHint(px)` renders `area: N px ≥/< floor`
  into `#rw-commit-status`, green/red. Rect uses `w×h`, poly uses `RW._polyArea` (shoelace on
  normalized vertices), brush uses an approximate `strokes × (2·radius)²`. Cleared on
  mouseup/dblclick via `RW._showAreaHint(null)`.

### Falsy-zero pitfall

`_areaFloor` uses null-coalescing (`RW._areaFloor != null ? RW._areaFloor : 2500`), NOT
`RW._areaFloor || 2500`. The `||` form silently ignores a legitimate `0`/`1` floor and falls
back to 2500 — this was the root cause of an earlier "Relabel All does nothing" bug. Both
`rw_masktools.js#_relabel` and `rw_install.js#extract` must keep this exact check.

## Constraints (do not violate)

- **Console injection only.** No Tampermonkey/userscript path in active use — the userscript
  build (`region-workbench.user.js`) exists but hit sandbox issues in practice, so
  `console_loader.js` (paste-per-page) is the real delivery mechanism. Don't assume the
  userscript build is what's actually deployed to annotators.
- **The user base is annotators, not programmers.** The tool must stay paste-and-go — no
  install steps, no config files, no build step required on the annotator's end. Any UI you
  add should degrade gracefully and explain itself (see `_showAreaHint`, `_commitStatus` for
  the existing pattern of inline status text over silent state).
- **This is a bridge tool, not a replacement for engineering.** It stages candidate work for
  human review inside the app's existing Save/EditHistory flow; it should not grow into an
  independent pipeline that bypasses that review step.

## Roadmap (not yet built — do not assume these exist)

- **Controller support** — a Gamepad API module mapping buttons to workbench functions.
- **Training data export** — committed polygons → labeled mask PNGs + canvas captures
  (SA-1B-style dataset), intended to fine-tune SAM3 on Boon's own drawings (off-the-shelf SAM3
  via Replicate returns 0 masks on CAD linework without fine-tuning — it wasn't trained on this
  domain).
- **Direct DB access** — potential future move from raster-pixel extraction + EditHistory
  simulation to vector linework + direct DB writes, plus batch page processing. Not started;
  would be a significant architecture change from everything described above.

## Docs already in the repo

- `README.md` — file/load-order reference, full keymap (workbench + app's own built-in keymap), injection steps.
- `README.txt` / `SLACK_SNIPPET.txt` — end-user-facing quick-start text for distributing the tool to annotators; keep these in sync with `README.md`'s keymap if shortcuts change.
