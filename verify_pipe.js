// Synthetic Node harness for rw_wallspan.js's pipe-only snapping and live
// width dimension line. Loads the real module body against a minimal DOM
// stub (no browser, no network) and drives real registered mousedown/
// mousemove/mouseup listeners — same discipline as verify_ocr.js.
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name){
  if (cond){ pass++; }
  else { fail++; console.error('FAIL: ' + name); }
}
function approx(a, b, eps, name){
  ok(Math.abs(a - b) <= (eps != null ? eps : 1e-6), name + ' (got ' + a + ', want ' + b + ')');
}

/* ---------- minimal DOM stub (same shape as verify_ocr.js) ---------- */

function findById(node, id){
  for (const c of (node._children || [])){
    if (c.id === id) return c;
    const f = findById(c, id);
    if (f) return f;
  }
  return null;
}

// `registry` (a document's byId map) lets a real `.remove()` call properly
// unregister the element, matching real DOM semantics where a detached
// element is no longer found by getElementById — without this, an element
// removed directly (rather than through _mkSvg's own bookkeeping) would
// falsely appear to "survive" in the stub.
function makeElement(tag, registry){
  const listeners = {};
  const el = {
    tagName: tag,
    id: '',
    hidden: false,
    value: '',
    innerText: '',
    innerHTML: '',
    style: { cssText: '', display: '' },
    classList: { _set: new Set(), contains(c){ return this._set.has(c); } },
    disabled: false,
    _children: [],
    parentNode: null,
    _rect: { x: 0, y: 0, width: 100, height: 100 },
    getBoundingClientRect(){ return this._rect; },
    addEventListener(type, fn){ (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent(evt){ (listeners[evt.type] || []).slice().forEach(fn => fn(evt)); return true; },
    _fire(type, evt){
      evt = Object.assign({ stopPropagation(){}, preventDefault(){}, stopImmediatePropagation(){}, shiftKey:false }, evt);
      (listeners[type] || []).slice().forEach(fn => fn(evt));
    },
    appendChild(child){ this._children.push(child); child.parentNode = this; return child; },
    removeChild(child){
      const idx = this._children.indexOf(child);
      if (idx !== -1) this._children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    remove(){
      if (this.parentNode) this.parentNode.removeChild(this);
      if (registry && registry[this.id] === this) delete registry[this.id];
    },
    querySelector(sel){
      if (sel[0] === '#') return findById(this, sel.slice(1));
      return null;
    }
  };
  return el;
}

// pdf-container rect deliberately non-zero x/y — at x:0,y:0 the coordinate
// bug this change fixes would be invisible and the regression test worthless.
const CONTAINER_RECT = { x: 300, y: 120, width: 1000, height: 1000 };

function makeStubEnv(){
  const byId = {};
  const documentStub = {
    _byId: byId,
    getElementById(id){ return byId[id] || null; }
  };

  const winListeners = {};
  const win = {
    document: documentStub,
    addEventListener(type, fn){ (winListeners[type] = winListeners[type] || []).push(fn); },
    _fire(type, evt){ (winListeners[type] || []).slice().forEach(fn => fn(evt)); }
  };

  const ac = makeElement('canvas', byId);
  ac.id = 'annotation-canvas';
  byId['annotation-canvas'] = ac;

  const container = makeElement('div', byId);
  container.id = 'pdf-container';
  container._rect = Object.assign({}, CONTAINER_RECT);
  byId['pdf-container'] = container;

  const statusEl = makeElement('span', byId);
  statusEl.id = 'rw-commit-status';
  byId['rw-commit-status'] = statusEl;

  const RW = {
    v29: true,
    W: 1000, H: 1000,
    _toNorm(cx, cy){
      const cr = documentStub.getElementById('pdf-container').getBoundingClientRect();
      return [(cx - cr.x) / cr.width, (cy - cr.y) / cr.height];
    },
    _toPx(nx, ny){
      const cr = documentStub.getElementById('pdf-container').getBoundingClientRect();
      return [nx * cr.width, ny * cr.height];
    },
    _mkSvg(id, z){
      const old = documentStub.getElementById(id);
      if (old) old.remove();
      const svg = makeElement('svg', byId);
      svg.id = id;
      container.appendChild(svg);
      byId[id] = svg;
      return svg;
    },
    _commitStatus(msg){
      const el = documentStub.getElementById('rw-commit-status');
      if (el) el.innerText = msg;
    }
  };
  win.__RW = RW;

  return { win, doc: documentStub, byId, ac, container, RW };
}

function loadModule(win, extraGlobals){
  const src = fs.readFileSync(path.join(__dirname, 'rw_wallspan.js'), 'utf8');
  const annotationState = (extraGlobals && extraGlobals.annotationState) || { annotations: [] };
  if (annotationState.currentTag === undefined) annotationState.currentTag = { id: 1, name: 'Pipe' };
  const sandboxGlobals = Object.assign({
    window: win,
    document: win.document,
    annotationState: annotationState
  }, extraGlobals || {});
  const fn = new Function(...Object.keys(sandboxGlobals), src + '\n//# sourceURL=rw_wallspan.js');
  const ret = fn(...Object.values(sandboxGlobals));
  // Minimal RW._createPendingAnnotation/_forceRender stubs so RW.commitPipe
  // can run end-to-end in Node — mirrors rw_commit.js's real contract closely
  // enough for these tests (coordinates stored verbatim, notes preserved).
  const RW = win.__RW;
  if (RW && !RW._createPendingAnnotation){
    let tempCounter = 0;
    RW._createPendingAnnotation = function(normPts, notes){
      const a = { id: 'temp_rw_test_' + (tempCounter++), coordinates: normPts, notes: notes || '', _pending: true };
      annotationState.annotations.push(a);
      return a;
    };
  }
  if (RW && !RW._forceRender) RW._forceRender = async function(){};
  if (RW) RW._testAnnotationState = annotationState;
  return ret;
}

// Like loadModule, but also loads the real rw_commit.js first — needed only
// by the raster-merge eps tests below, which exercise the actual raster
// pipeline (RW._rasterizePolyLocal/_maskToPolygon/_simplifyRing) rather than
// spying it out. Every other test in this file deliberately avoids this, to
// stay decoupled from rw_commit.js's own test surface.
function loadModuleWithCommit(win, extraGlobals){
  win.__RW = win.__RW || {};
  win.__RW.v23 = true;
  const commitSrc = fs.readFileSync(path.join(__dirname, 'rw_commit.js'), 'utf8');
  const annotationState = (extraGlobals && extraGlobals.annotationState) || { annotations: [] };
  const sandboxGlobals = Object.assign({ window: win, document: win.document, annotationState }, extraGlobals || {});
  new Function(...Object.keys(sandboxGlobals), commitSrc + '\n//# sourceURL=rw_commit.js')(...Object.values(sandboxGlobals));
  return loadModule(win, Object.assign({}, extraGlobals, { annotationState }));
}

// Parses attribute values for every element of a given tag out of an
// innerHTML string built from '<tag attr="v" .../>' fragments (this file's
// own preview-rendering convention — no real SVG DOM available here).
function parseTags(html, tag){
  const re = new RegExp('<' + tag + '\\b([^>/]*)/?>', 'g');
  const attrRe = /([a-zA-Z0-9-]+)="([^"]*)"/g;
  const out = [];
  let m;
  while ((m = re.exec(html))){
    const attrs = {};
    let am;
    attrRe.lastIndex = 0;
    while ((am = attrRe.exec(m[1]))) attrs[am[1]] = am[2];
    out.push(attrs);
  }
  return out;
}
function parseTextTags(html){
  const out = [];
  const re = /<text\b([^>]*)>([^<]*)<\/text>/g;
  const attrRe = /([a-zA-Z0-9-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))){
    const attrs = {};
    let am;
    attrRe.lastIndex = 0;
    while ((am = attrRe.exec(m[1]))) attrs[am[1]] = am[2];
    out.push({ attrs, text: m[2] });
  }
  return out;
}

// Builds a RW._pipeNetwork-shaped entry directly (bypassing DOM clicks), for
// tests that exercise RW._pipeChainMerge/_pipeMergeConnected's own logic
// rather than the click state machine. `opts.links`/`linkStart`/`linkEnd`/
// `linkMid` mirror exactly what RW._pipeFinishPath would have stored.
function mkSeg(RW, ptsN, widthPx, opts){
  opts = opts || {};
  return {
    ptsN: ptsN, widthPx: widthPx, ribbon: RW._pipeRibbon(ptsN, widthPx),
    links: opts.links || [],
    linkStart: opts.linkStart || null,
    linkEnd: opts.linkEnd || null,
    linkMid: !!opts.linkMid
  };
}

/* ================= Task 1: pipe-only snapping ================= */

// Test A: pipe snap wins even when NOT literally inside the body, and even
// though a "closer" wall/region hit exists — this is exactly the case the
// old `winnerInside` clause let the wall snap win.
{
  const { win, RW, ac } = makeStubEnv();
  RW._trySnap = function(nx, ny){
    RW._lastSnapHit = { x: nx * RW.W, y: ny * RW.H, kind: 'endpoint' }; // "wall hit" at the exact raw click — distance 0
    return [nx, ny];
  };
  loadModule(win);
  RW.pipeMode = true;
  RW._pipeNetwork = [{ ptsN: [[0.5, 0.5], [0.7, 0.5]], widthPx: 20, ribbon: RW._pipeRibbon([[0.5, 0.5], [0.7, 0.5]], 20), links: [] }];

  // click at mask-px (600,512): container-px = mask-px + (cr.x,cr.y) here since RW.W===cr.width
  const clientX = 600 + CONTAINER_RECT.x, clientY = 512 + CONTAINER_RECT.y;
  ac._fire('mousedown', { clientX, clientY });
  ac._fire('mouseup', { clientX, clientY });

  ok(RW._pipePts.length === 1, 'A: a point was placed');
  const [px, py] = RW._pipePts[0] || [NaN, NaN];
  approx(px, 0.6, 1e-6, 'A: pipe snap wins on x (not the closer wall hit)');
  // Center/left/right rails are all offered now, so the click (12px below
  // center, 2px below the near edge rail at y=0.51) correctly snaps to that
  // nearer rail rather than being forced onto the centerline.
  approx(py, 0.51, 1e-6, 'A: pipe snap wins on y (nearest of the 3 rails, not raw click y=0.512)');
}

// Test B: RW._trySnap is still called exactly once per placement (side-effect check).
{
  const { win, RW, ac } = makeStubEnv();
  let calls = 0;
  RW._trySnap = function(nx, ny){ calls++; return [nx, ny]; };
  loadModule(win);
  RW.pipeMode = true;
  RW._pipeNetwork = [{ ptsN: [[0.5, 0.5], [0.7, 0.5]], widthPx: 20, ribbon: RW._pipeRibbon([[0.5, 0.5], [0.7, 0.5]], 20), links: [] }];

  const clientX = 600 + CONTAINER_RECT.x, clientY = 500 + CONTAINER_RECT.y;
  ac._fire('mousedown', { clientX, clientY });
  ac._fire('mouseup', { clientX, clientY });
  ok(calls === 1, 'B: RW._trySnap called exactly once (got ' + calls + ')');
}

