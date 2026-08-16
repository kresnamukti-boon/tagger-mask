// Synthetic Node harness for rw_ocr.js. Loads the real shipped module body
// against a minimal DOM stub (no browser, no network, no wasm) — the same
// discipline this project's other verify_*.js files use: exercise the real
// source, not a reimplementation, and drive real registered event listeners
// wherever the bug class would otherwise go untested (see rw_elbow.js's own
// "round 7" note in CLAUDE.md about exactly that gap).
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

/* ---------- minimal DOM stub ---------- */

function findById(node, id){
  for (const c of (node._children || [])){
    if (c.id === id) return c;
    const f = findById(c, id);
    if (f) return f;
  }
  return null;
}

function makeElement(tag){
  const listeners = {};
  const el = {
    tagName: tag,
    id: '',
    className: '',
    hidden: false,
    value: '',
    innerText: '',
    textContent: '',
    title: '',
    width: 0,
    height: 0,
    style: { cssText: '', display: '' }, // real elements default to an empty inline display
    classList: { _set: new Set(), contains(c){ return this._set.has(c); } },
    _children: [],
    parentNode: null,
    _rect: { left: 0, top: 0, width: 100, height: 100 },
    getBoundingClientRect(){ return this._rect; },
    addEventListener(type, fn){ (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent(evt){ (listeners[evt.type] || []).slice().forEach(fn => fn(evt)); return true; },
    _fire(type, evt){
      evt = Object.assign({ stopPropagation(){}, preventDefault(){}, stopImmediatePropagation(){} }, evt);
      (listeners[type] || []).slice().forEach(fn => fn(evt));
    },
    appendChild(child){ this._children.push(child); child.parentNode = this; return child; },
    removeChild(child){
      const idx = this._children.indexOf(child);
      if (idx !== -1) this._children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    insertAdjacentElement(pos, child){
      const parent = this.parentNode;
      if (!parent){ this._children.push(child); child.parentNode = this; return child; }
      const idx = parent._children.indexOf(this);
      parent._children.splice(idx + 1, 0, child);
      child.parentNode = parent;
      return child;
    },
    querySelector(sel){
      if (sel[0] === '#') return findById(this, sel.slice(1));
      return null;
    },
    getContext(){
      return {
        fillStyle: '',
        fillRect(){},
        drawImage(){ this._drewCalls = (this._drewCalls || 0) + 1; }
      };
    }
  };
  return el;
}

function makeStubWindow(){
  const byId = {};
  const head = makeElement('head');
  const body = makeElement('body');
  let scriptCreateCount = 0;
  const docListeners = {};

  const documentStub = {
    _byId: byId,
    getElementById(id){ return byId[id] || null; },
    createElement(tag){
      if (tag === 'script') scriptCreateCount++;
      return makeElement(tag);
    },
    addEventListener(type, fn){ (docListeners[type] = docListeners[type] || []).push(fn); },
    _fire(type, evt){ (docListeners[type] || []).slice().forEach(fn => fn(evt)); },
    head,
    body
  };

  const win = {
    document: documentStub,
    getComputedStyle(){ return { display: '', visibility: '' }; },
    MutationObserver: undefined, // exercised via direct RW._ocrMaybeInject calls instead
    __RW: { vocr: undefined }
  };

  return { win, doc: documentStub, byId, head, body, scriptCreateCount: () => scriptCreateCount };
}

/* ---------- load the real module fresh into a given global context ---------- */

function loadModule(win){
  const src = fs.readFileSync(path.join(__dirname, 'rw_ocr.js'), 'utf8');
  const sandboxGlobals = {
    window: win,
    document: win.document,
    annotationState: global.annotationState,
    Event: global.Event || function(type, opts){ this.type = type; this.bubbles = !!(opts && opts.bubbles); }
  };
  const fn = new Function(...Object.keys(sandboxGlobals), src + '\n//# sourceURL=rw_ocr.js');
  return fn(...Object.values(sandboxGlobals));
}

/* ================= tests ================= */

// ---- 1. pure geometry ----
{
  const { win } = makeStubWindow();
  win.__RW.vocr = undefined;
  loadModule(win);
  const RW = win.__RW;
  const rect = { left: 10, top: 20, width: 200, height: 100 };

  const p = RW._ocrNormPoint(110, 70, rect);
  approx(p.x, 0.5, 1e-9, 'normPoint x');
  approx(p.y, 0.5, 1e-9, 'normPoint y');

  // drag in each corner-crossing direction should produce the same min/max box
  const a = { x: 0.2, y: 0.3 }, b = { x: 0.6, y: 0.7 };
  for (const [p1, p2, label] of [[a, b, 'down-right'], [b, a, 'up-left'],
    [{x:a.x,y:b.y}, {x:b.x,y:a.y}, 'down-left'], [{x:b.x,y:a.y}, {x:a.x,y:b.y}, 'up-right']]){
    const box = RW._ocrBoxFromPoints(p1, p2, rect);
    ok(box && approxEq(box.x0,0.2) && approxEq(box.x1,0.6) && approxEq(box.y0,0.3) && approxEq(box.y1,0.7),
      'box orientation independence: ' + label);
  }
  function approxEq(x,y){ return Math.abs(x-y) < 1e-9; }

  // degenerate (sub-threshold) box on both axes -> null
  const tiny = RW._ocrBoxFromPoints({x:0.5,y:0.5}, {x:0.5001,y:0.5001}, rect);
  ok(tiny === null, 'degenerate box rejected');

  // a real drag on only one axis (still a meaningful box) is NOT rejected
  const oneAxis = RW._ocrBoxFromPoints({x:0.1,y:0.5}, {x:0.9,y:0.5001}, rect);
  ok(oneAxis !== null, 'single-axis drag past threshold is accepted');
}

// ---- 2. title gate ----
{
  const { win } = makeStubWindow();
  loadModule(win);
  const RW = win.__RW;
  ok(RW._ocrIsNewBoxTitle('Name this reference') === true, 'title gate: exact match');
  ok(RW._ocrIsNewBoxTitle('  Name this reference  ') === true, 'title gate: trims whitespace');
  ok(RW._ocrIsNewBoxTitle('Edit reference') === false, 'title gate: edit-mode rejected');
  ok(RW._ocrIsNewBoxTitle('') === false, 'title gate: empty rejected');
}

// ---- 3. crop rect + upscale ----
{
  const { win } = makeStubWindow();
  loadModule(win);
  const RW = win.__RW;

  const box = { x0: 0.25, y0: 0.5, x1: 0.75, y1: 0.6 };
  const r = RW._ocrCropRect(box, 2000, 1000);
  ok(r.sx === 500 && r.sy === 500 && r.sw === 1000 && r.sh === 100,
    'crop rect matches hand-computed values (got ' + JSON.stringify(r) + ')');

  // target-height upscale, well under the cap
  approx(RW._ocrUpscaleFactor(400, 40), 5, 1e-9, 'upscale: 40px -> 200px target = 5x');
  // already-tall crop: no upscale
  approx(RW._ocrUpscaleFactor(400, 400), 1, 1e-9, 'upscale: already >=200px -> 1x');
  // scale-cap: a 2px-tall sliver would want 100x, capped at 6x
  approx(RW._ocrUpscaleFactor(50, 2), 6, 1e-9, 'upscale: capped at maxScale (6x)');
  // pixel-budget cap: a big crop that's still short must not blow the budget
  const budgeted = RW._ocrUpscaleFactor(3000, 150, { maxPixels: 4e6 });
  const destPixels = (3000*budgeted) * (150*budgeted);
  ok(destPixels <= 4e6 + 1, 'upscale: respects pixel budget (' + destPixels + ' <= 4e6)');
  ok(budgeted < 6, 'upscale: budget cap actually bound tighter than maxScale here');
}

// ---- 4. line selection ----
{
  const { win } = makeStubWindow();
  loadModule(win);
  const RW = win.__RW;

  const r1 = RW._ocrPickLongestLine('A\n3-201\nDETAIL\n|');
  ok(r1.longest === 'DETAIL', 'longest line picked (got "' + r1.longest + '")');
  ok(r1.lines.length === 4, 'all non-blank lines retained');

  const r2 = RW._ocrPickLongestLine('  \n   \n');
  ok(r2.longest === '' && r2.lines.length === 0, 'blank-only text -> no longest, empty lines');

  const r3 = RW._ocrPickLongestLine('');
  ok(r3.longest === '' && r3.lines.length === 0, 'empty text handled without throwing');
}

// ---- 5. DOM-event-driven box tracking (real registered listeners) ----
{
  const { win, byId } = makeStubWindow();
  const ac = makeElement('canvas');
  ac.id = 'annotation-canvas';
  ac._rect = { left: 0, top: 0, width: 300, height: 200 };
  byId['annotation-canvas'] = ac;

  global.annotationState = { referenceAuthoring: true, currentTool: 'bounding_box' };
  loadModule(win);
  const RW = win.__RW;

  ac._fire('mousedown', { clientX: 30, clientY: 20 });
  ac._fire('mouseup', { clientX: 150, clientY: 100 });
  ok(RW._ocrLastBoxN !== null, 'box recorded while in reference bounding_box mode');
  approx(RW._ocrLastBoxN.x0, 0.1, 1e-9, 'recorded box x0');
  approx(RW._ocrLastBoxN.y1, 0.5, 1e-9, 'recorded box y1');

  // mode gate: wrong tool -> no box recorded (reset state first)
  RW._ocrLastBoxN = null;
  global.annotationState.currentTool = 'polygon';
  ac._fire('mousedown', { clientX: 30, clientY: 20 });
  ac._fire('mouseup', { clientX: 150, clientY: 100 });
  ok(RW._ocrLastBoxN === null, 'no box recorded when currentTool is not bounding_box');

  global.annotationState.currentTool = 'bounding_box';
  global.annotationState.referenceAuthoring = false;
  ac._fire('mousedown', { clientX: 30, clientY: 20 });
  ac._fire('mouseup', { clientX: 150, clientY: 100 });
  ok(RW._ocrLastBoxN === null, 'no box recorded when referenceAuthoring is false');

  global.annotationState.referenceAuthoring = true;
}

// ---- 6. modal injection: create-vs-edit gate + idempotency ----
{
  const { win } = makeStubWindow();
  loadModule(win);
  const RW = win.__RW;

  function buildModal(titleText){
    const modal = makeElement('div');
    modal.id = 'reference-prompt-modal';
    const title = makeElement('h2');
    title.id = 'reference-prompt-title';
    title.textContent = titleText;
    modal.appendChild(title);
    const nameInp = makeElement('input');
    nameInp.id = 'reference-prompt-name';
    modal.appendChild(nameInp);
    return modal;
  }

  const editModal = buildModal('Edit reference');
  RW._ocrMaybeInject(editModal);
  ok(editModal.querySelector('#rw-ocr-btn') === null, 'edit-mode modal gets no OCR button');

  const newModal = buildModal('Name this reference');
  RW._ocrMaybeInject(newModal);
  ok(newModal.querySelector('#rw-ocr-btn') !== null, 'new-box modal gets an OCR button');
  ok(newModal.querySelector('#rw-ocr-status') !== null, 'new-box modal gets a status span');

  const countBefore = newModal._children.length;
  RW._ocrMaybeInject(newModal);
  RW._ocrMaybeInject(newModal);
  ok(newModal._children.length === countBefore, 'repeat injection is idempotent');
}

// ---- 7. full recognize flow, Tesseract already present ----
{
  const { win } = makeStubWindow();
  loadModule(win);
  const RW = win.__RW;
  win.Tesseract = { recognize: async () => ({ data: { text: 'A\n3-201\nDETAIL\n|' } }) };

  const nameInp = makeElement('input');
  nameInp.value = 'old value';
  let inputEventFired = false;
  nameInp.addEventListener('input', () => { inputEventFired = true; });
  const status = makeElement('span');

  const pdf = makeElement('canvas');
  pdf.width = 400; pdf.height = 200;
  win.document._byId['pdf-canvas'] = pdf;

  RW._ocrLastBoxN = { x0: 0, y0: 0, x1: 1, y1: 1 };

  RW._ocrRunDetect(nameInp, status).then(() => {
    ok(nameInp.value === 'DETAIL', 'recognized longest line written into the field');
    ok(inputEventFired === true, 'a real input event was dispatched');
    ok(RW._ocrLastLines.length === 4, 'RW._ocrLastLines retains every recognized line');
    ok(status.textContent.indexOf('DETAIL') !== -1, 'status line shows the chosen text');
    runRemainingTests();
  }).catch(e => { fail++; console.error('FAIL: recognize flow threw', e); runRemainingTests(); });
}

function runRemainingTests(){
  // ---- 8. failure paths never mutate the field and never throw ----
  (async () => {
    const { win } = makeStubWindow();
    loadModule(win);
    const RW = win.__RW;

    // 8a. no box captured
    {
      const nameInp = makeElement('input'); nameInp.value = 'keep me';
      const status = makeElement('span');
      RW._ocrLastBoxN = null;
      await RW._ocrRunDetect(nameInp, status);
      ok(nameInp.value === 'keep me', '8a: no-box path leaves field untouched');
      ok(status.textContent.indexOf('redraw the box') !== -1, '8a: status explains no box');
    }

    // 8b. CDN load failure -> CSP message, field untouched
    {
      win.Tesseract = undefined;
      let scriptEl = null;
      win.document.createElement = (tag) => {
        const el = makeElement(tag);
        if (tag === 'script') scriptEl = el;
        return el;
      };
      win.document.head.appendChild = (el) => {
        if (el.tagName === 'script' && el.onerror) el.onerror();
      };
      const nameInp = makeElement('input'); nameInp.value = 'keep me';
      const status = makeElement('span');
      RW._ocrLastBoxN = { x0:0, y0:0, x1:1, y1:1 };
      await RW._ocrRunDetect(nameInp, status);
      ok(nameInp.value === 'keep me', '8b: CDN failure leaves field untouched');
      ok(status.textContent.indexOf('CSP') !== -1 && status.textContent.indexOf('_ocrTesseractSrc') !== -1,
        '8b: status names the CSP override variable');
    }

    // 8c. unreadable canvas (#pdf-canvas missing) -> explicit status, field untouched
    {
      const { win: win2 } = makeStubWindow();
      loadModule(win2);
      const RW2 = win2.__RW;
      win2.Tesseract = { recognize: async () => ({ data: { text: 'ignored' } }) };
      const nameInp = makeElement('input'); nameInp.value = 'keep me';
      const status = makeElement('span');
      RW2._ocrLastBoxN = { x0:0, y0:0, x1:1, y1:1 };
      // no pdf-canvas registered in win2.document._byId
      await RW2._ocrRunDetect(nameInp, status);
      ok(nameInp.value === 'keep me', '8c: unreadable canvas leaves field untouched');
      ok(status.textContent.indexOf('could not read') !== -1, '8c: status explains crop failure');
    }

    // 8d. recognition throws -> explicit status, field untouched
    {
      const { win: win3 } = makeStubWindow();
      loadModule(win3);
      const RW3 = win3.__RW;
      win3.Tesseract = { recognize: async () => { throw new Error('boom'); } };
      const pdf = makeElement('canvas'); pdf.width = 100; pdf.height = 100;
      win3.document._byId['pdf-canvas'] = pdf;
      const nameInp = makeElement('input'); nameInp.value = 'keep me';
      const status = makeElement('span');
      RW3._ocrLastBoxN = { x0:0, y0:0, x1:1, y1:1 };
      await RW3._ocrRunDetect(nameInp, status);
      ok(nameInp.value === 'keep me', '8d: recognition throwing leaves field untouched');
      ok(status.textContent.indexOf('recognition failed') !== -1, '8d: status explains recognition failure');
    }

    // 8e. no text recognized -> explicit status, field untouched
    {
      const { win: win4 } = makeStubWindow();
      loadModule(win4);
      const RW4 = win4.__RW;
      win4.Tesseract = { recognize: async () => ({ data: { text: '   \n  ' } }) };
      const pdf = makeElement('canvas'); pdf.width = 100; pdf.height = 100;
      win4.document._byId['pdf-canvas'] = pdf;
      const nameInp = makeElement('input'); nameInp.value = 'keep me';
      const status = makeElement('span');
      RW4._ocrLastBoxN = { x0:0, y0:0, x1:1, y1:1 };
      await RW4._ocrRunDetect(nameInp, status);
      ok(nameInp.value === 'keep me', '8e: blank recognition leaves field untouched');
      ok(status.textContent.indexOf('no text recognized') !== -1, '8e: status explains empty recognition');
    }

    // ---- 9. script tag is only ever created once across repeated calls ----
    {
      const { win: win5 } = makeStubWindow();
      loadModule(win5);
      const RW5 = win5.__RW;
      let scriptCreates = 0;
      const realCreateElement = win5.document.createElement;
      win5.document.createElement = (tag) => {
        if (tag === 'script') scriptCreates++;
        return realCreateElement(tag);
      };
      win5.document.head.appendChild = (el) => {
        win5.Tesseract = { recognize: async () => ({ data: { text: 'FIRST\nSECOND LINE' } }) };
        if (el.onload) el.onload();
      };
      const pdf = makeElement('canvas'); pdf.width = 100; pdf.height = 100;
      win5.document._byId['pdf-canvas'] = pdf;

      const nameInp1 = makeElement('input');
      const status1 = makeElement('span');
      RW5._ocrLastBoxN = { x0:0, y0:0, x1:1, y1:1 };
      await RW5._ocrRunDetect(nameInp1, status1);

      const nameInp2 = makeElement('input');
      const status2 = makeElement('span');
      RW5._ocrLastBoxN = { x0:0, y0:0, x1:1, y1:1 };
      await RW5._ocrRunDetect(nameInp2, status2);

      ok(scriptCreates === 1, 'Tesseract script tag created only once across two OCR runs (got ' + scriptCreates + ')');
      ok(nameInp2.value === 'SECOND LINE', 'second run still recognizes correctly after cached load');
    }

    // ---- 10. custom OCR-box drawing: hide dialog, drag, reopen ----
    {
      global.annotationState = { referenceAuthoring: true, currentTool: 'bounding_box' };
      const { win, byId } = makeStubWindow();

      const ac = makeElement('canvas');
      ac.id = 'annotation-canvas';
      ac._rect = { left: 0, top: 0, width: 300, height: 200 };
      byId['annotation-canvas'] = ac;

      loadModule(win);
      const RW = win.__RW;

      function buildModal(){
        const modal = makeElement('div');
        modal.id = 'reference-prompt-modal';
        const title = makeElement('h2');
        title.id = 'reference-prompt-title';
        title.textContent = 'Name this reference';
        modal.appendChild(title);
        const nameInp = makeElement('input');
        nameInp.id = 'reference-prompt-name';
        modal.appendChild(nameInp);
        return modal;
      }
      const modal = buildModal();
      byId['reference-prompt-modal'] = modal; // RW._ocrSyncBoxStatus looks this up by id
      RW._ocrMaybeInject(modal);

      const boxBtn = modal.querySelector('#rw-ocr-box-btn');
      const clearBtn = modal.querySelector('#rw-ocr-clear-btn');
      const boxStatus = modal.querySelector('#rw-ocr-box-status');
      ok(boxBtn && clearBtn && boxStatus, '10: OCR Box / Clear Box / box-status all injected');
      ok(boxStatus.textContent === 'using reference box', '10: initial box-status reads "using reference box"');

      // 10a. arm + drag captures an override box, hides then restores the modal
      RW._ocrLastBoxN = { x0: 0.9, y0: 0.9, x1: 0.95, y1: 0.95 }; // distinct from the drawn box, to prove precedence later
      boxBtn.onclick({ preventDefault(){} });
      ok(modal.style.display === 'none', '10a: dialog hidden while OCR-box drag is armed');
      ok(RW._ocrBoxDrawing === true, '10a: RW._ocrBoxDrawing true while armed');
      ok(win.document.body._children.some(c => c.id === 'rw-ocr-draw-hint'), '10a: hint banner appended to body');

      ac._fire('mousedown', { clientX: 30, clientY: 20 });
      ok(win.document.body._children.some(c => c.id === 'rw-ocr-draw-rect'), '10a: preview rect appended on mousedown');
      ac._fire('mousemove', { clientX: 150, clientY: 100 });
      const rectEl = win.document.body._children.find(c => c.id === 'rw-ocr-draw-rect');
      ok(rectEl.style.width === '120px' && rectEl.style.height === '80px', '10a: preview rect follows mousemove');
      ac._fire('mouseup', { clientX: 150, clientY: 100 });

      ok(RW._ocrBoxDrawing === false, '10a: RW._ocrBoxDrawing false after mouseup');
      ok(modal.style.display === '', '10a: dialog display restored after capturing the box');
      ok(!win.document.body._children.some(c => c.id === 'rw-ocr-draw-hint' || c.id === 'rw-ocr-draw-rect'),
        '10a: hint/preview elements removed after mouseup');
      ok(RW._ocrOverrideBoxN !== null, '10a: override box captured');
      approx(RW._ocrOverrideBoxN.x0, 0.1, 1e-9, '10a: captured override box x0');
      approx(RW._ocrOverrideBoxN.y1, 0.5, 1e-9, '10a: captured override box y1');
      ok(boxStatus.textContent === 'using custom box ✓', '10a: box-status reflects the custom box');
      ok(RW._ocrActiveBox() === RW._ocrOverrideBoxN, '10a: active box prefers the override over the reference box');

      // 10b. Escape cancels a drag in progress without touching a prior override
      const priorOverride = RW._ocrOverrideBoxN;
      boxBtn.onclick({ preventDefault(){} });
      ac._fire('mousedown', { clientX: 10, clientY: 10 });
      ac._fire('mousemove', { clientX: 50, clientY: 50 });
      win.document._fire('keydown', { key: 'Escape', stopPropagation(){}, preventDefault(){} });
      ok(RW._ocrBoxDrawing === false, '10b: Escape clears the armed/drawing state');
      ok(modal.style.display === '', '10b: Escape restores the dialog');
      ok(RW._ocrOverrideBoxN === priorOverride, '10b: Escape does not touch a previously captured override');
      ok(!win.document.body._children.some(c => c.id === 'rw-ocr-draw-hint' || c.id === 'rw-ocr-draw-rect'),
        '10b: Escape removes hint/preview elements');

      // 10c. Clear Box resets to the reference box
      clearBtn.onclick({ preventDefault(){} });
      ok(RW._ocrOverrideBoxN === null, '10c: Clear Box resets the override');
      ok(boxStatus.textContent === 'using reference box', '10c: box-status reflects the reset');
      ok(RW._ocrActiveBox() === RW._ocrLastBoxN, '10c: active box falls back to the reference box');

      // 10d. drawing a genuinely new reference box retires any override
      boxBtn.onclick({ preventDefault(){} });
      ac._fire('mousedown', { clientX: 30, clientY: 20 });
      ac._fire('mouseup', { clientX: 150, clientY: 100 });
      ok(RW._ocrOverrideBoxN !== null, '10d setup: a fresh override is in place before the check');
      ac._fire('mousedown', { clientX: 5, clientY: 5 });
      ac._fire('mouseup', { clientX: 250, clientY: 150 });
      ok(RW._ocrOverrideBoxN === null, '10d: a newly-tracked reference box retires the custom override');
      ok(boxStatus.textContent === 'using reference box', '10d: box-status reflects the retirement');

      // 10e. while OCR-box drawing is armed, the reference-box tracker itself is inert
      // even if it somehow still receives the event (defense independent of propagation order)
      RW._ocrLastBoxN = { x0: 0.9, y0: 0.9, x1: 0.95, y1: 0.95 };
      boxBtn.onclick({ preventDefault(){} });
      RW._ocrBoxDrawing = true; // already true from onclick, restated for clarity
      const before = RW._ocrLastBoxN;
      // the module's own tracking listener is registered first; firing it directly
      // exercises the explicit `if (RW._ocrBoxDrawing) return;` guard regardless of
      // real capture/bubble ordering.
      ac._fire('mousedown', { clientX: 1, clientY: 1 });
      ac._fire('mouseup', { clientX: 200, clientY: 150 });
      ok(RW._ocrLastBoxN === before, '10e: reference-box tracker is inert while OCR-box drawing is armed');
      finishOcrBoxDrawForTest(RW); // tidy up armed state so it doesn't leak into later assertions
      function finishOcrBoxDrawForTest(RW){ RW._ocrBoxDrawing = false; modal.style.display = ''; }
    }

    // ---- 11. RW._ocrActiveBox precedence, pure ----
    {
      const { win } = makeStubWindow();
      loadModule(win);
      const RW = win.__RW;
      const a = { x0:0, y0:0, x1:0.1, y1:0.1 };
      const b = { x0:0.5, y0:0.5, x1:0.6, y1:0.6 };

      RW._ocrOverrideBoxN = a; RW._ocrLastBoxN = b;
      ok(RW._ocrActiveBox() === a, '11: override wins over reference box when both are set');

      RW._ocrOverrideBoxN = null; RW._ocrLastBoxN = b;
      ok(RW._ocrActiveBox() === b, '11: falls back to reference box when no override');

      RW._ocrOverrideBoxN = null; RW._ocrLastBoxN = null;
      ok(RW._ocrActiveBox() === null, '11: null when neither is set');
    }

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  })();
}
