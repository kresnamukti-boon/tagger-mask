// RW vOCR — OCR-assisted reference naming. Reads printed text inside a
// drawn reference box (host app's own ?mode=reference flow) and pre-fills
// the naming dialog's Name field. In-browser only (Tesseract.js, CDN-loaded
// on first use) — nothing leaves the browser, nothing auto-submits.
//
// Also offers a dedicated, tighter "OCR Box" — hides the naming dialog,
// lets you drag a second box directly on the drawing just for OCR (the
// reference box itself is untouched), then reopens the dialog. Sticks
// until cleared or redrawn, and until a new reference box is captured.
//
// Opt-in variant only: bundled by build_loader_ocr.sh into
// console_loader_ocr.js, never into the everyday console_loader.js.
//
// Purely observational — never wraps/blocks the host app's own reference
// box-drawing or dialog, except while the OCR-box drag itself is armed
// (mirrors the capture+stopPropagation pattern rw_masktools.js's rect tool
// already uses to shadow the app's own drawing tool). Needs only RW as a
// namespace, no other rw_*.js module's internals.
//
// Full design history: CLAUDE.md.
(function(){
  const RW = window.__RW;
  if (!RW) return 'need the base workbench (rw_install.js) first';
  if (RW.vocr) return 'OCR module already installed';
  RW.vocr = true;

  /* ---------- config — override from the console if the CDN/CSP needs it ---------- */
  RW._ocrTesseractSrc = RW._ocrTesseractSrc || 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  RW._ocrCorePath     = RW._ocrCorePath     || 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd.wasm.js';
  RW._ocrLangPath     = RW._ocrLangPath     || 'https://tessdata.projectnaptha.com/4.0.0';
  RW._ocrLang         = RW._ocrLang         || 'eng';

  /* ---------- state ---------- */
  RW._ocrLastBoxN     = null;  // {x0,y0,x1,y1} normalized box of the last drawn reference box, or null
  RW._ocrOverrideBoxN = null;  // sticky, tighter box drawn just for OCR, or null (takes precedence)
  RW._ocrLastLines    = [];    // every non-blank line from the last OCR run
  RW._ocrMinBoxPx     = 5;     // below this on both axes, a mousedown/up pair is a stray click, not a box drag
  RW._ocrBoxDrawing   = false; // true while the OCR-box drag is armed (dialog hidden)

  /* ---------- pure helpers ---------- */

  RW._ocrNormPoint = function(clientX, clientY, rect){
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  };

  RW._ocrBoxFromPoints = function(p1, p2, rect){
    const dxPx = Math.abs(p1.x - p2.x) * rect.width;
    const dyPx = Math.abs(p1.y - p2.y) * rect.height;
    if (dxPx < RW._ocrMinBoxPx && dyPx < RW._ocrMinBoxPx) return null;
    return {
      x0: Math.min(p1.x, p2.x), y0: Math.min(p1.y, p2.y),
      x1: Math.max(p1.x, p2.x), y1: Math.max(p1.y, p2.y)
    };
  };

  RW._ocrIsNewBoxTitle = function(titleText){
    return (titleText || '').trim() === 'Name this reference';
  };

  // The box OCR actually reads: the custom OCR box if one is set, else the reference box.
  RW._ocrActiveBox = function(){
    return RW._ocrOverrideBoxN || RW._ocrLastBoxN;
  };

  RW._ocrCropRect = function(boxN, pdfW, pdfH){
    return {
      sx: Math.round(boxN.x0 * pdfW),
      sy: Math.round(boxN.y0 * pdfH),
      sw: Math.max(1, Math.round((boxN.x1 - boxN.x0) * pdfW)),
      sh: Math.max(1, Math.round((boxN.y1 - boxN.y0) * pdfH))
    };
  };

  // Upscales a small crop for legibility: target ~200px tall, capped at 6x
  // and at a 4-megapixel destination budget.
  RW._ocrUpscaleFactor = function(sw, sh, opts){
    opts = opts || {};
    const targetH   = opts.targetH   != null ? opts.targetH   : 200;
    const maxScale  = opts.maxScale  != null ? opts.maxScale  : 6;
    const maxPixels = opts.maxPixels != null ? opts.maxPixels : 4e6;
    if (!(sw > 0) || !(sh > 0)) return 1;
    let scale = sh < targetH ? targetH / sh : 1;
    scale = Math.min(scale, maxScale);
    const budgetScale = Math.sqrt(maxPixels / (sw * sh));
    return Math.min(scale, budgetScale);
  };

  // Recognized text -> {lines, longest}. Blank lines dropped; longest line wins.
  RW._ocrPickLongestLine = function(text){
    const lines = (text || '').split('\n').map(s => s.trim()).filter(Boolean);
    let longest = '';
    for (const l of lines) if (l.length > longest.length) longest = l;
    return { lines, longest };
  };

  /* ---------- reference-box tracking (independent of the app's own private state) ---------- */

  function ocrModeActive(){
    return typeof annotationState !== 'undefined' && annotationState.referenceAuthoring
        && annotationState.currentTool === 'bounding_box';
  }

  RW._ocrSyncBoxStatus = function(){
    const modal = document.getElementById('reference-prompt-modal');
    if (!modal) return;
    const boxStatus = modal.querySelector('#rw-ocr-box-status');
    if (!boxStatus) return;
    boxStatus.textContent = RW._ocrOverrideBoxN ? 'using custom box ✓' : 'using reference box';
  };

  const ac = document.getElementById('annotation-canvas');
  let downClient = null;
  if (ac){
    ac.addEventListener('mousedown', function(e){
      if (RW._ocrBoxDrawing) return; // this drag belongs to the OCR-box tool, not reference tracking
      downClient = ocrModeActive() ? { x: e.clientX, y: e.clientY, rect: ac.getBoundingClientRect() } : null;
    });
    ac.addEventListener('mouseup', function(e){
      if (RW._ocrBoxDrawing) return;
      if (!downClient) return;
      const rect = downClient.rect;
      const p1 = RW._ocrNormPoint(downClient.x, downClient.y, rect);
      const p2 = RW._ocrNormPoint(e.clientX, e.clientY, rect);
      downClient = null;
      const box = RW._ocrBoxFromPoints(p1, p2, rect);
      if (box){
        RW._ocrLastBoxN = box;
        RW._ocrOverrideBoxN = null; // a genuinely new reference box retires any prior custom OCR box
        RW._ocrSyncBoxStatus();
      }
    });
  }

  /* ---------- OCR-box drawing: hide dialog, drag a tighter box, reopen ---------- */

  let drawModal = null, drawPriorDisplay = '', drawStart = null, drawRectEl = null, drawHintEl = null;

  function armOcrBoxDraw(modal){
    drawModal = modal;
    drawPriorDisplay = modal.style.display;
    modal.style.display = 'none';
    RW._ocrBoxDrawing = true;
    drawHintEl = document.createElement('div');
    drawHintEl.id = 'rw-ocr-draw-hint';
    drawHintEl.textContent = 'OCR box: drag a tighter area on the drawing — Esc to cancel';
    drawHintEl.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);'
      + 'background:rgba(20,20,20,.85);color:#fff;font-size:12px;padding:6px 12px;'
      + 'border-radius:4px;z-index:99999;pointer-events:none;';
    document.body.appendChild(drawHintEl);
  }

  function finishOcrBoxDraw(){
    RW._ocrBoxDrawing = false;
    if (drawRectEl && drawRectEl.parentNode) drawRectEl.parentNode.removeChild(drawRectEl);
    if (drawHintEl && drawHintEl.parentNode) drawHintEl.parentNode.removeChild(drawHintEl);
    drawRectEl = null; drawHintEl = null; drawStart = null;
    if (drawModal) drawModal.style.display = drawPriorDisplay;
    drawModal = null;
  }

  function updateOcrDrawRect(curX, curY){
    if (!drawRectEl || !drawStart) return;
    const left = Math.min(drawStart.x, curX), top = Math.min(drawStart.y, curY);
    drawRectEl.style.left = left + 'px';
    drawRectEl.style.top = top + 'px';
    drawRectEl.style.width = Math.abs(curX - drawStart.x) + 'px';
    drawRectEl.style.height = Math.abs(curY - drawStart.y) + 'px';
  }

  if (ac){
    // Capture phase + stopPropagation/preventDefault while armed, so the
    // app's own reference box-drawing tool never sees this drag (same
    // shadowing pattern rw_masktools.js's rect tool already uses).
    ac.addEventListener('mousedown', function(e){
      if (!RW._ocrBoxDrawing) return;
      e.stopPropagation(); e.preventDefault();
      drawStart = { x: e.clientX, y: e.clientY };
      drawRectEl = document.createElement('div');
      drawRectEl.id = 'rw-ocr-draw-rect';
      drawRectEl.style.cssText = 'position:fixed;border:2px dashed #ff8c00;'
        + 'background:rgba(255,140,0,0.12);z-index:99998;pointer-events:none;';
      document.body.appendChild(drawRectEl);
      updateOcrDrawRect(e.clientX, e.clientY);
    }, true);

    ac.addEventListener('mousemove', function(e){
      if (!RW._ocrBoxDrawing || !drawStart) return;
      e.stopPropagation();
      updateOcrDrawRect(e.clientX, e.clientY);
    }, true);

    ac.addEventListener('mouseup', function(e){
      if (!RW._ocrBoxDrawing || !drawStart) return;
      e.stopPropagation(); e.preventDefault();
      const rect = ac.getBoundingClientRect();
      const p1 = RW._ocrNormPoint(drawStart.x, drawStart.y, rect);
      const p2 = RW._ocrNormPoint(e.clientX, e.clientY, rect);
      const box = RW._ocrBoxFromPoints(p1, p2, rect);
      finishOcrBoxDraw();
      if (box){
        RW._ocrOverrideBoxN = box;
        RW._ocrSyncBoxStatus();
      }
    }, true);
  }

  document.addEventListener('keydown', function(e){
    if (!RW._ocrBoxDrawing) return;
    if (e.key === 'Escape'){
      e.stopPropagation(); e.preventDefault();
      finishOcrBoxDraw();
    }
  }, true);

  /* ---------- naming-dialog detection + injection ---------- */

  function modalTitleText(modal){
    const t = modal.querySelector('#reference-prompt-title');
    return t ? (t.innerText || t.textContent || '') : '';
  }

  function modalVisible(modal){
    if (modal.hidden) return false;
    if (modal.classList && modal.classList.contains('hidden')) return false;
    const cs = window.getComputedStyle ? window.getComputedStyle(modal) : null;
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    return true;
  }

  function mkBtn(id, text, title){
    const b = document.createElement('button');
    b.id = id; b.type = 'button'; b.innerText = text; b.title = title;
    b.style.cssText = 'font-size:11px;padding:2px 6px;margin-left:6px;';
    return b;
  }

  function buildOcrControls(modal, nameInp){
    const status = document.createElement('span');
    status.id = 'rw-ocr-status';
    status.style.cssText = 'font-size:10px;opacity:0.75;margin-left:6px;';

    const boxStatus = document.createElement('span');
    boxStatus.id = 'rw-ocr-box-status';
    boxStatus.style.cssText = 'font-size:10px;opacity:0.75;margin-left:6px;';
    boxStatus.textContent = RW._ocrOverrideBoxN ? 'using custom box ✓' : 'using reference box';

    const clearBtn = mkBtn('rw-ocr-clear-btn', 'Clear Box',
      'Forget the custom OCR box; OCR goes back to using the reference box you drew.');
    clearBtn.onclick = function(e){
      e.preventDefault();
      RW._ocrOverrideBoxN = null;
      RW._ocrSyncBoxStatus();
    };

    const boxBtn = mkBtn('rw-ocr-box-btn', 'OCR Box',
      'Hide this dialog and drag a tighter box directly on the drawing, just for OCR — the reference box itself is unaffected. Esc cancels.');
    boxBtn.onclick = function(e){
      e.preventDefault();
      armOcrBoxDraw(modal);
    };

    const ocrBtn = mkBtn('rw-ocr-btn', 'OCR',
      "Read the printed text inside the active box (custom OCR box if set, else the reference box) and suggest it as the Name (in-browser via Tesseract.js — nothing leaves the browser). Never submits automatically; the field stays editable.");
    ocrBtn.onclick = function(e){
      e.preventDefault();
      RW._ocrRunDetect(nameInp, status);
    };

    // insert in reverse so the final order reads: nameInp, OCR, OCR Box, Clear Box, box-status, status
    nameInp.insertAdjacentElement('afterend', status);
    nameInp.insertAdjacentElement('afterend', boxStatus);
    nameInp.insertAdjacentElement('afterend', clearBtn);
    nameInp.insertAdjacentElement('afterend', boxBtn);
    nameInp.insertAdjacentElement('afterend', ocrBtn);
  }

  RW._ocrMaybeInject = function(modal){
    modal = modal || document.getElementById('reference-prompt-modal');
    if (!modal) return;
    if (!modalVisible(modal)) return;
    if (!RW._ocrIsNewBoxTitle(modalTitleText(modal))) return;
    if (modal.querySelector('#rw-ocr-btn')) return; // idempotent across repeat opens
    const nameInp = modal.querySelector('#reference-prompt-name');
    if (!nameInp) return;
    buildOcrControls(modal, nameInp);
  };

  const modalEl = document.getElementById('reference-prompt-modal');
  if (modalEl && window.MutationObserver){
    const mo = new MutationObserver(() => RW._ocrMaybeInject(modalEl));
    mo.observe(modalEl, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
    RW._ocrMaybeInject(modalEl); // in case it's already open
  }

  /* ---------- crop + recognize ---------- */

  let tesseractPromise = null;
  function ensureTesseract(){
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = RW._ocrTesseractSrc;
      s.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract not found after script load'));
      s.onerror = () => reject(new Error('script load failed'));
      document.head.appendChild(s);
    }).catch(err => { tesseractPromise = null; throw err; });
    return tesseractPromise;
  }

  // Crops #pdf-canvas at boxN (normalized) into a fresh, upscaled canvas.
  // Same white-fill-first + try/catch-tainted-canvas guard as
  // RW._elbowAcquireRaster (rw_elbow.js) — no RW.W involved here, so
  // normalized coords multiply straight into the canvas's own native size.
  RW._ocrCropCanvas = function(boxN){
    try {
      const pdf = document.getElementById('pdf-canvas');
      if (!pdf) return null;
      const { sx, sy, sw, sh } = RW._ocrCropRect(boxN, pdf.width, pdf.height);
      const scale = RW._ocrUpscaleFactor(sw, sh);
      const dw = Math.max(1, Math.round(sw * scale));
      const dh = Math.max(1, Math.round(sh * scale));
      const cv = document.createElement('canvas');
      cv.width = dw; cv.height = dh;
      const ctx = cv.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, dw, dh);
      ctx.drawImage(pdf, sx, sy, sw, sh, 0, 0, dw, dh);
      return cv;
    } catch (e){
      return null;
    }
  };

  RW._ocrRunDetect = async function(nameInp, statusEl){
    function setStatus(msg){ if (statusEl) statusEl.textContent = msg; }

    const boxN = RW._ocrActiveBox();
    if (!boxN){
      setStatus('no box captured — redraw the box');
      return;
    }

    setStatus('loading OCR…');
    let Tesseract;
    try {
      Tesseract = await ensureTesseract();
    } catch (e){
      setStatus("OCR failed to load — blocked by page CSP? Set __RW._ocrTesseractSrc = '<url>' and retry.");
      return;
    }

    const cropCanvas = RW._ocrCropCanvas(boxN);
    if (!cropCanvas){
      setStatus('could not read the drawing canvas for this box');
      return;
    }

    setStatus('recognizing…');
    let result;
    try {
      result = await Tesseract.recognize(cropCanvas, RW._ocrLang, {
        corePath: RW._ocrCorePath,
        langPath: RW._ocrLangPath
      });
    } catch (e){
      setStatus('OCR recognition failed');
      return;
    }

    const text = (result && result.data && result.data.text) || '';
    const { lines, longest } = RW._ocrPickLongestLine(text);
    RW._ocrLastLines = lines;
    if (!longest){
      setStatus('no text recognized');
      return;
    }

    nameInp.value = longest;
    nameInp.dispatchEvent(new Event('input', { bubbles: true }));
    setStatus(lines.length > 1 ? ('"' + longest + '" (' + lines.length + ' lines read)') : ('"' + longest + '"'));
  };
})();