// Test C: no pipe candidates anywhere + a wall hit present -> raw click point used.
{
  const { win, RW, ac } = makeStubEnv();
  RW._trySnap = function(nx, ny){
    RW._lastSnapHit = { x: nx * RW.W + 5, y: ny * RW.H, kind: 'endpoint' }; // a nearby wall hit
    return [nx + 5 / RW.W, ny];
  };
  loadModule(win);
  RW.pipeMode = true;
  RW._pipeNetwork = [];

  const clientX = 400 + CONTAINER_RECT.x, clientY = 350 + CONTAINER_RECT.y;
  ac._fire('mousedown', { clientX, clientY });
  ac._fire('mouseup', { clientX, clientY });

  approx(RW._pipePts[0][0], 0.4, 1e-6, 'C: no pipe candidates -> raw click x used, wall hit ignored');
  approx(RW._pipePts[0][1], 0.35, 1e-6, 'C: no pipe candidates -> raw click y used, wall hit ignored');
  ok(RW._pipeSnapHit === null, 'C: RW._pipeSnapHit stays null with no pipe candidates');
}

// Test D: Shift bypasses everything, including calling RW._trySnap at all.
{
  const { win, RW, ac } = makeStubEnv();
  let calls = 0;
  RW._trySnap = function(nx, ny){ calls++; return [nx, ny]; };
  loadModule(win);
  RW.pipeMode = true;
  RW._pipeNetwork = [{ ptsN: [[0.5, 0.5], [0.7, 0.5]], widthPx: 20, ribbon: RW._pipeRibbon([[0.5, 0.5], [0.7, 0.5]], 20), links: [] }];

  const clientX = 600 + CONTAINER_RECT.x, clientY = 500 + CONTAINER_RECT.y;
  ac._fire('mousedown', { clientX, clientY, shiftKey: true });
  ac._fire('mouseup', { clientX, clientY, shiftKey: true });

  ok(calls === 0, 'D: Shift bypass never calls RW._trySnap');
  ok(RW._pipeSnapHit === null, 'D: Shift bypass clears RW._pipeSnapHit');
  approx(RW._pipePts[0][0], 0.6, 1e-6, 'D: Shift bypass places the raw point (x)');
  approx(RW._pipePts[0][1], 0.5, 1e-6, 'D: Shift bypass places the raw point (y) — coincidentally on the pipe, but via no-snap');
}

// Test E: link recording — network hit records its index; annotation hit
// records null (can't be merged); no-hit records null.
{
  const { win, RW, ac } = makeStubEnv();
  loadModule(win);
  RW.pipeMode = true;
  RW._pipeNetwork = [
    { ptsN: [[0.1, 0.1], [0.1, 0.3]], widthPx: 10, ribbon: RW._pipeRibbon([[0.1, 0.1], [0.1, 0.3]], 10), links: [] },
    { ptsN: [[0.5, 0.5], [0.7, 0.5]], widthPx: 20, ribbon: RW._pipeRibbon([[0.5, 0.5], [0.7, 0.5]], 20), links: [] }
  ];
  const annRibbon = RW._pipeRibbon([[0.8, 0.1], [0.8, 0.3]], 10);
  const annotationState = { annotations: [{ id: 'ann1', coordinates: annRibbon, notes: 'pipe width: 10.00' }] };
  // annotationState is read as a bare global inside the module — reload with it injected.
  const { win: win2, RW: RW2, ac: ac2 } = makeStubEnv();
  loadModule(win2, { annotationState });
  RW2.pipeMode = true;
  RW2._pipeNetwork = RW._pipeNetwork;

  // (1) snap onto network entry index 1
  let clientX = 600 + CONTAINER_RECT.x, clientY = 500 + CONTAINER_RECT.y;
  ac2._fire('mousedown', { clientX, clientY });
  ac2._fire('mouseup', { clientX, clientY });
  ok(RW2._pipePendingLinks[0] && RW2._pipePendingLinks[0].ref === 1,
    'E: snapping onto network[1] records link ref 1 (got ' + JSON.stringify(RW2._pipePendingLinks[0]) + ')');
  ok(RW2._pipePendingLinks[0].targetEnd === null,
    'E: a mid-span hit on network[1] records targetEnd null (got ' + RW2._pipePendingLinks[0].targetEnd + ')');

  // (2) a committed annotation is no longer a snap candidate at all (notes
  // are left untouched on commit now, so there's no marker left to scan
  // annotationState.annotations for) — a click on what used to be one now
  // finds nothing and records no link, rather than hitting it as a
  // never-linkable candidate.
  clientX = 800 + CONTAINER_RECT.x; clientY = 200 + CONTAINER_RECT.y;
  ac2._fire('mousedown', { clientX, clientY });
  ac2._fire('mouseup', { clientX, clientY });
  ok(!RW2._pipeSnapHit, 'E: a committed annotation is no longer recognized as a snap candidate');
  ok(RW2._pipePendingLinks[1] === null, 'E: no link is recorded for a miss');

  // (3) no hit at all -> null link
  clientX = 50 + CONTAINER_RECT.x; clientY = 900 + CONTAINER_RECT.y;
  ac2._fire('mousedown', { clientX, clientY });
  ac2._fire('mouseup', { clientX, clientY });
  ok(RW2._pipePendingLinks[2] === null, 'E: a miss records no link');
}

// Test F: baseline happy path — snapping while genuinely inside a pipe's
// body (the pre-existing "always wins" case) still works after the refactor.
{
  const { win, RW, ac } = makeStubEnv();
  loadModule(win);
  RW.pipeMode = true;
  RW._pipeNetwork = [{ ptsN: [[0.5, 0.5], [0.7, 0.5]], widthPx: 20, ribbon: RW._pipeRibbon([[0.5, 0.5], [0.7, 0.5]], 20), links: [] }];

  const clientX = 600 + CONTAINER_RECT.x, clientY = 503 + CONTAINER_RECT.y; // 3px off centerline, inside half-width 10
  ac._fire('mousedown', { clientX, clientY });
  ac._fire('mouseup', { clientX, clientY });
  ok(RW._pipeSnapHit && RW._pipeSnapHit.inside === true, 'F: click inside the pipe body is flagged inside');
  approx(RW._pipePts[0][1], 0.5, 1e-6, 'F: inside-body click still snaps onto the centerline');
}

/* ================= Task 2: live dimension line + coordinate fix ================= */

// Test G: dragging past the 5px threshold renders a correctly-positioned
// dimension line (main line container-relative, NOT raw client coords —
// the direct regression test for the coordinate bug), two perpendicular
// end ticks, and a labeled rect+text at the offset midpoint.
{
  const { win, RW, ac, byId } = makeStubEnv();
  loadModule(win);
  RW.pipeMode = true;

  const downClientX = 400, downClientY = 300; // raw client coords (NOT container-relative)
  const curClientX = 700, curClientY = 300;
  ac._fire('mousedown', { clientX: downClientX, clientY: downClientY });
  ac._fire('mousemove', { clientX: curClientX, clientY: curClientY }); // distance 300 > 5 -> dragging

  const svg = byId['rw-pipe-preview'];
  ok(!!svg, 'G: preview SVG created while dragging');
  const html = svg.innerHTML;

  const lines = parseTags(html, 'line');
  ok(lines.length === 3, 'G: exactly 3 <line> elements (main + 2 ticks), got ' + lines.length);

  const expX1 = downClientX - CONTAINER_RECT.x, expY1 = downClientY - CONTAINER_RECT.y;
  const expX2 = curClientX - CONTAINER_RECT.x, expY2 = curClientY - CONTAINER_RECT.y;
  const main = lines[0];
  approx(+main.x1, expX1, 1e-6, 'G: main line x1 is container-relative, not raw clientX (regression test)');
  approx(+main.y1, expY1, 1e-6, 'G: main line y1 is container-relative, not raw clientY');
  approx(+main.x2, expX2, 1e-6, 'G: main line x2 is container-relative');
  approx(+main.y2, expY2, 1e-6, 'G: main line y2 is container-relative');

  // Main line is horizontal (y1===y2) -> ticks must be vertical (x1===x2), each 14px tall, centered on an endpoint.
  const [tick1, tick2] = [lines[1], lines[2]];
  for (const [tick, cx, cy] of [[tick1, expX1, expY1], [tick2, expX2, expY2]]){
    approx(+tick.x1, +tick.x2, 1e-6, 'G: tick is vertical (x1===x2) for a horizontal main line');
    approx(+tick.x1, cx, 1e-6, 'G: tick is centered on its endpoint x');
    approx(Math.abs(+tick.y1 - +tick.y2), 14, 1e-6, 'G: tick spans 14px (2*TICK)');
    approx((+tick.y1 + +tick.y2) / 2, cy, 1e-6, 'G: tick is centered on its endpoint y');
  }

  const rects = parseTags(html, 'rect');
  const texts = parseTextTags(html);
  ok(rects.length === 1, 'G: exactly one <rect> backdrop, got ' + rects.length);
  ok(texts.length === 1, 'G: exactly one <text> label, got ' + texts.length);

  const liveW = 300; // mask px === container px here since RW.W===cr.width
  const expectedLabel = RW._fmtWidth(liveW) + ' px';
  ok(texts[0].text === expectedLabel, 'G: label text is the formatted width (got "' + texts[0].text + '")');

  const midX = (expX1 + expX2) / 2, midY = (expY1 + expY2) / 2;
  // normal for a horizontal line, flipped to stay "above" (smaller y): (0,-1)
  approx(+texts[0].attrs.x, midX, 1e-6, 'G: label x at line midpoint (no perpendicular x-offset for a horizontal line)');
  approx(+texts[0].attrs.y, midY - 15, 1e-6, 'G: label y offset 15px above the midpoint');

  const rectCx = +rects[0].x + (+rects[0].width) / 2;
  const rectCy = +rects[0].y + (+rects[0].height) / 2;
  approx(rectCx, +texts[0].attrs.x, 1e-6, 'G: backdrop rect is horizontally centered on the label');
  approx(rectCy, +texts[0].attrs.y, 1e-6, 'G: backdrop rect is vertically centered on the label');
  ok(+rects[0].width >= expectedLabel.length * 7, 'G: backdrop is at least wide enough to enclose the label text');

  ok(!/NaN|undefined/.test(html), 'G: no NaN/undefined anywhere in the rendered markup');

  const status = byId['rw-commit-status'].innerText;
  ok(status === 'width: ' + RW._fmtWidth(liveW) + 'px (release to set)', 'G: status line unchanged (got "' + status + '")');
}

// Test H: a stale snap-hit marker from before the drag is cleared once dragging starts.
{
  const { win, RW, ac } = makeStubEnv();
  loadModule(win);
  RW.pipeMode = true;
  RW._pipeSnapHit = { x: 1, y: 1, nx: 0.1, ny: 0.1, inside: true, atEnd: false, src: 'network', ref: 0 };

  ac._fire('mousedown', { clientX: 400, clientY: 300 });
  ac._fire('mousemove', { clientX: 700, clientY: 300 });
  ok(RW._pipeSnapHit === null, 'H: a stale snap-hit marker is cleared once a width drag begins');
}

// Test I: after mouseup (drag release), the preview no longer contains the
// dimension line elements — nothing persists past the live drag.
{
  const { win, RW, ac, byId } = makeStubEnv();
  loadModule(win);
  RW.pipeMode = true;

  ac._fire('mousedown', { clientX: 400, clientY: 300 });
  ac._fire('mousemove', { clientX: 700, clientY: 300 });
  ac._fire('mouseup', { clientX: 700, clientY: 300 });

  approx(RW._pipeWidth, 300, 1e-6, 'I: RW._pipeWidth set from the completed drag');
  const svg = byId['rw-pipe-preview'];
  const html = svg ? svg.innerHTML : '';
  ok(!/<text/.test(html), 'I: no <text> survives after mouseup');
  ok(!/<rect/.test(html), 'I: no <rect> survives after mouseup');
}

