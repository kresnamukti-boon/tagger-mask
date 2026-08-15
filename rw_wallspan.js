// RW v3.1 — Pipe annotation: a fixed-width path. Click along the centerline
// (multiple points for bends), drag once to measure a fixed width, builds a
// constant-width ribbon. Reads RW.wall only via the Poly2 vertex-snap index,
// for point precision. Full history: CLAUDE.md.
//
// Load LAST (after rw_textdetect.js, needs v2.9).
//
// Elbow fittings: rw_elbow.js, v3.2, press L.
(function(){
  const RW = window.__RW;
  if (!RW || !RW.v29) return 'need v2.9 (rw_textdetect.js) first';
  if (RW.v31) return 'v3.1 already installed';
  RW.v31 = true;

  const ac = document.getElementById('annotation-canvas');

  /* ---------- state ---------- */
  RW.pipeMode      = false;
  RW._pipePts      = [];     // confirmed path points, normalized [nx,ny] page-space
  RW._pipeFinished = false;  // true once double-click has closed off the path
  RW._pipeWidth    = Math.max(3, Math.round(6 * (RW.W/2592))); // mask px
  let downPos = null;         // client {x,y} at mousedown
  let dragging = false;
  let dragCurClient = null;   // live end point of an in-progress width-measure drag

  RW._fmtWidth = function(v){
    return (Math.round(v*100)/100).toString();
  };

  /* ---------- geometry: path + width -> closed ribbon polygon ---------- */
  // ptsN: [nx,ny] normalized points, widthPx: mask-px width. Returns {x,y}
  // normalized points or null.
  //
  // Walk one rail forward, the other rail backward, close into one loop.
  // Interior vertices use a scaled-average-perpendicular miter join, falling
  // back to a true bevel (two separate points, one per segment's own
  // perpendicular) past MITER_LIMIT.
  const MITER_LIMIT = 4;
  function analyticPipeRibbon(ptsN, widthPx){
    const {W,H} = RW;
    const pts = ptsN.map(([nx,ny]) => [nx*W, ny*H]);
    const clean = [pts[0]];
    for (let i=1;i<pts.length;i++){
      const [px,py] = clean[clean.length-1], [x,y] = pts[i];
      if (Math.hypot(x-px, y-py) > 1e-6) clean.push(pts[i]);
    }
    if (clean.length < 2) return null;
    const n = clean.length;
    const half = widthPx/2;

    const perp = [];
    for (let i=0;i<n-1;i++){
      const [x1,y1] = clean[i], [x2,y2] = clean[i+1];
      const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy) || 1e-6;
      perp.push([-dy/len, dx/len]);
    }

    const left = [], right = [];
    left.push([clean[0][0]+perp[0][0]*half, clean[0][1]+perp[0][1]*half]);
    right.push([clean[0][0]-perp[0][0]*half, clean[0][1]-perp[0][1]*half]);

    for (let i=1;i<n-1;i++){
      const p1 = perp[i-1], p2 = perp[i];
      const [vx,vy] = clean[i];
      let ax = p1[0]+p2[0], ay = p1[1]+p2[1];
      const alen = Math.hypot(ax,ay);
      let bevel = alen < 1e-6;
      let mx=0, my=0;
      if (!bevel){
        ax/=alen; ay/=alen;
        const dot = ax*p2[0] + ay*p2[1];
        const scale = Math.abs(dot) > 1e-6 ? 1/dot : Infinity;
        if (Math.abs(scale) > MITER_LIMIT) bevel = true;
        else { mx = ax*scale; my = ay*scale; }
      }
      if (bevel){
        left.push([vx+p1[0]*half, vy+p1[1]*half], [vx+p2[0]*half, vy+p2[1]*half]);
        right.push([vx-p1[0]*half, vy-p1[1]*half], [vx-p2[0]*half, vy-p2[1]*half]);
      } else {
        left.push([vx+mx*half, vy+my*half]);
        right.push([vx-mx*half, vy-my*half]);
      }
    }

    left.push([clean[n-1][0]+perp[n-2][0]*half, clean[n-1][1]+perp[n-2][1]*half]);
    right.push([clean[n-1][0]-perp[n-2][0]*half, clean[n-1][1]-perp[n-2][1]*half]);

    const loop = left.concat(right.reverse());
    return loop.map(([x,y]) => ({x:+(x/W).toFixed(6), y:+(y/H).toFixed(6)}));
  }

  RW._pipeRibbon = function(ptsN, widthPx){
    if (!ptsN || ptsN.length < 2 || !(widthPx > 0)) return null;
    const {W,H} = RW;
    const clean = [ptsN[0]];
    for (let i=1;i<ptsN.length;i++){
      const [px,py] = clean[clean.length-1], [x,y] = ptsN[i];
      if (Math.hypot((x-px)*W, (y-py)*H) > 1e-6) clean.push(ptsN[i]);
    }
    if (clean.length < 2) return null;
    return analyticPipeRibbon(clean, widthPx);
  };

  /* ---------- sanity check before commit ---------- */
  RW._pipeSanityCheck = function(ptsN, widthPx){
    if (!ptsN || ptsN.length < 2) return 'need at least a start and finish point';
    if (!(widthPx > 0)) return 'width must be greater than 0 — drag across the pipe to measure it';
    return null;
  };

  /* ---------- click / drag / finish state machine ---------- */
  ac.addEventListener('mousedown', function(e){
    if (!RW.pipeMode) return;
    e.stopPropagation(); e.preventDefault();
    downPos = {x:e.clientX, y:e.clientY};
    dragging = false;
    dragCurClient = null;
  }, true);

  ac.addEventListener('mousemove', function(e){
    if (!RW.pipeMode) return;
    e.stopPropagation();
    if (downPos && !RW._pipeFinished){
      const d = Math.hypot(e.clientX-downPos.x, e.clientY-downPos.y);
      if (d > 5){
        dragging = true;
        dragCurClient = {x:e.clientX, y:e.clientY};
        RW._renderPipePreview(e.clientX, e.clientY);
        return;
      }
    }
    RW._renderPipePreview(e.clientX, e.clientY);
  }, true);

  ac.addEventListener('mouseup', function(e){
    if (!RW.pipeMode) return;
    e.stopPropagation(); e.preventDefault();
    const d = downPos; downPos = null;
    if (!d) return;
    const dist = Math.hypot(e.clientX-d.x, e.clientY-d.y);
    if (dragging || dist > 5){
      const [ax,ay] = RW._toNorm(d.x, d.y), [bx,by] = RW._toNorm(e.clientX, e.clientY);
      const mx1=ax*RW.W, my1=ay*RW.H, mx2=bx*RW.W, my2=by*RW.H;
      const w = Math.hypot(mx2-mx1, my2-my1);
      if (w > 0.5){
        RW._pipeWidth = w;
        const inp = document.getElementById('rw-pipe-width'); if (inp) inp.value = RW._fmtWidth(w);
      }
      dragging = false; dragCurClient = null;
      RW._renderPipePreview(e.clientX, e.clientY);
      return;
    }
    if (RW._pipeFinished){ RW._pipePts = []; RW._pipeFinished = false; }
    let [nx,ny] = RW._toNorm(e.clientX, e.clientY);
    if (RW._trySnap && !e.shiftKey){ const s = RW._trySnap(nx,ny); nx=s[0]; ny=s[1]; }
    RW._pipePts.push([nx,ny]);
    RW._renderPipePreview(e.clientX, e.clientY);
    RW._syncPipeBtns();
  }, true);

  ac.addEventListener('dblclick', function(e){
    if (!RW.pipeMode) return;
    e.stopPropagation(); e.preventDefault();
    if (RW._pipePts.length >= 2){
      RW._pipeFinished = true;
      RW._renderPipePreview(e.clientX, e.clientY);
      RW._commitStatus('pipe path finished (' + RW._pipePts.length + ' points) — Trace to preview, Commit Pipe to stage');
    }
    RW._syncPipeBtns();
  }, true);

  ac.addEventListener('click', function(e){
    if (RW.pipeMode){ e.stopPropagation(); e.preventDefault(); }
  }, true);

  window.addEventListener('keydown', function(e){
    const t = e.target;
    if (t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (!RW.pipeMode) return;
    if (e.key==='Escape'){
      e.preventDefault(); e.stopImmediatePropagation();
      if (RW._pipePts.length){
        RW._pipePts = []; RW._pipeFinished = false;
        RW._renderPipePreview(null, null);
        RW._commitStatus('');
      } else {
        RW.setPipeMode(false);
      }
    }
    if (e.key==='Backspace' && !RW._pipeFinished){
      e.preventDefault(); e.stopImmediatePropagation();
      if (RW._pipePts.length) RW._pipePts.pop();
      RW._renderPipePreview(null, null);
    }
  }, true);

  window.addEventListener('keydown', function(e){
    const t = e.target;
    if (t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (e.ctrlKey||e.metaKey||e.altKey) return;
    if (e.key==='c'||e.key==='C'){
      e.preventDefault(); e.stopImmediatePropagation();
      RW.setPipeMode(!RW.pipeMode);
    }
  }, true);

  /* ---------- preview rendering ---------- */
  RW._renderPipePreview = function(clientX, clientY){
    const old = document.getElementById('rw-pipe-preview'); if (old) old.remove();
    if (!RW.pipeMode) return;

    if (dragging && dragCurClient && downPos){
      const svg = RW._mkSvg('rw-pipe-preview', 71);
      svg.innerHTML = '<line x1="'+downPos.x+'" y1="'+downPos.y+'" x2="'+dragCurClient.x+'" y2="'+dragCurClient.y
        + '" stroke="#ff8c00" stroke-width="2" stroke-dasharray="4,3"/>';
      const [ax,ay] = RW._toNorm(downPos.x, downPos.y), [bx,by] = RW._toNorm(dragCurClient.x, dragCurClient.y);
      const liveW = Math.hypot((bx-ax)*RW.W, (by-ay)*RW.H);
      RW._commitStatus('width: ' + RW._fmtWidth(liveW) + 'px (release to set)');
      return;
    }

    const pts = RW._pipePts.slice();
    if (!RW._pipeFinished && clientX != null && pts.length){
      const [nx,ny] = RW._toNorm(clientX, clientY);
      pts.push([nx,ny]);
    }
    if (pts.length < 2){
      if (pts.length===1){
        const svg = RW._mkSvg('rw-pipe-preview', 71);
        const [px,py] = RW._toPx(pts[0][0], pts[0][1]);
        svg.innerHTML = '<circle cx="'+px+'" cy="'+py+'" r="4" fill="#ff8c00"/>';
      }
      return;
    }
    const ribbon = RW._pipeRibbon(pts, RW._pipeWidth);
    if (!ribbon) return;
    const svg = RW._mkSvg('rw-pipe-preview', 71);
    const poly = ribbon.map(p => { const [px,py]=RW._toPx(p.x,p.y); return px+','+py; }).join(' ');
    const centerline = pts.map(([nx,ny]) => { const [px,py]=RW._toPx(nx,ny); return px+','+py; }).join(' ');
    svg.innerHTML = '<polygon points="'+poly+'" fill="rgba(255,140,0,0.22)" stroke="#ff8c00" stroke-width="1.5"/>'
      + '<polyline points="'+centerline+'" fill="none" stroke="#ff8c00" stroke-width="1" stroke-dasharray="3,3"/>';
    if (!RW._pipeFinished){
      RW._commitStatus('pipe: ' + (RW._pipePts.length) + ' point' + (RW._pipePts.length===1?'':'s')
        + ' · width ' + RW._fmtWidth(RW._pipeWidth) + 'px · double-click to finish');
    }
  };

  RW._renderPipeTrace = function(){
    if (!RW._pipeFinished || RW._pipePts.length < 2){
      RW._commitStatus('finish the path first (double-click), then Trace');
      return;
    }
    const ribbon = RW._pipeRibbon(RW._pipePts, RW._pipeWidth);
    const old = document.getElementById('rw-pipe-preview'); if (old) old.remove();
    const svg = RW._mkSvg('rw-pipe-preview', 76);
    const poly = ribbon.map(p => { const [px,py]=RW._toPx(p.x,p.y); return px+','+py; }).join(' ');
    svg.innerHTML = '<polygon points="'+poly+'" fill="rgba(255,140,0,0.28)" stroke="#ff8c00" stroke-width="2"/>';
    RW._commitStatus('traced: ' + ribbon.length + ' pts · width ' + RW._fmtWidth(RW._pipeWidth) + 'px — Commit Pipe to stage');
  };

  RW.commitPipe = async function(){
    if (!annotationState.currentTag){
      RW._commitStatus('no active tag — press a tag number first'); return;
    }
    const problem = RW._pipeSanityCheck(RW._pipePts, RW._pipeWidth);
    if (problem){ RW._commitStatus('refused: ' + problem); return; }
    const ribbon = RW._pipeRibbon(RW._pipePts, RW._pipeWidth);
    if (!ribbon || ribbon.length < 4){ RW._commitStatus('refused: could not build a ribbon from this path'); return; }
    const a = RW._createPendingAnnotation(ribbon, 'pipe width: ' + RW._pipeWidth.toFixed(2) + ' px');
    await RW._forceRender();
    RW._lastCommit = [a];
    RW.clearPipe({keepStatus:true});
    RW._commitStatus('staged 1 pipe (' + ribbon.length + ' pts, width ' + RW._fmtWidth(RW._pipeWidth) + 'px)'
      + ' — review and Save. To remove it before Save, select it in the app and press Delete.'
      + ' Got an elbow fitting to mark? Press L.');
  };

  RW.clearPipe = function(opts){
    RW._pipePts = [];
    RW._pipeFinished = false;
    const old = document.getElementById('rw-pipe-preview'); if (old) old.remove();
    if (!opts || !opts.keepStatus) RW._commitStatus('');
    RW._syncPipeBtns();
  };

  /* ---------- mode arm/disarm, cross-disarm both directions ---------- */
  RW.setPipeMode = function(on){
    if (on){
      if (RW.maskMode){
        RW.maskMode=null; ac.style.cursor='';
        const rl=document.getElementById('rw-rectline'); if(rl) rl.remove();
        if (RW._syncRectBtn) RW._syncRectBtn();
      }
      if (RW.maskMode2)     RW.setMaskMode2(null);
      if (RW.healBrushMode) RW.setHealBrushMode(false);
      if (RW.pickMode)      RW.setPick(false);
      if (RW.cutMode)       RW.setCut(false);
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      const popup=document.getElementById('selection-popup'); if (popup) popup.style.display='none';
      RW._commitStatus('pipe mode: click to place points (double-click to finish), drag to measure width');
    }
    RW.pipeMode = !!on;
    ac.style.cursor = on ? 'crosshair' : '';
    if (!on) RW.clearPipe();
    RW._syncPipeBtns();
  };

  ['setPick','setCut','setMaskMode2','setHealBrushMode'].forEach(fn=>{
    const orig = RW[fn];
    if (typeof orig !== 'function') return;
    RW[fn] = function(arg){
      if (arg && RW.pipeMode) RW.setPipeMode(false);
      return orig.apply(RW, arguments);
    };
  });
  if (RW._syncRectBtn){
    const origSyncRectBtn = RW._syncRectBtn;
    RW._syncRectBtn = function(){
      origSyncRectBtn.apply(RW, arguments);
      if (RW.maskMode==='rect' && RW.pipeMode) RW.setPipeMode(false);
    };
  }

  /* ---------- panel ---------- */
  const bar = (document.getElementById('rw-pick') || {}).parentNode;
  if (bar && !document.getElementById('rw-pipe-group')){
    const group = document.createElement('span');
    group.id = 'rw-pipe-group';

    const b = document.createElement('button');
    b.id = 'rw-pipe';
    b.title = 'Click points along a pipe\'s centerline (double-click to finish); drag anywhere to measure a fixed width off the drawing. Builds a constant-width ribbon regardless of text/fittings crossing the line. Escape clears, Backspace drops the last point. Elbow fittings get their own tool — press L.';
    b.style.cssText = 'font-size:11px;padding:2px 6px;';
    b.innerText = 'Pipe (C)';
    b.onclick = () => RW.setPipeMode(!RW.pipeMode);
    group.appendChild(b);

    const traceBtn = document.createElement('button');
    traceBtn.id = 'rw-pipe-trace';
    traceBtn.title = 'Preview the exact ribbon polygon that would be committed.';
    traceBtn.style.cssText = 'font-size:11px;padding:2px 6px;';
    traceBtn.innerText = 'Trace';
    traceBtn.onclick = () => RW._renderPipeTrace();
    group.appendChild(traceBtn);

    const commitBtn = document.createElement('button');
    commitBtn.id = 'rw-pipe-commit';
    commitBtn.title = 'Stage the finished path as a pending polygon annotation.';
    commitBtn.style.cssText = 'font-size:11px;padding:2px 6px;background:rgba(255,140,0,0.25);';
    commitBtn.innerText = 'Commit Pipe';
    commitBtn.onclick = () => RW.commitPipe();
    group.appendChild(commitBtn);

    const label1 = document.createElement('span');
    label1.innerText = 'width'; label1.style.cssText = 'font-size:10px;opacity:0.7;margin-left:4px;';
    group.appendChild(label1);
    const widthInp = document.createElement('input');
    widthInp.id = 'rw-pipe-width';
    widthInp.type = 'number'; widthInp.value = RW._fmtWidth(RW._pipeWidth); widthInp.step = 'any';
    widthInp.title = 'Ribbon width in mask px. Set by dragging across the pipe in the drawing, or type a value directly.';
    widthInp.style.cssText = 'font-size:11px;padding:1px 4px;width:44px;text-align:right;';
    widthInp.onchange = function(){
      const v = parseFloat(widthInp.value);
      if (isNaN(v) || v<=0) return;
      RW._pipeWidth = v;
      if (RW._pipeFinished) RW._renderPipeTrace();
      else RW._renderPipePreview(null, null);
    };
    group.appendChild(widthInp);

    bar.appendChild(group);
  }

  RW._syncPipeBtns = function(){
    const b = document.getElementById('rw-pipe');
    if (b) b.style.background = RW.pipeMode ? 'rgba(255,140,0,0.35)' : '';
    const t = document.getElementById('rw-pipe-trace');
    if (t) t.disabled = !RW._pipeFinished;
    const c = document.getElementById('rw-pipe-commit');
    if (c) c.disabled = !RW._pipeFinished;
  };
  RW._syncPipeBtns();

  const hideBtn = document.getElementById('rw-hide');
  if (hideBtn){
    const origHideClick = hideBtn.onclick;
    hideBtn.onclick = function(){
      if (origHideClick) origHideClick.apply(this, arguments);
      const el = document.getElementById('rw-pipe-preview');
      if (el) el.style.display = (el.style.display==='none') ? '' : 'none';
    };
  }

  return 'v3.1 up: Pipe annotation — click a path (double-click to finish), drag to measure width, Trace/Commit Pipe';
})()