// Test J: a plain hover (no drag in progress) never emits <text>/<rect> at all.
{
  const { win, RW, byId } = makeStubEnv();
  loadModule(win);
  RW.pipeMode = true;
  RW._renderPipePreview(500 + CONTAINER_RECT.x, 500 + CONTAINER_RECT.y);
  const svg = byId['rw-pipe-preview'];
  const html = svg ? svg.innerHTML : '';
  ok(!/<text/.test(html), 'J: idle/hover preview never emits <text>');
  ok(!/<rect/.test(html), 'J: idle/hover preview never emits <rect>');
}

// Test K: the pure dimensionLineSvg helper never produces NaN/undefined,
// even for a degenerate zero-length input (structurally unreachable via
// real drag events, since `dragging` only flips true past a 5px threshold,
// but the `|| 1` guard is real defensive code worth verifying directly).
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const degenerate = RW._pipeDimensionLineSvg(50, 50, 50, 50, '0 px');
  ok(!/NaN|undefined/.test(degenerate), 'K: degenerate zero-length input produces no NaN/undefined');
  ok(/<text/.test(degenerate) && /<rect/.test(degenerate), 'K: degenerate input still emits a label');

  const normal = RW._pipeDimensionLineSvg(0, 0, 100, 0, '12.34 px');
  ok(!/NaN|undefined/.test(normal), 'K: normal horizontal input produces no NaN/undefined');
}

/* ================= Pipe merge: pure-vector chain fast path ================= */

// Test L: RW._pipeResolveLinks, pure.
{
  const { win, RW } = makeStubEnv();
  loadModule(win);

  // L1/L2: ptsN matches RW._pipeDedupe; links matches the old flat filter+dedupe
  // logic exactly, across legacy bare integers, new {ref,targetEnd} objects, and
  // every invalid-value guard (null, negative, out-of-range, non-integer, dup).
  {
    const rawPts = [[0,0],[0.1,0],[0.2,0],[0.3,0],[0.3,0],[0.4,0],[0.5,0]];
    const pending = [3, {ref:1,targetEnd:'start'}, null, {ref:3,targetEnd:null}, -1, {ref:10,targetEnd:'end'}, {ref:'x'}];
    const info = RW._pipeResolveLinks(rawPts, pending, 5);
    const expectedPtsN = RW._pipeDedupe(rawPts);
    ok(JSON.stringify(info.ptsN) === JSON.stringify(expectedPtsN), 'L1: ptsN matches RW._pipeDedupe exactly');
    ok(JSON.stringify(info.links) === JSON.stringify([3,1]), 'L2: links matches old flat filter+dedupe (got ' + JSON.stringify(info.links) + ')');
  }

  // L3: link on the DROPPED duplicate last point still resolves to linkEnd.
  {
    const rawPts = [[0,0],[0.1,0],[0.1,0]]; // index2 is an exact duplicate of index1, gets dropped
    const pending = [null, null, {ref:5,targetEnd:'end'}];
    const info = RW._pipeResolveLinks(rawPts, pending, 10);
    ok(info.ptsN.length === 2, 'L3: dedupe dropped the duplicate last point');
    ok(info.linkEnd && info.linkEnd.ref === 5 && info.linkEnd.targetEnd === 'end',
      'L3: link on the dropped duplicate resolves to linkEnd (got ' + JSON.stringify(info.linkEnd) + ')');
  }
  // L3b: mirror — the KEPT point carries it, the duplicate carries null.
  {
    const rawPts = [[0,0],[0.1,0],[0.1,0]];
    const pending = [null, {ref:5,targetEnd:'end'}, null];
    const info = RW._pipeResolveLinks(rawPts, pending, 10);
    ok(info.linkEnd && info.linkEnd.ref === 5 && info.linkEnd.targetEnd === 'end',
      'L3b: link on the kept point resolves to linkEnd (got ' + JSON.stringify(info.linkEnd) + ')');
  }

  // L4: pick() tie-break prefers a targetEnd-bearing link over a mid-span one
  // landing in the same (last) bucket.
  {
    const rawPts = [[0,0],[0.1,0],[0.1,0],[0.1,0]]; // index2 AND index3 both dropped, both bucket 1
    const pending = [null, {ref:2,targetEnd:null}, null, {ref:5,targetEnd:'end'}];
    const info = RW._pipeResolveLinks(rawPts, pending, 10);
    ok(info.linkEnd && info.linkEnd.ref === 5 && info.linkEnd.targetEnd === 'end',
      'L4: pick() prefers the targetEnd-bearing link (got ' + JSON.stringify(info.linkEnd) + ')');
  }

  // L5: an interior-point link sets linkMid, while still appearing in links.
  {
    const rawPts = [[0,0],[0.2,0],[0.4,0]];
    const pending = [null, {ref:7,targetEnd:null}, null];
    const info = RW._pipeResolveLinks(rawPts, pending, 10);
    ok(info.linkMid === true, 'L5: interior-point link sets linkMid');
    ok(info.linkStart === null && info.linkEnd === null, 'L5: interior link does not populate linkStart/linkEnd');
    ok(info.links.indexOf(7) !== -1, 'L5: interior link still appears in the flat links array');
  }

  // L6: legacy bare-integer pending entries normalize without crashing.
  {
    const rawPts = [[0,0],[0.3,0]];
    const info = RW._pipeResolveLinks(rawPts, [2, null], 10);
    ok(info.linkStart && info.linkStart.ref === 2 && info.linkStart.targetEnd === null,
      'L6: legacy bare integer normalizes to {ref,targetEnd:null}');
  }
}

// Test M: RW._tryPipeSnap reports targetEnd correctly, including the
// last===0 two-point-candidate edge case where both branches are reachable.
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  RW._pipeNetwork = [ mkSeg(RW, [[0.2,0.2],[0.2,0.5]], 10) ];

  let p = RW._tryPipeSnap(0.2, 0.2); // exactly at the candidate's own start
  ok(RW._pipeSnapHit && RW._pipeSnapHit.targetEnd === 'start', 'M: hit at t=0,i=0 reports targetEnd start');

  p = RW._tryPipeSnap(0.2, 0.5); // exactly at the candidate's own end
  ok(RW._pipeSnapHit && RW._pipeSnapHit.targetEnd === 'end', 'M: hit at t=1,i=last reports targetEnd end');

  p = RW._tryPipeSnap(0.2, 0.35); // mid-span
  ok(RW._pipeSnapHit && RW._pipeSnapHit.targetEnd === null, 'M: a mid-span hit reports targetEnd null');
}

// Test N: 2-segment chain, the common case — exact expected geometry.
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10);
  const B = mkSeg(RW, [[0.1,0.4],[0.4,0.4]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} });
  const res = RW._pipeChainMerge([A,B], [0,1]);
  ok(!res.error, 'N: 2-segment chain qualifies (got error: ' + res.error + ')');
  ok(res.meta.method === 'chain', 'N: method is chain');
  ok(JSON.stringify(res.meta.segmentOrder) === JSON.stringify([0,1]), 'N: segmentOrder is [0,1] (got ' + JSON.stringify(res.meta.segmentOrder) + ')');
  ok(JSON.stringify(res.meta.reversed) === JSON.stringify([false,false]), 'N: neither segment reversed');
  const cl = RW._pipeCenterlineFromRibbon(res.poly);
  const expected = [[0.1,0.1],[0.1,0.4],[0.4,0.4]];
  ok(cl && cl.length === 3, 'N: recovered centerline has 3 points (got ' + (cl&&cl.length) + ')');
  if (cl && cl.length === 3){
    for (let i=0;i<3;i++){
      approx(cl[i][0], expected[i][0], 1e-4, 'N: centerline point '+i+' x');
      approx(cl[i][1], expected[i][1], 1e-4, 'N: centerline point '+i+' y');
    }
  }
}

// Test O: 3-segment chain built in NON-drawing-order (draw A, then B off A's
// end, then C off A's OTHER end/start) — proves the walk doesn't depend on
// draw/array order. Verified structurally (all 3 covered, correct total
// length, correct endpoint set) rather than a hardcoded order/reversed array,
// since either valid walk direction is an equally correct representation of
// the same physical path.
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = mkSeg(RW, [[0.3,0.3],[0.3,0.6]], 10);
  const B = mkSeg(RW, [[0.3,0.6],[0.6,0.6]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} });
  const C = mkSeg(RW, [[0.3,0.3],[0.0,0.3]], 10, { links:[0], linkStart:{ref:0,targetEnd:'start'} });
  const res = RW._pipeChainMerge([A,B,C], [0,1,2]);
  ok(!res.error, 'O: 3-segment out-of-order chain qualifies (got error: ' + res.error + ')');
  ok(res.meta.segmentOrder && res.meta.segmentOrder.length === 3
     && [0,1,2].every(i => res.meta.segmentOrder.indexOf(i) !== -1),
     'O: segmentOrder covers all 3 segments (got ' + JSON.stringify(res.meta && res.meta.segmentOrder) + ')');
  const cl = RW._pipeCenterlineFromRibbon(res.poly);
  ok(cl && cl.length === 4, 'O: recovered centerline has 4 points (3 segments, 2 shared joints) (got ' + (cl&&cl.length) + ')');
  // endpoint set: the two true free tips (B's far tip (0.6,0.6), C's far tip (0,0.3))
  // must both appear somewhere in the recovered centerline.
  const hasPoint = (pt) => cl.some(p => Math.hypot(p[0]-pt[0], p[1]-pt[1]) < 1e-4);
  ok(hasPoint([0.6,0.6]), 'O: recovered centerline includes B\'s free tip');
  ok(hasPoint([0.0,0.3]), 'O: recovered centerline includes C\'s free tip');
  // total path length equals the sum of the 3 segments' own lengths (mask-px)
  let totalLen = 0;
  for (let i=1;i<cl.length;i++) totalLen += Math.hypot((cl[i][0]-cl[i-1][0])*RW.W, (cl[i][1]-cl[i-1][1])*RW.H);
  approx(totalLen, 300+300+300, 1, 'O: total recovered path length equals sum of the 3 segment lengths');
}

// Test P: a segment linked at BOTH its own ends, bridging two others.
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = mkSeg(RW, [[0.0,0.2],[0.2,0.2]], 10);
  const B = mkSeg(RW, [[0.5,0.2],[0.7,0.2]], 10);
  const C = mkSeg(RW, [[0.2,0.2],[0.5,0.2]], 10, {
    links:[0,1], linkStart:{ref:0,targetEnd:'end'}, linkEnd:{ref:1,targetEnd:'start'}
  });
  const res = RW._pipeChainMerge([A,B,C], [0,1,2]);
  ok(!res.error, 'P: bridging segment qualifies (got error: ' + res.error + ')');
  const cl = RW._pipeCenterlineFromRibbon(res.poly);
  let totalLen = 0;
  for (let i=1;i<cl.length;i++) totalLen += Math.hypot((cl[i][0]-cl[i-1][0])*RW.W, (cl[i][1]-cl[i-1][1])*RW.H);
  approx(totalLen, 200+300+200, 1, 'P: total recovered length equals sum of all 3 segment lengths');
  const hasPoint = (pt) => cl.some(p => Math.hypot(p[0]-pt[0], p[1]-pt[1]) < 1e-4);
  ok(hasPoint([0.0,0.2]) && hasPoint([0.7,0.2]), 'P: recovered centerline includes both outer free tips');
}

// Test Q: reversed-orientation joins, exact expected point sequences.
{
  // start-to-start
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = mkSeg(RW, [[0.1,0.1],[0.1,0.3]], 10);
  const B = mkSeg(RW, [[0.1,0.1],[0.4,0.1]], 10, { links:[0], linkStart:{ref:0,targetEnd:'start'} });
  const res = RW._pipeChainMerge([A,B], [0,1]);
  ok(!res.error, 'Q: start-to-start join qualifies (got error: ' + res.error + ')');
  const cl = RW._pipeCenterlineFromRibbon(res.poly);
  const expected = [[0.1,0.3],[0.1,0.1],[0.4,0.1]]; // A reversed, then B forward
  ok(cl && cl.length === 3, 'Q: start-to-start recovered centerline has 3 points');
  if (cl && cl.length === 3) for (let i=0;i<3;i++){
    approx(cl[i][0], expected[i][0], 1e-4, 'Q: start-to-start point '+i+' x');
    approx(cl[i][1], expected[i][1], 1e-4, 'Q: start-to-start point '+i+' y');
  }
}
{
  // end-to-end
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = mkSeg(RW, [[0.1,0.1],[0.1,0.3]], 10);
  const B = mkSeg(RW, [[0.4,0.3],[0.1,0.3]], 10, { links:[0], linkEnd:{ref:0,targetEnd:'end'} });
  const res = RW._pipeChainMerge([A,B], [0,1]);
  ok(!res.error, 'Q: end-to-end join qualifies (got error: ' + res.error + ')');
  const cl = RW._pipeCenterlineFromRibbon(res.poly);
  const expected = [[0.1,0.1],[0.1,0.3],[0.4,0.3]]; // A forward, then B reversed
  ok(cl && cl.length === 3, 'Q: end-to-end recovered centerline has 3 points');
  if (cl && cl.length === 3) for (let i=0;i<3;i++){
    approx(cl[i][0], expected[i][0], 1e-4, 'Q: end-to-end point '+i+' x');
    approx(cl[i][1], expected[i][1], 1e-4, 'Q: end-to-end point '+i+' y');
  }
}

// Test R: a chain member with its own interior bend — proves recoverability
// survives bevel/miter points, not just plain 2-point segments.
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = mkSeg(RW, [[0.1,0.1],[0.1,0.3],[0.3,0.3]], 10); // A has a 90-degree bend
  const B = mkSeg(RW, [[0.3,0.3],[0.3,0.5]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} });
  const res = RW._pipeChainMerge([A,B], [0,1]);
  ok(!res.error, 'R: chain with an interior bend qualifies (got error: ' + res.error + ')');
  const cl = RW._pipeCenterlineFromRibbon(res.poly);
  ok(cl && cl.length === 4, 'R: recovered centerline keeps the interior bend vertex (got ' + (cl&&cl.length) + ')');
}

// Tests S*: disqualification — every case falls back to raster, never crashes.
// A shared spy replaces RW._pipeMergeGroup to prove the fallback dispatch
// itself, independent of raster geometry (already covered elsewhere).
function withRasterSpy(RW, fn){
  const calls = [];
  const orig = RW._pipeMergeGroup;
  RW._pipeMergeGroup = function(members){ calls.push(members); return {poly:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}], meta:{scale:1}}; };
  try { fn(calls); } finally { RW._pipeMergeGroup = orig; }
}

// S1: genuine mid-span tee
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = mkSeg(RW, [[0.1,0.1],[0.5,0.1]], 10);
  const B = mkSeg(RW, [[0.3,0.1],[0.3,0.4]], 10, { links:[0], linkStart:{ref:0,targetEnd:null} });
  withRasterSpy(RW, (calls) => {
    const res = RW._pipeMergeConnected([A,B], [0,1]);
    ok(res.meta.method === 'raster', 'S1: mid-span tee falls back to raster (got ' + JSON.stringify(res.meta) + ')');
    ok(calls.length === 1, 'S1: raster spy called exactly once');
    ok(res.meta.chainError === 'mid-span or interior link', 'S1: chainError explains why (got ' + res.meta.chainError + ')');
  });
}

// S2: width mismatch disqualifies; a matching-toFixed(2) control still chains
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = mkSeg(RW, [[0.1,0.1],[0.1,0.3]], 6.00);
  const B = mkSeg(RW, [[0.1,0.3],[0.4,0.3]], 8.00, { links:[0], linkStart:{ref:0,targetEnd:'end'} });
  const res = RW._pipeChainMerge([A,B], [0,1]);
  ok(res.error === 'mixed widths', 'S2: width mismatch disqualifies (got ' + res.error + ')');

  const A2 = mkSeg(RW, [[0.1,0.1],[0.1,0.3]], 6.001);
  const B2 = mkSeg(RW, [[0.1,0.3],[0.4,0.3]], 6.004, { links:[0], linkStart:{ref:0,targetEnd:'end'} });
  const res2 = RW._pipeChainMerge([A2,B2], [0,1]);
  ok(!res2.error, 'S2 control: widths matching at toFixed(2) precision still chains (got error: ' + res2.error + ')');
}

// S3: 3-way end junction (two segments both link to the SAME end of a third)
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = mkSeg(RW, [[0.1,0.1],[0.4,0.1]], 10);
  const B = mkSeg(RW, [[0.4,0.1],[0.4,0.4]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} });
  const C = mkSeg(RW, [[0.4,0.1],[0.7,0.4]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} });
  withRasterSpy(RW, (calls) => {
    const res = RW._pipeMergeConnected([A,B,C], [0,1,2]);
    ok(res.meta.chainError === '3+ segments meet at one end', 'S3: 3-way end junction disqualifies (got ' + res.meta.chainError + ')');
    ok(calls.length === 1, 'S3: raster spy called exactly once');
  });
}

// S4: an interior-vertex link (linkMid) disqualifies
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = mkSeg(RW, [[0.1,0.1],[0.5,0.1]], 10);
  const B = mkSeg(RW, [[0.3,0.1],[0.3,0.3],[0.6,0.3]], 10, { links:[0], linkMid:true });
  withRasterSpy(RW, (calls) => {
    const res = RW._pipeMergeConnected([A,B], [0,1]);
    ok(res.meta.chainError === 'link at an interior vertex', 'S4: interior-vertex link disqualifies (got ' + res.meta.chainError + ')');
    ok(calls.length === 1, 'S4: raster spy called exactly once');
  });
}

// S5: a closed loop (A-B-C-A) disqualifies and the walk terminates, never hangs
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = mkSeg(RW, [[0,0],[0.2,0]], 10, { links:[2], linkStart:{ref:2,targetEnd:'end'} });
  const B = mkSeg(RW, [[0.2,0],[0.2,0.2]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} });
  const C = mkSeg(RW, [[0.2,0.2],[0,0]], 10, { links:[1], linkStart:{ref:1,targetEnd:'end'} });
  const res = RW._pipeChainMerge([A,B,C], [0,1,2]);
  ok(res.error === 'not a simple path (cycle or split)', 'S5: closed loop disqualifies (got ' + res.error + ')');
}

// S6: legacy network entries missing the new fields entirely — old state still works
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  const A = { ptsN:[[0.1,0.1],[0.1,0.3]], widthPx:10, ribbon: RW._pipeRibbon([[0.1,0.1],[0.1,0.3]],10), links:[] };
  const B = { ptsN:[[0.1,0.3],[0.4,0.3]], widthPx:10, ribbon: RW._pipeRibbon([[0.1,0.3],[0.4,0.3]],10), links:[0] };
  withRasterSpy(RW, (calls) => {
    const res = RW._pipeMergeConnected([A,B], [0,1]);
    ok(res.meta.method === 'raster', 'S6: legacy entries without new fields fall back to raster, no exception');
    ok(calls.length === 1, 'S6: raster spy called exactly once');
  });
}

// Test T: both methods failing -> commitPipe falls through to per-segment staging.
{
  const { win, RW } = makeStubEnv();
  loadModule(win);
  RW.pipeMode = true;
  const A = mkSeg(RW, [[0.1,0.1],[0.5,0.1]], 10);
  const B = mkSeg(RW, [[0.3,0.1],[0.3,0.4]], 10, { links:[0], linkStart:{ref:0,targetEnd:null} }); // disqualifying mid-span tee
  RW._pipeNetwork = [A, B];
  RW._pipeMergeGroup = function(){ return {error:'forced raster failure', meta:{}}; };
  RW.commitPipe().then(() => {
    const as = RW._testAnnotationState;
    ok(as.annotations.length === 2, 'T: both methods failing stages each member individually (got ' + as.annotations.length + ')');
    ok(as.annotations.every(a => !a.notes), 'T: notes stays untouched (empty) on every individually-staged pipe');
    runRemainingPipeTests();
  });
}

function runRemainingPipeTests(){
  // Test U: notes stays untouched on commit, and a committed pipe is no
  // longer recognized as a snap candidate at all — `notes` is a real field
  // the host app displays in its own review UI, so this codebase no longer
  // writes anything into it, which means cross-session pipe snapping (via
  // scanning annotationState.annotations for a notes marker) is gone by
  // design; same-session branching via RW._pipeNetwork is unaffected.
  (async () => {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    RW.pipeMode = true;
    const A = mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10);
    const B = mkSeg(RW, [[0.1,0.4],[0.4,0.4]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} });
    RW._pipeNetwork = [A, B];
    await RW.commitPipe();
    const as = RW._testAnnotationState;
    ok(as.annotations.length === 1, 'U: chain commit stages exactly one annotation (got ' + as.annotations.length + ')');
    const a = as.annotations[0];
    ok(a && !a.notes, 'U: notes is left empty/untouched (got "' + (a && a.notes) + '")');

    // feed it back — no longer a snap candidate under any circumstance,
    // chain-merged or raster-merged alike, since nothing marks it as a pipe.
    RW._pipeNetwork = [];
    const cands = RW._pipeSnapCandidates();
    ok(cands.length === 0, 'U: a committed annotation is never a snap candidate anymore (got ' + cands.length + ')');

    runTraceEqualsCommit();
  })();
}

function runTraceEqualsCommit(){
  // Test V: Trace === Commit for the identical network state, and
  // RW._pipeGroups' own output is untouched by this change.
  (async () => {
    const { win, RW, byId } = makeStubEnv();
    loadModule(win);
    RW.pipeMode = true;
    const A  = mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10); // qualifying chain: A-B
    const B  = mkSeg(RW, [[0.1,0.4],[0.4,0.4]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} });
    const C  = mkSeg(RW, [[0.6,0.1],[0.9,0.1]], 10); // disqualifying tee group: C-D
    const D  = mkSeg(RW, [[0.75,0.1],[0.75,0.3]], 10, { links:[2], linkStart:{ref:2,targetEnd:null} });
    const E  = mkSeg(RW, [[0.1,0.6],[0.4,0.6]], 10); // singleton
    RW._pipeNetwork = [A,B,C,D,E];
    // Stub the raster path with a deterministic sentinel (rw_commit.js's real
    // tracer isn't loaded in this harness, and isn't what this test is about —
    // it only needs to prove Trace and Commit call the SAME dispatch/result).
    RW._pipeMergeGroup = function(){ return {poly:[{x:0.6,y:0.05},{x:0.95,y:0.05},{x:0.95,y:0.35},{x:0.6,y:0.35}], meta:{scale:1}}; };

    const groupsBefore = JSON.stringify(RW._pipeGroups(RW._pipeNetwork));

    RW._renderPipeTrace();
    const svg = byId['rw-pipe-preview'];
    const tracedPolys = parseTags(svg.innerHTML, 'polygon').map(a => a.points);

    await RW.commitPipe();
    const as = RW._testAnnotationState;
    const committedPolys = as.annotations.map(a => a.coordinates.map(p => (p.x*1000)+','+(p.y*1000)).join(' '));

    ok(tracedPolys.length === committedPolys.length,
      'V: Trace and Commit produce the same number of polygons (' + tracedPolys.length + ' vs ' + committedPolys.length + ')');
    let allMatch = tracedPolys.length === committedPolys.length;
    for (let i=0;i<tracedPolys.length && allMatch;i++){
      const tp = tracedPolys[i].split(' ').map(s=>{const [x,y]=s.split(',').map(Number); return Math.round(x)+','+Math.round(y);}).join(' ');
      const cp = committedPolys[i].split(' ').map(s=>{const [x,y]=s.split(',').map(Number); return Math.round(x)+','+Math.round(y);}).join(' ');
      if (tp !== cp) allMatch = false;
    }
    ok(allMatch, 'V: Trace and Commit polygons are identical, in order');

    const groupsAfter = JSON.stringify(RW._pipeGroups([A,B,C,D,E]));
    ok(groupsBefore === groupsAfter, 'V: RW._pipeGroups output is unaffected by this change');

    runEndToleranceTests();
  })();
}

// Tests W*: end-tolerance fix — a click near-but-not-past a segment's true
// endpoint (realistic click precision) must still register as an end hit,
// not silently fall back to "mid-span." Found live: a same-width, visually
// tip-to-tip connection was still routing through the raster path because
// the old test required the raw click to have literally overshot the true
// endpoint before the clamp engaged — unrealistic for real clicking.
function runEndToleranceTests(){
  // W1: a click ~3 mask-px short of the true end (catchPx defaults to 5 in
  // this harness's RW.W=1000) must still report targetEnd:'end', not null.
  {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    RW._pipeNetwork = [ mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10) ]; // mask-px (100,100)-(100,400)
    RW._tryPipeSnap(0.1, 0.397); // 3px short of the true end (100,400)
    ok(RW._pipeSnapHit && RW._pipeSnapHit.targetEnd === 'end',
      'W1: a click just short of the true end still reports targetEnd end (got ' + (RW._pipeSnapHit && RW._pipeSnapHit.targetEnd) + ')');
  }
  // W1b: same, at the true START.
  {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    RW._pipeNetwork = [ mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10) ];
    RW._tryPipeSnap(0.1, 0.103); // 3px short of the true start (100,100)
    ok(RW._pipeSnapHit && RW._pipeSnapHit.targetEnd === 'start',
      'W1b: a click just short of the true start still reports targetEnd start (got ' + (RW._pipeSnapHit && RW._pipeSnapHit.targetEnd) + ')');
  }

  // W2: a click genuinely far from either endpoint (mid-span) is UNAFFECTED
  // by the wider tolerance — still reports targetEnd null, not falsely 'end'.
  {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    RW._pipeNetwork = [ mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10) ];
    RW._tryPipeSnap(0.1, 0.25); // dead center of a 300px-long segment
    ok(RW._pipeSnapHit && RW._pipeSnapHit.targetEnd === null,
      'W2: a genuine mid-span click stays targetEnd null regardless of the wider tolerance');
  }

  // W3: just OUTSIDE the tolerance radius near the end still reports null
  // (the tolerance is bounded, not unlimited).
  {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    RW._pipeNetwork = [ mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10) ];
    RW._tryPipeSnap(0.1, 0.38); // 20px short of the true end — outside catchPx(5)
    ok(RW._pipeSnapHit && RW._pipeSnapHit.targetEnd === null,
      'W3: a click well outside the tolerance radius stays targetEnd null (got ' + (RW._pipeSnapHit && RW._pipeSnapHit.targetEnd) + ')');
  }

  // W4: end-to-end integration — the exact reported scenario. Two same-width
  // segments connected via a real DOM click landing just short of the first
  // segment's true tip must now qualify for the vector-chain fast path,
  // where before this fix it silently fell back to the raster path.
  (async () => {
    const { win, RW, ac } = makeStubEnv();
    loadModule(win);
    RW.pipeMode = true;
    RW._pipeWidth = 10;
    RW._pipeNetwork = [ mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10) ]; // segment 0, true end at (100,400)

    // click just short of segment 0's true end to start the new path
    let clientX = 100 + CONTAINER_RECT.x, clientY = 397 + CONTAINER_RECT.y;
    ac._fire('mousedown', { clientX, clientY });
    ac._fire('mouseup', { clientX, clientY });
    ok(RW._pipePendingLinks[0] && RW._pipePendingLinks[0].targetEnd === 'end',
      'W4: real click just short of the tip records targetEnd end (got ' + JSON.stringify(RW._pipePendingLinks[0]) + ')');

    clientX = 400 + CONTAINER_RECT.x; clientY = 400 + CONTAINER_RECT.y;
    ac._fire('mousedown', { clientX, clientY });
    ac._fire('mouseup', { clientX, clientY });
    RW._pipeFinishPath();

    ok(RW._pipeNetwork.length === 2, 'W4: second segment finished into the network');
    const res = RW._pipeMergeConnected(RW._pipeNetwork, [0,1]);
    ok(res.poly && res.meta && res.meta.method === 'chain',
      'W4: same-width, realistically-clicked tip connection now qualifies for the vector-chain path (got ' + JSON.stringify(res.meta || res.error) + ')');

    runRasterEpsTests();
  })();
}

/* ================= Raster-merge eps scaling fix ================= */
// Live-found: a genuine mid-span tee still committed with hundreds of
// unexplained points on nominally straight sections. Root cause: eps was a
// flat 0.8 local-raster-px constant, but a small, tightly-bounded merge's
// internal resolution (`scale`) climbs toward RW._pipeMergeRes, and each
// raster px represents a proportionally SMALLER real-world (mask-px)
// distance at higher scale — so the same flat eps quietly became too tight
// to absorb the raster's own pixel staircase. Fix: eps now scales WITH
// `scale` (RW._pipeMergeEpsMaskPx * scale), keeping a constant real-world
// tolerance regardless of merge resolution.
function runRasterEpsTests(){
  // X1: a small, tightly-bounded diagonal main + genuine mid-span tee forces
  // scale to the RW._pipeMergeRes cap (4) — the exact regime the live bug
  // occurred in. The default (scale-aware) eps must simplify to a small
  // point count; reverting to the OLD flat-eps-equivalent (by setting
  // RW._pipeMergeEpsMaskPx artificially low) must reproduce the old bug —
  // proving scale-awareness, not something else, is what fixes it.
  {
    const { win, RW } = makeStubEnv();
    loadModuleWithCommit(win);
    const main = mkSeg(RW, [[2280/RW.W,2830/RW.H],[2550/RW.W,2270/RW.H]], 10.71);
    const branch = mkSeg(RW, [[2428/RW.W,2522/RW.H],[2700/RW.W,2470/RW.H]], 6.69,
      { links:[0], linkStart:{ref:0,targetEnd:null} }); // mid-span tee -> forces the raster path

    const resDefault = RW._pipeMergeGroup([main, branch]);
    ok(!resDefault.error, 'X1: high-scale tee merges successfully (got error: ' + resDefault.error + ')');
    ok(resDefault.meta.scale === RW._pipeMergeRes, 'X1: this network genuinely hits the resolution cap (scale=' + (resDefault.meta&&resDefault.meta.scale) + ')');
    ok(resDefault.poly.length <= 16, 'X1: default scale-aware eps simplifies to a small point count (got ' + resDefault.poly.length + ')');

    RW._pipeMergeEpsMaskPx = 0.2; // at scale=4 this reproduces the OLD flat eps=0.8 exactly
    const resOld = RW._pipeMergeGroup([main, branch]);
    ok(resOld.poly.length >= 25, 'X1: the old flat-eps-equivalent leaves many more points (got ' + resOld.poly.length + '), proving scale-awareness is what fixes it');
  }

  // X2: the same fix must not regress the LOW-scale regime (a large network
  // forced toward scale's floor of 1) — point count should stay small there too.
  {
    const { win, RW } = makeStubEnv();
    loadModuleWithCommit(win);
    const main = mkSeg(RW, [[100/RW.W,100/RW.H],[3300/RW.W,3400/RW.H]], 10.71);
    const branch = mkSeg(RW, [[1700/RW.W,1750/RW.H],[2600/RW.W,1300/RW.H]], 6.69,
      { links:[0], linkStart:{ref:0,targetEnd:null} });
    const res = RW._pipeMergeGroup([main, branch]);
    ok(!res.error, 'X2: low-scale tee merges successfully (got error: ' + res.error + ')');
    ok(res.meta.scale < RW._pipeMergeRes, 'X2: this network is genuinely in the low-scale (budget-limited) regime (scale=' + (res.meta&&res.meta.scale) + ')');
    ok(res.poly.length <= 20, 'X2: low-scale regime stays clean too (got ' + res.poly.length + ' points)');
  }

  // X3: the actual live-found real-world ring (extracted from a real
  // committed annotation via annotationState.annotations, per the project's
  // established coordinate-extraction workflow) — a direct, permanent proof
  // that RW._simplifyRing, given an appropriately-scaled tolerance, collapses
  // the real staircase noise cleanly (567 -> a handful of points) without
  // materially changing the shape's own area. This doesn't replay the exact
  // original merge (the original segments/scale aren't recoverable from the
  // committed polygon alone), but pins the core mechanism directly against
  // real, not synthetic, geometry.
  {
    const { win, RW } = makeStubEnv();
    loadModuleWithCommit(win);
    const realRing = REAL_LIVE_FOUND_RING;
    ok(realRing.length === 567, 'X3: real ring fixture loaded intact (got ' + realRing.length + ' points)');

    function shoelace(ring){
      let a = 0;
      for (let i=0;i<ring.length;i++){ const [x1,y1]=ring[i], [x2,y2]=ring[(i+1)%ring.length]; a += x1*y2 - x2*y1; }
      return Math.abs(a)/2;
    }
    const areaOrig = shoelace(realRing);
    const simplified = RW._simplifyRing(realRing, 0.0001);
    const areaSimp = shoelace(simplified);
    ok(simplified.length <= 15, 'X3: the real live-found ring simplifies to a small point count at a realistic tolerance (got ' + simplified.length + ', was 567)');
    ok(Math.abs(areaSimp - areaOrig) / areaOrig < 0.01, 'X3: simplification changes the real shape\'s area by under 1% (got ' + ((areaSimp-areaOrig)/areaOrig*100).toFixed(3) + '%)');
    // and confirm the ORIGINAL flat eps=0.8, reinterpreted directly in these
    // same (much finer) normalized units, is nowhere near enough
    const barelySimplified = RW._simplifyRing(realRing, 0.00005);
    ok(barelySimplified.length > 300, 'X3: a too-tight tolerance leaves hundreds of points, matching what was actually observed (got ' + barelySimplified.length + ')');
  }

  runAnchorAndDragTests();
  runSnapRailsTests();
}

/* ================= Edge-anchored tracing (Feature B) ================= */
function runAnchorAndDragTests(){
  // Y1: RW._pipeAnchorOffsets sums to width for every anchor, and 'center'
  // (or omitted) is byte-identical to today's original half/half behavior.
  {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    for (const anchor of ['center','edgeA','edgeB',undefined]){
      const [offL,offR] = RW._pipeAnchorOffsets(20, anchor);
      approx(offL+offR, 20, 1e-9, 'Y1: offL+offR===width for anchor='+anchor);
    }
    const pts = [[0.1,0.1],[0.1,0.4],[0.4,0.4]];
    const a = JSON.stringify(RW._pipeRibbon(pts, 10));
    const b = JSON.stringify(RW._pipeRibbon(pts, 10, 'center'));
    ok(a === b, 'Y1: omitted anchor is byte-identical to explicit \'center\'');
  }

  // Y2/Y3: edge-anchored ribbons still let the REAL, unmodified
  // RW._pipeCenterlineFromRibbon recover the true geometric center — proven
  // by cross-checking against the 'center' ribbon's own rails (built from
  // the exact same per-vertex direction data, at width/2): edgeA (offR=0,
  // offL=width) recovers click+dir*(width/2), matching the LEFT rail;
  // edgeB (offL=0, offR=width) recovers click-dir*(width/2), matching the
  // RIGHT rail — at a straight run, a 90 degree miter bend, and a near-180
  // degree bevel join.
  function checkEdgeRecovery(RW, pts, width, label){
    const centerRibbon = RW._pipeRibbon(pts, width, 'center');
    const k = centerRibbon.length/2;
    const rails = {
      edgeA: centerRibbon.slice(0,k),                 // left rail, original order
      edgeB: centerRibbon.slice(k).reverse()           // right rail, original order (center = left.concat(right.reverse()))
    };

    for (const anchor of ['edgeA','edgeB']){
      const edgeRibbon = RW._pipeRibbon(pts, width, anchor);
      const recovered = RW._pipeCenterlineFromRibbon(edgeRibbon);
      const expected = rails[anchor];
      ok(recovered && recovered.length === k, label+' ('+anchor+'): recovered centerline has the right point count (got '+(recovered&&recovered.length)+', want '+k+')');
      if (recovered && recovered.length === k){
        let maxErr = 0;
        for (let i=0;i<k;i++) maxErr = Math.max(maxErr, Math.hypot(recovered[i][0]-expected[i].x, recovered[i][1]-expected[i].y));
        ok(maxErr < 1e-6, label+' ('+anchor+'): recovered centerline matches the true geometric center (max err '+maxErr+')');
      }
    }
  }
  {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    checkEdgeRecovery(RW, [[0.1,0.1],[0.1,0.4]], 20, 'Y2: straight run');
    checkEdgeRecovery(RW, [[0.0,0.0],[0.1,0.0],[0.1,0.1]], 20, 'Y3: 90-degree miter bend');
    checkEdgeRecovery(RW, [[0.0,0.0],[0.1,0.0],[0.101,0.001]], 20, 'Y3b: near-180-degree bevel join');
  }

  // Y4: RW._pipeChainMerge requires uniform anchor across a chain, exactly
  // like it already requires uniform width.
  {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    const A = mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10, { }); A.anchor = 'center';
    const B = mkSeg(RW, [[0.1,0.4],[0.4,0.4]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} }); B.anchor = 'edgeA';
    const res = RW._pipeChainMerge([A,B],[0,1]);
    ok(res.error === 'mixed anchors', 'Y4: mismatched anchors disqualify the chain (got ' + res.error + ')');

    B.anchor = 'center';
    const res2 = RW._pipeChainMerge([A,B],[0,1]);
    ok(!res2.error, 'Y4: matching anchors still chain (got error: ' + res2.error + ')');
    ok(res2.meta.anchor === 'center', 'Y4: meta records the shared anchor');
  }

  /* ================= Draggable free endpoints (Feature A) ================= */

  // Y5: RW._pipeEndpointIsFree — a genuinely free end, a segment's own
  // linked end, and the two-directional case: an EARLIER segment's end that
  // a LATER segment links onto (no reciprocal field on the earlier one).
  {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    RW._pipeNetwork = [
      mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10), // segment 0: both ends currently free
      mkSeg(RW, [[0.1,0.4],[0.4,0.4]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} }) // segment 1: own start links to 0's end
    ];
    ok(RW._pipeEndpointIsFree(0,'start') === true, 'Y5: segment 0 start is genuinely free');
    ok(RW._pipeEndpointIsFree(0,'end') === false, 'Y5: segment 0 end is a joint (a LATER segment links onto it, no reciprocal field on 0 itself)');
    ok(RW._pipeEndpointIsFree(1,'start') === false, 'Y5: segment 1 start is a joint (it recorded the link itself)');
    ok(RW._pipeEndpointIsFree(1,'end') === true, 'Y5: segment 1 end is genuinely free');
  }

  // Y6: DOM-driven drag on a free end updates that segment's ptsN/ribbon
  // live and leaves every OTHER segment untouched.
  {
    const { win, RW, ac } = makeStubEnv();
    loadModule(win);
    RW.pipeMode = true;
    const untouchedPts = [[0.6,0.6],[0.6,0.8]];
    RW._pipeNetwork = [
      mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10), // segment 0: end (0.1,0.4) is free -> draggable
      mkSeg(RW, untouchedPts.map(p=>p.slice()), 10) // segment 1: untouched control
    ];
    const [hx,hy] = RW._toPx(0.1,0.4); // segment 0's free end, in container px
    const clientX = hx + CONTAINER_RECT.x, clientY = hy + CONTAINER_RECT.y;
    ac._fire('mousedown', { clientX, clientY });
    ok(RW._pipeDragHandle === null, 'Y6: drag handle not armed yet on plain mousedown (only a real drag arms it)');
    const clientX2 = clientX + 40, clientY2 = clientY + 40; // > 5px away -> a real drag
    ac._fire('mousemove', { clientX: clientX2, clientY: clientY2 });
    ok(RW._pipeDragHandle && RW._pipeDragHandle.segIdx === 0 && RW._pipeDragHandle.end === 'end',
      'Y6: a real drag starting on the free end arms the handle (got ' + JSON.stringify(RW._pipeDragHandle) + ')');
    const moved = RW._pipeNetwork[0].ptsN[1];
    ok(Math.abs(moved[0]-0.1) > 1e-6 || Math.abs(moved[1]-0.4) > 1e-6, 'Y6: the dragged endpoint actually moved');
    ok(RW._pipeNetwork[0].ribbon && RW._pipeNetwork[0].ribbon.length >= 4, 'Y6: the dragged segment\'s ribbon was rebuilt');
    ok(JSON.stringify(RW._pipeNetwork[1].ptsN) === JSON.stringify(untouchedPts), 'Y6: the OTHER segment is completely untouched');
    ac._fire('mouseup', { clientX: clientX2, clientY: clientY2 });
    ok(RW._pipeDragHandle === null, 'Y6: mouseup clears the drag handle');
  }

  // Y7: a plain click (no real drag) on a free end falls through to the
  // existing click-to-place behavior unchanged, rather than starting a drag.
  {
    const { win, RW, ac } = makeStubEnv();
    loadModule(win);
    RW.pipeMode = true;
    RW._pipeNetwork = [ mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10) ];
    const [hx,hy] = RW._toPx(0.1,0.4);
    const clientX = hx + CONTAINER_RECT.x, clientY = hy + CONTAINER_RECT.y;
    ac._fire('mousedown', { clientX, clientY });
    ac._fire('mouseup', { clientX, clientY }); // no movement -> a plain click
    ok(RW._pipeDragHandle === null, 'Y7: a plain click near a free end never arms a drag handle');
    ok(RW._pipePts.length === 1, 'Y7: the plain click still places a new path point (existing behavior preserved)');
    ok(RW._pipePendingLinks[0] && RW._pipePendingLinks[0].ref === 0 && RW._pipePendingLinks[0].targetEnd === 'end',
      'Y7: it still snaps onto that same tip as a new branch, exactly as before this feature existed');
  }

  // Y8: a drag starting near a JOINT endpoint (already linked) never arms a
  // drag handle at all — it's not even offered as a candidate.
  {
    const { win, RW, ac } = makeStubEnv();
    loadModule(win);
    RW.pipeMode = true;
    RW._pipeNetwork = [
      mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10),
      mkSeg(RW, [[0.1,0.4],[0.4,0.4]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} })
    ];
    const [hx,hy] = RW._toPx(0.1,0.4); // the joint shared by both segments
    const clientX = hx + CONTAINER_RECT.x, clientY = hy + CONTAINER_RECT.y;
    ac._fire('mousedown', { clientX, clientY });
    ac._fire('mousemove', { clientX: clientX+40, clientY: clientY+40 });
    ok(RW._pipeDragHandle === null, 'Y8: a drag starting on a joint never arms a drag handle');
    ok(dragging_was_used_for_width_measure_or_click(RW), 'Y8: falls through to ordinary drag (width-measure) or click behavior instead');
  }
  function dragging_was_used_for_width_measure_or_click(RW){
    // Either the width-measure drag path engaged (RW._pipeWidth may have
    // changed) or a plain point got placed — either way, no crash, and the
    // network segments are untouched other than possibly RW._pipeWidth.
    return RW._pipeNetwork.length === 2
      && JSON.stringify(RW._pipeNetwork[0].ptsN) === JSON.stringify([[0.1,0.1],[0.1,0.4]])
      && JSON.stringify(RW._pipeNetwork[1].ptsN) === JSON.stringify([[0.1,0.4],[0.4,0.4]]);
  }

  // Y9: dragging too close to the segment's own neighboring point is
  // refused — no collapse to a degenerate (near-zero-length) segment.
  {
    const { win, RW, ac } = makeStubEnv();
    loadModule(win);
    RW.pipeMode = true;
    RW._pipeNetwork = [ mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10) ];
    const [hx,hy] = RW._toPx(0.1,0.4);
    const clientX = hx + CONTAINER_RECT.x, clientY = hy + CONTAINER_RECT.y;
    ac._fire('mousedown', { clientX, clientY });
    ac._fire('mousemove', { clientX: clientX+40, clientY: clientY+40 }); // arm the drag
    // now drag it almost on top of its own neighbor point (0.1,0.1)
    const [nx,ny] = RW._toPx(0.1,0.1);
    ac._fire('mousemove', { clientX: nx + CONTAINER_RECT.x, clientY: ny + CONTAINER_RECT.y });
    const pt = RW._pipeNetwork[0].ptsN[1];
    ok(Math.hypot((pt[0]-0.1)*RW.W, (pt[1]-0.1)*RW.H) > 1, 'Y9: refuses to collapse the segment onto its own neighbor point');
  }
}

/* ================= Snap candidates offer all 3 rails (Feature C) ================= */
function runSnapRailsTests(){
  // Z1: RW._pipeSnapCandidates() offers center/left/right for an uncommitted
  // network segment, regardless of what anchor it was actually drawn with —
  // previously an uncommitted segment only ever offered its raw ptsN (the
  // centerline for a center anchor, but an EDGE for an edge anchor).
  {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    RW._pipeNetwork = [ mkSeg(RW, [[0.1,0.1],[0.1,0.4],[0.4,0.4]], 20) ];
    const cands = RW._pipeSnapCandidates().filter(c => c.src === 'network' && c.ref === 0);
    const rails = cands.map(c => c.rail).sort();
    ok(JSON.stringify(rails) === JSON.stringify(['center','left','right']),
      'Z1: a network segment offers exactly center/left/right (got ' + JSON.stringify(rails) + ')');
  }

  // Z2: an already-committed pipe-tagged annotation offers NO rails at all —
  // notes is never written on commit anymore (it's a real field the host app
  // displays in its own review UI), so there's nothing left to scan
  // annotationState.annotations for; cross-session pipe snapping is gone.
  {
    const { win: w0, RW: RW0 } = makeStubEnv();
    loadModule(w0);
    const ribbon = RW0._pipeRibbon([[0.1,0.1],[0.1,0.4]], 20);

    const { win, RW } = makeStubEnv();
    const as = { annotations: [{ id: 'A1', coordinates: ribbon, notes: 'pipe width: 20.00 px' }] };
    loadModule(win, { annotationState: as });
    const cands = RW._pipeSnapCandidates().filter(c => c.src === 'annotation' && c.ref === 'A1');
    ok(cands.length === 0, 'Z2: a committed annotation offers no rails at all (got ' + cands.length + ')');
  }

  // Z3: the actual reported bug — an uncommitted EDGE-anchored segment now
  // lets a click near the pipe's TRUE CENTER snap to the center rail, not
  // just the raw edge it was originally drawn along.
  {
    const { win, RW, ac } = makeStubEnv();
    loadModule(win);
    RW.pipeMode = true;
    // anchor:'edgeA' means offL=width, offR=0 — the click points ARE the
    // right rail, and the true center sits offL/2 further toward the left
    // (perp=[-1,0] for this vertical segment, so "left" is -x).
    const ptsEdge = [[0.1,0.1],[0.1,0.4]];
    const seg = mkSeg(RW, ptsEdge, 20);
    seg.anchor = 'edgeA';
    seg.ribbon = RW._pipeRibbon(ptsEdge, 20, 'edgeA');
    RW._pipeNetwork = [ seg ];
    const trueCenterX = 0.1 - 10/RW.W;
    const hit = RW._tryPipeSnap(trueCenterX, 0.25);
    approx(hit[0]*RW.W, trueCenterX*RW.W, 0.5, 'Z3: a click at the pipe\'s true center snaps onto the center rail, not the raw drawn edge (got x=' + hit[0] + ', want ' + trueCenterX + ')');
  }

  // Z4: targetEnd correctly identifies the pipe's real start/end regardless
  // of which rail was actually hit (rank/position is computed per-candidate,
  // not tied to one specific curve).
  {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    RW.pipeMode = true;
    RW._pipeNetwork = [ mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 20) ];
    const rails = RW._pipeSnapCandidates().filter(c => c.ref === 0);
    for (const c of rails){
      const [ex,ey] = c.ptsN[0]; // this rail's own start point
      RW._tryPipeSnap(ex, ey);
      ok(RW._pipeSnapHit && RW._pipeSnapHit.targetEnd === 'start',
        'Z4: hitting the ' + c.rail + ' rail at its own start point reports targetEnd=start (got ' + (RW._pipeSnapHit && RW._pipeSnapHit.targetEnd) + ')');
    }
  }

  // Z5: unaffected regression — a click landing exactly on a CENTER-anchored
  // pipe's own centerline still snaps to that centerline (the center rail
  // ties for closest and wins), matching pre-fix behavior exactly.
  {
    const { win, RW } = makeStubEnv();
    loadModule(win);
    RW.pipeMode = true;
    RW._pipeNetwork = [ mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 20) ];
    const hit = RW._tryPipeSnap(0.1, 0.25);
    approx(hit[0]*RW.W, 0.1*RW.W, 1e-6, 'Z5: a click on a center-anchored pipe\'s own centerline still snaps to x=0.1 unchanged');
  }

  runGapBridgeTests();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

// A tee attaching to a pipe at an angle leaves its own flat ribbon cap
// mismatched with the target's local direction — rasterizing the two
// ribbons as-is can leave a small wedge covered by neither, worse for a
// shallow approach angle or an edge-rail (rather than centerline) join.
// RW._pipeExtendRibbonForMerge closes it by extending the tee-linked end
// far enough (scaled by 1/sin(angle), bounded by RW._pipeGapSinFloor) to
// genuinely cross the target's full width before rasterizing.
function runGapBridgeTests(){
  function pointInPoly(pt, poly){
    let inside = false;
    for (let i=0, j=poly.length-1; i<poly.length; j=i++){
      const xi=poly[i].x, yi=poly[i].y, xj=poly[j].x, yj=poly[j].y;
      const hit = ((yi>pt[1]) !== (yj>pt[1])) && (pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi)+xi);
      if (hit) inside = !inside;
    }
    return inside;
  }

  // BB1: a shallow-angle tee onto a main pipe's edge leaves a real gap
  // without the fix, and closes it with the fix — proven with a concrete
  // probe point known (via direct grid search against the real shipped
  // functions) to sit inside the notch: excluded from the un-bridged
  // merge, included once bridging runs.
  {
    const { win, RW } = makeStubEnv();
    loadModuleWithCommit(win);
    const W = RW.W, H = RW.H;
    const main = mkSeg(RW, [[100/W,300/H],[600/W,300/H]], 20);
    const branch = mkSeg(RW, [[300/W,290/H],[700/W,220/H]], 10, { links:[0], linkStart:{ref:0,targetEnd:null} });
    RW._pipeNetwork = [main, branch];
    const probe = [0.296, 0.2859]; // inside the notch, found via grid search

    const origExt = RW._pipeExtendRibbonForMerge;
    RW._pipeExtendRibbonForMerge = function(seg){ return seg.ribbon; }; // simulate pre-fix behavior
    const before = RW._pipeMergeGroup([main, branch]);
    RW._pipeExtendRibbonForMerge = origExt;
    const after = RW._pipeMergeGroup([main, branch]);

    ok(!before.error && !after.error, 'BB1: both merges succeed (before error: ' + before.error + ', after error: ' + after.error + ')');
    ok(!pointInPoly(probe, before.poly), 'BB1: the probe point is genuinely excluded without bridging (real gap reproduced)');
    ok(pointInPoly(probe, after.poly), 'BB1: the same probe point is included once RW._pipeExtendRibbonForMerge runs (gap bridged)');
    ok(after.meta.pixels > before.meta.pixels, 'BB1: bridging strictly increases the rasterized area (before=' + before.meta.pixels + ', after=' + after.meta.pixels + ')');
  }

  // BB2: defensive fallback — an unresolvable target ref (RW._pipeNetwork
  // doesn't contain it) never throws, and leaves the ribbon unchanged.
  {
    const { win, RW } = makeStubEnv();
    loadModuleWithCommit(win);
    const seg = mkSeg(RW, [[0.3,0.3],[0.5,0.1]], 10, { links:[99], linkStart:{ref:99,targetEnd:null} });
    RW._pipeNetwork = [seg]; // ref 99 doesn't exist
    let ribbon;
    ok((() => { ribbon = RW._pipeExtendRibbonForMerge(seg); return true; })(), 'BB2: an unresolvable target ref does not throw');
    ok(JSON.stringify(ribbon) === JSON.stringify(seg.ribbon), 'BB2: falls back to the unmodified ribbon when the target cannot be resolved');
  }

  // BB3: a genuinely free segment (no linkStart/linkEnd at all) is never
  // touched by the extension helper — byte-identical ribbon back.
  {
    const { win, RW } = makeStubEnv();
    loadModuleWithCommit(win);
    const seg = mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10);
    RW._pipeNetwork = [seg];
    const ribbon = RW._pipeExtendRibbonForMerge(seg);
    ok(ribbon === seg.ribbon, 'BB3: a free segment\'s ribbon is returned by reference, completely untouched');
  }

  // BB4: an end-to-end link (targetEnd 'start'/'end', not a mid-span tee)
  // is left alone by the extension helper — that geometry is handled by
  // the vector chain-merge path (or an unmodified raster fallback), not
  // this tee-specific bridging.
  {
    const { win, RW } = makeStubEnv();
    loadModuleWithCommit(win);
    const main = mkSeg(RW, [[0.1,0.1],[0.1,0.4]], 10);
    const branch = mkSeg(RW, [[0.1,0.4],[0.4,0.4]], 10, { links:[0], linkStart:{ref:0,targetEnd:'end'} });
    RW._pipeNetwork = [main, branch];
    const ribbon = RW._pipeExtendRibbonForMerge(branch);
    ok(ribbon === branch.ribbon, 'BB4: an end-to-end (not mid-span) link is left completely unmodified');
  }
}

// The exact ring from the live-found bug report (annotationState.annotations,
// notes: 'pipe run: 2 segments merged, ...'), extracted via the project's own
// coordinate-extraction console workflow. 567 points; see the header comment
// on runRasterEpsTests for what this proves.
const REAL_LIVE_FOUND_RING = [[0.506359,0.624803],[0.509156,0.625253],[0.508851,0.629259],[0.508786,0.629394],[0.508786,0.630069],[0.508722,0.630204],[0.508722,0.630879],[0.508658,0.631014],[0.508658,0.631689],[0.508593,0.631824],[0.508593,0.6325],[0.508529,0.632635],[0.508529,0.63331],[0.508465,0.633445],[0.508465,0.63412],[0.508401,0.634255],[0.508401,0.63493],[0.508336,0.635065],[0.508336,0.635741],[0.508272,0.635876],[0.508272,0.636551],[0.508208,0.636686],[0.508208,0.637361],[0.508143,0.637496],[0.508143,0.638171],[0.508079,0.638306],[0.508079,0.638982],[0.508015,0.639116],[0.508015,0.639792],[0.50795,0.639927],[0.50795,0.640602],[0.507886,0.640737],[0.507886,0.641412],[0.507822,0.641547],[0.507822,0.642222],[0.507758,0.642357],[0.507758,0.643033],[0.507693,0.643168],[0.507693,0.643843],[0.507629,0.643978],[0.507629,0.644653],[0.507565,0.644788],[0.507565,0.645463],[0.5075,0.645598],[0.5075,0.646274],[0.507436,0.646409],[0.507436,0.647084],[0.507372,0.647219],[0.507372,0.647894],[0.507307,0.648029],[0.507307,0.648704],[0.507243,0.648839],[0.507243,0.649514],[0.507179,0.649649],[0.507179,0.650325],[0.507115,0.65046],[0.507115,0.651135],[0.50705,0.65127],[0.50705,0.651945],[0.506986,0.65208],[0.506986,0.652755],[0.506922,0.65289],[0.506922,0.653566],[0.506857,0.653701],[0.506857,0.654376],[0.506793,0.654511],[0.506793,0.655186],[0.506729,0.655321],[0.506729,0.655996],[0.506664,0.656131],[0.506664,0.656806],[0.5066,0.656941],[0.5066,0.657617],[0.506536,0.657752],[0.506536,0.658427],[0.506472,0.658562],[0.506472,0.659237],[0.506407,0.659372],[0.506407,0.660047],[0.506343,0.660182],[0.506343,0.660858],[0.506279,0.660993],[0.506279,0.661668],[0.506214,0.661803],[0.506214,0.662478],[0.50615,0.662613],[0.50615,0.663288],[0.506086,0.663423],[0.506086,0.664099],[0.506021,0.664234],[0.506021,0.664909],[0.505957,0.665044],[0.505957,0.665719],[0.505893,0.665854],[0.505893,0.666529],[0.505829,0.666664],[0.505829,0.667339],[0.505764,0.667474],[0.505764,0.66815],[0.5057,0.668285],[0.5057,0.66896],[0.505636,0.669095],[0.505636,0.66977],[0.505571,0.669905],[0.505571,0.67058],[0.505507,0.670715],[0.505507,0.671391],[0.505443,0.671526],[0.505443,0.672201],[0.505378,0.672336],[0.505378,0.673011],[0.505314,0.673146],[0.505314,0.673821],[0.50525,0.673956],[0.505298,0.674361],[0.508577,0.674744],[0.509317,0.674924],[0.509928,0.674924],[0.510667,0.675104],[0.511278,0.675104],[0.512017,0.675284],[0.512628,0.675284],[0.513368,0.675464],[0.513979,0.675464],[0.514718,0.675644],[0.515329,0.675644],[0.516068,0.675824],[0.516679,0.675824],[0.518062,0.676094],[0.518673,0.676094],[0.519412,0.676274],[0.520023,0.676274],[0.520762,0.676454],[0.521373,0.676454],[0.522113,0.676635],[0.522723,0.676635],[0.523463,0.676815],[0.524074,0.676815],[0.524813,0.676995],[0.525424,0.676995],[0.525521,0.677085],[0.527417,0.677265],[0.528157,0.677445],[0.528768,0.677445],[0.529507,0.677625],[0.530118,0.677625],[0.530858,0.677805],[0.531468,0.677805],[0.532208,0.677985],[0.532819,0.677985],[0.533558,0.678165],[0.534169,0.678165],[0.534908,0.678345],[0.535519,0.678345],[0.535616,0.678435],[0.538863,0.678795],[0.539602,0.678975],[0.540213,0.678975],[0.540953,0.679155],[0.541563,0.679155],[0.542303,0.679335],[0.542914,0.679335],[0.543653,0.679515],[0.544264,0.679515],[0.544361,0.679605],[0.547608,0.679965],[0.548347,0.680146],[0.548958,0.680146],[0.549697,0.680326],[0.550308,0.680326],[0.551048,0.680506],[0.551659,0.680506],[0.552398,0.680686],[0.553009,0.680686],[0.553748,0.680866],[0.554359,0.680866],[0.554456,0.680956],[0.559053,0.681496],[0.559793,0.681676],[0.560404,0.681676],[0.561143,0.681856],[0.561754,0.681856],[0.562493,0.682036],[0.563747,0.682126],[0.563827,0.682239],[0.563827,0.682554],[0.563763,0.682689],[0.56357,0.686065],[0.556771,0.685187],[0.556674,0.685097],[0.556063,0.685097],[0.555324,0.684917],[0.554713,0.684917],[0.55333,0.684647],[0.55272,0.684647],[0.55198,0.684467],[0.551369,0.684467],[0.55063,0.684287],[0.550019,0.684287],[0.54928,0.684107],[0.548669,0.684107],[0.547929,0.683927],[0.547318,0.683927],[0.546579,0.683747],[0.545968,0.683747],[0.544586,0.683476],[0.543975,0.683476],[0.543235,0.683296],[0.542624,0.683296],[0.541885,0.683116],[0.541274,0.683116],[0.540535,0.682936],[0.539924,0.682936],[0.539184,0.682756],[0.538574,0.682756],[0.537834,0.682576],[0.537223,0.682576],[0.536484,0.682396],[0.535873,0.682396],[0.535776,0.682306],[0.53388,0.682126],[0.53314,0.681946],[0.532529,0.681946],[0.53179,0.681766],[0.531179,0.681766],[0.53044,0.681586],[0.529829,0.681586],[0.529089,0.681406],[0.528478,0.681406],[0.527739,0.681226],[0.527128,0.681226],[0.527032,0.681136],[0.525135,0.680956],[0.524395,0.680776],[0.523784,0.680776],[0.523045,0.680596],[0.522434,0.680596],[0.521695,0.680416],[0.521084,0.680416],[0.520344,0.680236],[0.519734,0.680236],[0.518994,0.680055],[0.518383,0.680055],[0.518287,0.679965],[0.51639,0.679785],[0.51565,0.679605],[0.51504,0.679605],[0.5143,0.679425],[0.513689,0.679425],[0.51295,0.679245],[0.512339,0.679245],[0.5116,0.679065],[0.510989,0.679065],[0.510249,0.678885],[0.509638,0.678885],[0.508256,0.678615],[0.505009,0.678255],[0.504864,0.678818],[0.504864,0.679493],[0.5048,0.679628],[0.5048,0.680303],[0.504735,0.680438],[0.504735,0.681113],[0.504671,0.681248],[0.504671,0.681923],[0.504607,0.682059],[0.504607,0.682734],[0.504543,0.682869],[0.504543,0.683544],[0.504478,0.683679],[0.504478,0.684354],[0.504414,0.684489],[0.504414,0.685164],[0.50435,0.685299],[0.50435,0.685975],[0.504285,0.68611],[0.504285,0.686785],[0.504221,0.68692],[0.504221,0.687595],[0.504157,0.68773],[0.504157,0.688405],[0.504092,0.68854],[0.504092,0.689216],[0.504028,0.689351],[0.504028,0.690026],[0.503964,0.690161],[0.503964,0.690836],[0.5039,0.690971],[0.5039,0.691646],[0.503835,0.691781],[0.503835,0.692456],[0.503771,0.692591],[0.503771,0.693267],[0.503707,0.693402],[0.503707,0.694077],[0.503642,0.694212],[0.503642,0.694887],[0.503578,0.695022],[0.503578,0.695697],[0.503514,0.695832],[0.503514,0.696508],[0.503449,0.696643],[0.503449,0.697318],[0.503385,0.697453],[0.503385,0.698128],[0.503321,0.698263],[0.503321,0.698938],[0.503257,0.699073],[0.503257,0.699748],[0.503192,0.699884],[0.503192,0.700559],[0.503128,0.700694],[0.503128,0.701369],[0.503064,0.701504],[0.503064,0.702179],[0.502999,0.702314],[0.502999,0.702989],[0.502935,0.703124],[0.502935,0.7038],[0.502871,0.703935],[0.502871,0.70461],[0.502806,0.704745],[0.502806,0.70542],[0.502742,0.705555],[0.502742,0.70623],[0.502678,0.706365],[0.502678,0.70704],[0.502614,0.707176],[0.502614,0.707851],[0.502549,0.707986],[0.502549,0.708661],[0.502485,0.708796],[0.502485,0.709471],[0.502421,0.709606],[0.502421,0.710281],[0.502356,0.710416],[0.502356,0.711092],[0.502292,0.711227],[0.502292,0.711902],[0.502228,0.712037],[0.502228,0.712712],[0.502163,0.712847],[0.502163,0.713522],[0.502099,0.713657],[0.502099,0.714333],[0.502035,0.714468],[0.502035,0.715143],[0.501971,0.715278],[0.501971,0.715953],[0.501906,0.716088],[0.501263,0.724505],[0.49845,0.724078],[0.499399,0.711677],[0.499463,0.711542],[0.499463,0.710867],[0.499527,0.710732],[0.499527,0.710056],[0.499591,0.709921],[0.499591,0.709246],[0.499656,0.709111],[0.499656,0.708436],[0.49972,0.708301],[0.49972,0.707626],[0.499784,0.707491],[0.499784,0.706815],[0.499849,0.70668],[0.499849,0.706005],[0.499913,0.70587],[0.499913,0.705195],[0.499977,0.70506],[0.499977,0.704385],[0.500042,0.70425],[0.500042,0.703575],[0.500106,0.703439],[0.500106,0.702764],[0.50017,0.702629],[0.50017,0.701954],[0.500234,0.701819],[0.500234,0.701144],[0.500299,0.701009],[0.500299,0.700334],[0.500363,0.700199],[0.500363,0.699523],[0.500427,0.699388],[0.500427,0.698713],[0.500492,0.698578],[0.500492,0.697903],[0.500556,0.697768],[0.500556,0.697093],[0.50062,0.696958],[0.50062,0.696283],[0.500685,0.696147],[0.500685,0.695472],[0.500749,0.695337],[0.500749,0.694662],[0.500813,0.694527],[0.500813,0.693852],[0.500877,0.693717],[0.500877,0.693042],[0.500942,0.692907],[0.500942,0.692231],[0.501006,0.692096],[0.501006,0.691421],[0.50107,0.691286],[0.50107,0.690611],[0.501135,0.690476],[0.501135,0.689801],[0.501199,0.689666],[0.501199,0.68899],[0.501263,0.688855],[0.501263,0.68818],[0.501328,0.688045],[0.501328,0.68737],[0.501392,0.687235],[0.501392,0.68656],[0.501456,0.686425],[0.501456,0.68575],[0.50152,0.685614],[0.50152,0.684939],[0.501585,0.684804],[0.501585,0.684129],[0.501649,0.683994],[0.501649,0.683319],[0.501713,0.683184],[0.501713,0.682509],[0.501778,0.682374],[0.501778,0.681698],[0.501842,0.681563],[0.501842,0.680888],[0.501906,0.680753],[0.501906,0.680078],[0.501971,0.679943],[0.501971,0.679268],[0.502035,0.679133],[0.502035,0.678458],[0.502099,0.678322],[0.502099,0.677647],[0.502163,0.677512],[0.502163,0.676837],[0.502228,0.676702],[0.502228,0.676027],[0.502292,0.675892],[0.502292,0.675217],[0.502356,0.675082],[0.502356,0.674406],[0.502421,0.674271],[0.502421,0.673596],[0.502485,0.673461],[0.502485,0.672786],[0.502549,0.672651],[0.502549,0.671976],[0.502614,0.671841],[0.502614,0.671165],[0.502678,0.67103],[0.502678,0.670355],[0.502742,0.67022],[0.502742,0.669545],[0.502806,0.66941],[0.502806,0.668735],[0.502871,0.6686],[0.502871,0.667925],[0.502935,0.667789],[0.502935,0.667114],[0.502999,0.666979],[0.502999,0.666304],[0.503064,0.666169],[0.503064,0.665494],[0.503128,0.665359],[0.503128,0.664684],[0.503192,0.664549],[0.503192,0.663873],[0.503257,0.663738],[0.503257,0.663063],[0.503321,0.662928],[0.503321,0.662253],[0.503385,0.662118],[0.503385,0.661443],[0.503449,0.661308],[0.503449,0.660633],[0.503514,0.660497],[0.503514,0.659822],[0.503578,0.659687],[0.503578,0.659012],[0.503642,0.658877],[0.503642,0.658202],[0.503707,0.658067],[0.503707,0.657392],[0.503771,0.657257],[0.503771,0.656581],[0.503835,0.656446],[0.503835,0.655771],[0.5039,0.655636],[0.5039,0.654961],[0.503964,0.654826],[0.503964,0.654151],[0.504028,0.654016],[0.504028,0.65334],[0.504092,0.653205],[0.504092,0.65253],[0.504157,0.652395],[0.504157,0.65172],[0.504221,0.651585],[0.504221,0.65091],[0.504285,0.650775],[0.504285,0.6501],[0.50435,0.649965],[0.50435,0.649289],[0.504414,0.649154],[0.504414,0.648479],[0.504478,0.648344],[0.504478,0.647669],[0.504543,0.647534],[0.504543,0.646859],[0.504607,0.646724],[0.504607,0.646048],[0.504671,0.645913],[0.504671,0.645238],[0.504735,0.645103],[0.504735,0.644428],[0.5048,0.644293],[0.5048,0.643618],[0.504864,0.643483],[0.504864,0.642808],[0.504928,0.642673],[0.504928,0.641997],[0.504993,0.641862],[0.504993,0.641187],[0.505057,0.641052],[0.505057,0.640377],[0.505121,0.640242],[0.505121,0.639567],[0.505186,0.639432],[0.505186,0.638756],[0.50525,0.638621],[0.50525,0.637946],[0.505314,0.637811],[0.505314,0.637136],[0.505378,0.637001],[0.505378,0.636326],[0.505443,0.636191],[0.505443,0.635515],[0.505507,0.63538],[0.505507,0.634705],[0.505571,0.63457],[0.505571,0.633895],[0.505636,0.63376],[0.505636,0.633085],[0.5057,0.63295],[0.5057,0.632275],[0.505764,0.63214],[0.505764,0.631464],[0.505829,0.631329],[0.505829,0.630654],[0.505893,0.630519],[0.505893,0.629844],[0.505957,0.629709],[0.505957,0.629034],[0.506021,0.628899],[0.506021,0.628223],[0.506086,0.628088],[0.506086,0.627413],[0.50615,0.627278],[0.50615,0.626603],[0.506214,0.626468],[0.506214,0.625793],[0.506279,0.625658],[0.506279,0.624983]];
