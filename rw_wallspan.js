// RW v3.1 — Pipe annotation: a fixed-width path. Click along the centerline
// (multiple points for bends), drag once to measure a fixed width, builds a
// constant-width ribbon. Reads RW.wall only via the Poly2 vertex-snap index,
// for point precision. Double-click finishes a segment and immediately
// starts the next, so a branch can snap onto a previous segment's centerline
// (an end connects at the tip, a mid-span click tees onto the side) — this
// works even before Commit Pipe, and against already-committed pipes too.
// Commit Pipe batches every segment from this session into one action;
// segments connected via snapping merge into one combined polygon (raster
// union + re-trace), unstaged network only.
// Full history: CLAUDE.md.
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
  RW._pipeWidth    = Math.max(3, Math.round(6 * (RW.W/2592))); // mask px
  RW._pipeNetwork  = [];      // finished-but-unstaged segments this session: {ptsN, widthPx, ribbon, links}
  RW._pipePendingLinks = [];  // parallel to RW._pipePts: a RW._pipeNetwork index or null per placed point
  RW._pipeSnapHit  = null;     // side-channel result of the last _tryPipeSnap call
  RW._pipeSnapEnabled = true;
  RW._pipeCommitting  = false; // re-entrancy guard for commitPipe
  RW._pipeMergeRes    = 4;      // local raster px per mask px, for merging connected segments
  RW._pipeMergeBudget = 12_000_000; // local raster px cap
  let downPos = null;         // client {x,y} at mousedown
  let dragging = false;
  let dragCurClient = null;   // live end point of an in-progress width-measure drag
  let shiftHeld = false;

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
  // perpendicular) past MITER_LIMIT. Every interior vertex pushes exactly 1
  // point to each rail (miter) or 2 to each rail (bevel), so left.length ===
  // right.length always (call it k) and the closed ribbon
  // (left.concat(right.reverse())) always has even length 2k, with
  // midpoint(ribbon[i], ribbon[2k-1-i]) === the original centerline vertex i
  // for every i — this is what RW._pipeCenterlineFromRibbon below relies on.
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

  // Consecutive-duplicate removal, in mask-px terms.
  RW._pipeDedupe = function(ptsN){
    if (!ptsN || !ptsN.length) return [];
    const {W,H} = RW;
    const clean = [ptsN[0]];
    for (let i=1;i<ptsN.length;i++){
      const [px,py] = clean[clean.length-1], [x,y] = ptsN[i];
      if (Math.hypot((x-px)*W, (y-py)*H) > 1e-6) clean.push(ptsN[i]);
    }
    return clean;
  };

  RW._pipeRibbon = function(ptsN, widthPx){
    if (!ptsN || ptsN.length < 2 || !(widthPx > 0)) return null;
    const clean = RW._pipeDedupe(ptsN);
    if (clean.length < 2) return null;
    return analyticPipeRibbon(clean, widthPx);
  };

  // Recovers the original centerline from a ribbon polygon built by
  // analyticPipeRibbon: for a ring of even length 2k, midpoint(ring[i],
  // ring[2k-1-i]) is the original centerline vertex i, for every i in
  // 0..k-1. Returns [[nx,ny],...] (length k, deduping any coincident pair)
  // or null if `ring` isn't a valid even-length array of >=4 {x,y} points.
  RW._pipeCenterlineFromRibbon = function(ring){
    if (!Array.isArray(ring) || ring.length < 4 || (ring.length % 2)) return null;
    const k = ring.length / 2;
    const out = [];
    for (let i=0;i<k;i++){
      const a = ring[i], b = ring[ring.length-1-i];
      if (!a || !b || typeof a.x !== 'number' || typeof a.y !== 'number'
          || typeof b.x !== 'number' || typeof b.y !== 'number') return null;
      const p = [(a.x+b.x)/2, (a.y+b.y)/2];
      const q = out[out.length-1];
      if (!q || Math.hypot((p[0]-q[0])*RW.W, (p[1]-q[1])*RW.H) > 1e-6) out.push(p);
    }
    return out.length >= 2 ? out : null;
  };

  /* ---------- sanity check before commit ---------- */
  RW._pipeSanityCheck = function(ptsN, widthPx){
    if (!ptsN || ptsN.length < 2) return 'need at least a start and finish point';
    if (!(widthPx > 0)) return 'width must be greater than 0 — drag across the pipe to measure it';
    return null;
  };

  /* ---------- pipe-to-pipe snapping ---------- */
  RW._pipeCatchPx = function(){
    try { if (RW._snapCatchPx) return RW._snapCatchPx(); } catch(e){}
    return Math.max(4, RW.W/200);
  };

  // Every centerline the current point may connect to: this session's
  // finished-but-unstaged segments, plus every already-committed pipe-tagged
  // annotation (identified by the 'pipe width: ' notes prefix — the only
  // existing marker, same 4-gate discipline every annotation reader in this
  // codebase already uses). Excludes the in-progress RW._pipePts.
  RW._pipeSnapCandidates = function(){
    const out = [];
    for (let i=0;i<RW._pipeNetwork.length;i++){
      const s = RW._pipeNetwork[i];
      if (s && s.ptsN && s.ptsN.length >= 2) out.push({ptsN:s.ptsN, widthPx:s.widthPx, src:'network', ref:i});
    }
    if (typeof annotationState === 'undefined' || !annotationState || !annotationState.annotations) return out;
    for (const a of annotationState.annotations){
      if (a._hidden || a.is_void) continue;
      const pts = a.coordinates; if (!Array.isArray(pts) || pts.length < 3) continue;
      if (typeof a.notes !== 'string' || a.notes.indexOf('pipe width: ') !== 0) continue;
      const cl = RW._pipeCenterlineFromRibbon(pts);
      if (!cl) continue;
      const m = /^pipe width:\s*([0-9.]+)/.exec(a.notes);
      const w = m ? parseFloat(m[1]) : NaN;
      out.push({ptsN:cl, widthPx:(isFinite(w) && w>0) ? w : 0, src:'annotation', ref:a.id});
    }
    return out;
  };

  // nx,ny normalized. Contract mirrors RW._trySnap: ALWAYS returns [nx,ny];
  // the hit (or null) lands in the RW._pipeSnapHit side channel. Projects
  // onto each candidate's centerline (clamped point-to-segment) — the clamp
  // at t=0/t=1 IS the end-to-end-connection case, no separate code path.
  RW._tryPipeSnap = function(nx, ny){
    RW._pipeSnapHit = null;
    if (!RW._pipeSnapEnabled || RW._snapEnabled === false) return [nx, ny];
    const cands = RW._pipeSnapCandidates();
    if (!cands.length) return [nx, ny];
    const mx = nx*RW.W, my = ny*RW.H;
    const catchPx = RW._pipeCatchPx();
    let best = null;
    for (const c of cands){
      const halfPx = c.widthPx > 0 ? c.widthPx/2 : 0;
      const rad = catchPx + halfPx;
      const last = c.ptsN.length - 2;
      for (let i=0;i<=last;i++){
        const ax = c.ptsN[i][0]*RW.W,   ay = c.ptsN[i][1]*RW.H;
        const bx = c.ptsN[i+1][0]*RW.W, by = c.ptsN[i+1][1]*RW.H;
        const dx = bx-ax, dy = by-ay, len2 = dx*dx + dy*dy;
        if (len2 < 1e-12) continue;
        let t = ((mx-ax)*dx + (my-ay)*dy) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const fx = ax + t*dx, fy = ay + t*dy;
        const d = Math.hypot(fx-mx, fy-my);
        if (d > rad) continue;
        const rank = (d <= halfPx) ? 0 : 1; // inside the body beats merely near
        if (!best || rank < best.rank || (rank === best.rank && d < best.dist)){
          best = { x:fx, y:fy, nx:fx/RW.W, ny:fy/RW.H, dist:d, rank:rank,
                    inside:(rank===0),
                    atEnd:((i===0 && t===0) || (i===last && t===1)),
                    src:c.src, ref:c.ref, widthPx:c.widthPx };
        }
      }
    }
    if (!best) return [nx, ny];
    RW._pipeSnapHit = best;
    return [best.nx, best.ny];
  };

  /* ---------- finishing a path: push into the network, ready for the next ---------- */
  RW._pipeFinishPath = function(){
    if (RW._pipePts.length < 2) return false;
    const ptsN = RW._pipeDedupe(RW._pipePts);
    const ribbon = RW._pipeRibbon(ptsN, RW._pipeWidth);
    if (!ribbon || ribbon.length < 4){
      RW._commitStatus('need two distinct points — keep clicking, or Escape to clear');
      return false;
    }
    const links = [];
    const seen = new Set();
    for (const l of RW._pipePendingLinks){
      if (Number.isInteger(l) && l >= 0 && l < RW._pipeNetwork.length && !seen.has(l)){
        seen.add(l); links.push(l);
      }
    }
    RW._pipeNetwork.push({ ptsN: ptsN, widthPx: RW._pipeWidth, ribbon: ribbon, links: links });
    RW._pipePts = [];
    RW._pipePendingLinks = [];
    RW._pipeSnapHit = null;
    const n = RW._pipeNetwork.length;
    RW._commitStatus('segment finished · ' + n + ' pending — click to start a branch '
      + '(clicking on or near an existing pipe connects to it), or Commit Pipe to stage all ' + n);
    return true;
  };

  // RW._pipeNetwork is append-only within a session (push or reset to []), so
  // every recorded link index stays valid for the network's lifetime.
  RW._pipeGroups = function(segs){
    const n = segs.length;
    const parent = Array.from({length:n}, (_,i)=>i);
    function find(x){ while (parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; }
    function union(a,b){ const ra=find(a), rb=find(b); if (ra!==rb) parent[ra]=rb; }
    for (let i=0;i<n;i++){
      const links = (segs[i] && segs[i].links) || [];
      for (const l of links){
        if (Number.isInteger(l) && l >= 0 && l < n && l !== i) union(i, l);
      }
    }
    const byRoot = new Map();
    for (let i=0;i<n;i++){
      const r = find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(i);
    }
    const groups = Array.from(byRoot.values());
    groups.forEach(g => g.sort((a,b)=>a-b));
    groups.sort((a,b)=>a[0]-b[0]);
    return groups;
  };

  // 8-connected flood-fill from (x0,y0); returns the reached-pixel count.
  function flood8(mask, w, h, x0, y0){
    const seen = new Uint8Array(w*h);
    const stack = [y0*w + x0];
    seen[y0*w + x0] = 1;
    let count = 0;
    while (stack.length){
      const idx = stack.pop();
      count++;
      const x = idx % w, y = (idx - x) / w;
      for (let dy=-1; dy<=1; dy++){
        for (let dx=-1; dx<=1; dx++){
          if (!dx && !dy) continue;
          const nx = x+dx, ny = y+dy;
          if (nx<0 || ny<0 || nx>=w || ny>=h) continue;
          const nidx = ny*w+nx;
          if (seen[nidx] || !mask[nidx]) continue;
          seen[nidx] = 1;
          stack.push(nidx);
        }
      }
    }
    return count;
  }

  // Raster-union + re-trace a connected group of RW._pipeNetwork segments into
  // one combined polygon. Returns {poly, meta} or {error, meta}.
  RW._pipeMergeGroup = function(segs){
    const {W,H} = RW;
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    let maxHalf = 0;
    for (const seg of segs){
      if (!seg || !Array.isArray(seg.ribbon)) return {error:'missing ribbon', meta:{}};
      maxHalf = Math.max(maxHalf, (seg.widthPx||0)/2);
      for (const p of seg.ribbon){
        const x = p.x*W, y = p.y*H;
        if (!isFinite(x) || !isFinite(y)) return {error:'non-finite point', meta:{}};
        if (x<minX) minX=x; if (x>maxX) maxX=x;
        if (y<minY) minY=y; if (y>maxY) maxY=y;
      }
    }
    if (!(maxX>minX) || !(maxY>minY)) return {error:'degenerate bounding box', meta:{}};

    const rawW = maxX-minX, rawH = maxY-minY;
    const area = rawW*rawH;
    const scale = Math.min(RW._pipeMergeRes, Math.sqrt(RW._pipeMergeBudget / Math.max(1, area)));
    if (!(scale >= 1)) return {error:'network too large to merge', meta:{scale:scale}};
    if (maxHalf*2*scale < 2) return {error:'too thin to merge at this scale', meta:{scale:scale}};

    const pad = Math.max(4, Math.round(4*scale));
    const localW = Math.max(1, Math.round(rawW*scale)) + pad*2;
    const localH = Math.max(1, Math.round(rawH*scale)) + pad*2;
    const mask = new Uint8Array(localW*localH);

    function toLocal(nx, ny){
      return [ (nx*W - minX)*scale + pad, (ny*H - minY)*scale + pad ];
    }
    for (const seg of segs){
      const localPts = seg.ribbon.map(p => toLocal(p.x, p.y));
      RW._rasterizePolyLocal(localPts, localW, localH, mask);
    }

    let seedIdx = -1, total = 0;
    for (let i=0;i<mask.length;i++){ if (mask[i]){ total++; if (seedIdx<0) seedIdx=i; } }
    if (seedIdx < 0) return {error:'empty raster', meta:{}};
    const seedX = seedIdx % localW, seedY = (seedIdx - seedX) / localW;
    const reached = flood8(mask, localW, localH, seedX, seedY);
    if (reached !== total){
      return {error:'segments do not actually touch after rasterizing', meta:{reached:reached, total:total}};
    }

    const poly = RW._maskToPolygon(mask, {
      W: localW, H: localH, seed: {x:seedX, y:seedY}, smoothPasses: 1, eps: 0.8
    });
    if (!poly || poly.length < 3) return {error:'trace failed', meta:{}};

    const out = poly.map(p => ({
      x: +(((p.x*localW - pad)/scale + minX)/W).toFixed(6),
      y: +(((p.y*localH - pad)/scale + minY)/H).toFixed(6)
    }));
    return { poly: out, meta: { scale:scale, localW:localW, localH:localH, pixels: total } };
  };

  /* ---------- click / drag / finish state machine ---------- */
  ac.addEventListener('mousedown', function(e){
    if (!RW.pipeMode) return;
    e.stopPropagation(); e.preventDefault();
    shiftHeld = e.shiftKey;
    downPos = {x:e.clientX, y:e.clientY};
    dragging = false;
    dragCurClient = null;
  }, true);

  ac.addEventListener('mousemove', function(e){
    if (!RW.pipeMode) return;
    e.stopPropagation();
    shiftHeld = e.shiftKey;
    if (downPos){
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
    shiftHeld = e.shiftKey;
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
    let [nx,ny] = RW._toNorm(e.clientX, e.clientY);
    if (!e.shiftKey){
      const rawX = nx*RW.W, rawY = ny*RW.H;
      let winner = null, winnerD = Infinity, winnerInside = false;
      const p = RW._tryPipeSnap(nx, ny);
      if (RW._pipeSnapHit){ winner = p; winnerD = RW._pipeSnapHit.dist; winnerInside = RW._pipeSnapHit.inside; }
      if (RW._trySnap){
        const s = RW._trySnap(nx, ny); // called unconditionally: keeps _lastSnapHit honest
        if (RW._lastSnapHit){
          const d = Math.hypot(RW._lastSnapHit.x - rawX, RW._lastSnapHit.y - rawY);
          if (!winner || (!winnerInside && d < winnerD)){ winner = s; RW._pipeSnapHit = null; }
        }
      }
      if (winner){ nx = winner[0]; ny = winner[1]; }
    } else {
      RW._pipeSnapHit = null;
    }
    let link = null;
    if (!e.shiftKey && RW._pipeSnapHit && RW._pipeSnapHit.src === 'network'
        && Number.isInteger(RW._pipeSnapHit.ref)
        && RW._pipeSnapHit.ref >= 0 && RW._pipeSnapHit.ref < RW._pipeNetwork.length){
      link = RW._pipeSnapHit.ref;
    }
    RW._pipePts.push([nx,ny]);
    RW._pipePendingLinks.push(link);
    RW._renderPipePreview(e.clientX, e.clientY);
    RW._syncPipeBtns();
  }, true);

  ac.addEventListener('dblclick', function(e){
    if (!RW.pipeMode) return;
    e.stopPropagation(); e.preventDefault();
    RW._pipeFinishPath();
    RW._renderPipePreview(e.clientX, e.clientY);
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
        RW._pipePts = []; RW._pipePendingLinks = []; RW._pipeSnapHit = null;
        RW._renderPipePreview(null, null);
        RW._commitStatus(RW._pipeNetwork.length
          ? ('cleared the in-progress path — ' + RW._pipeNetwork.length + ' finished segment'
             + (RW._pipeNetwork.length===1?'':'s') + ' still pending')
          : '');
        RW._syncPipeBtns();
      } else if (RW._pipeNetwork.length){
        const n = RW._pipeNetwork.length;
        RW._pipeNetwork = []; RW._pipeSnapHit = null;
        RW._renderPipePreview(null, null);
        RW._commitStatus('discarded ' + n + ' unstaged pipe segment' + (n===1?'':'s'));
        RW._syncPipeBtns();
      } else {
        RW.setPipeMode(false);
      }
    }
    if (e.key==='Backspace'){
      e.preventDefault(); e.stopImmediatePropagation();
      if (RW._pipePts.length){ RW._pipePts.pop(); RW._pipePendingLinks.pop(); }
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
  function polyPx(ribbon){
    return ribbon.map(p => { const [px,py]=RW._toPx(p.x,p.y); return px+','+py; }).join(' ');
  }
  function linePx(ptsN){
    return ptsN.map(([nx,ny]) => { const [px,py]=RW._toPx(nx,ny); return px+','+py; }).join(' ');
  }
  function pipeMarkerSvg(hit){
    const [px,py] = RW._toPx(hit.nx, hit.ny);
    let s = '<circle cx="'+px+'" cy="'+py+'" r="7" fill="none" stroke="#ffffff" stroke-width="2.5"'
      + (hit.inside ? '' : ' stroke-dasharray="3,2"') + '/>';
    s += '<circle cx="'+px+'" cy="'+py+'" r="7" fill="none" stroke="#ff2d95" stroke-width="1.25"'
      + (hit.inside ? '' : ' stroke-dasharray="3,2"') + '/>';
    if (hit.atEnd){
      s += '<line x1="'+(px-5)+'" y1="'+py+'" x2="'+(px+5)+'" y2="'+py+'" stroke="#ff2d95" stroke-width="1.5"/>';
      s += '<line x1="'+px+'" y1="'+(py-5)+'" x2="'+px+'" y2="'+(py+5)+'" stroke="#ff2d95" stroke-width="1.5"/>';
    } else {
      s += '<circle cx="'+px+'" cy="'+py+'" r="2.5" fill="#ff2d95"/>';
    }
    return s;
  }

  RW._renderPipePreview = function(clientX, clientY){
    const old = document.getElementById('rw-pipe-preview'); if (old) old.remove();
    if (!RW.pipeMode) return;
    const parts = [];
    let status = null;

    for (const seg of RW._pipeNetwork){
      parts.push('<polygon points="'+ polyPx(seg.ribbon) +'" fill="rgba(255,140,0,0.16)" '
        + 'stroke="#ff8c00" stroke-width="1" stroke-opacity="0.85"/>');
      parts.push('<polyline points="'+ linePx(seg.ptsN) +'" fill="none" stroke="#ff8c00" '
        + 'stroke-width="1" stroke-opacity="0.45" stroke-dasharray="2,4"/>');
    }

    if (dragging && dragCurClient && downPos){
      parts.push('<line x1="'+downPos.x+'" y1="'+downPos.y+'" x2="'+dragCurClient.x+'" y2="'+dragCurClient.y
        + '" stroke="#ff8c00" stroke-width="2" stroke-dasharray="4,3"/>');
      const [ax,ay] = RW._toNorm(downPos.x, downPos.y), [bx,by] = RW._toNorm(dragCurClient.x, dragCurClient.y);
      const liveW = Math.hypot((bx-ax)*RW.W, (by-ay)*RW.H);
      status = 'width: ' + RW._fmtWidth(liveW) + 'px (release to set)';
    } else {
      const pts = RW._pipePts.slice();
      if (clientX != null){
        let [cnx,cny] = RW._toNorm(clientX, clientY);
        if (!shiftHeld){ const p = RW._tryPipeSnap(cnx,cny); cnx=p[0]; cny=p[1]; }
        else RW._pipeSnapHit = null;
        if (pts.length) pts.push([cnx,cny]);
      }
      if (pts.length < 2){
        if (pts.length===1){
          const [px,py] = RW._toPx(pts[0][0], pts[0][1]);
          parts.push('<circle cx="'+px+'" cy="'+py+'" r="4" fill="#ff8c00"/>');
        }
      } else {
        const ribbon = RW._pipeRibbon(pts, RW._pipeWidth);
        if (ribbon){
          parts.push('<polygon points="'+polyPx(ribbon)+'" fill="rgba(255,140,0,0.22)" stroke="#ff8c00" stroke-width="1.5"/>');
          parts.push('<polyline points="'+linePx(pts)+'" fill="none" stroke="#ff8c00" stroke-width="1" stroke-dasharray="3,3"/>');
        }
      }
      const n = RW._pipeNetwork.length;
      const groupCount = n ? RW._pipeGroups(RW._pipeNetwork).length : 0;
      const pendingNote = n ? (' · ' + n + ' pending' + (groupCount !== n ? (' (' + groupCount + ' connected)') : '')) : '';
      const snapNote = RW._pipeSnapHit ? (RW._pipeSnapHit.atEnd ? ' · connects to pipe end' : ' · tees onto a pipe') : '';
      status = 'pipe: ' + RW._pipePts.length + ' point' + (RW._pipePts.length===1?'':'s')
        + ' · width ' + RW._fmtWidth(RW._pipeWidth) + 'px' + pendingNote + snapNote
        + ' · double-click to finish';
    }

    if (RW._pipeSnapHit) parts.push(pipeMarkerSvg(RW._pipeSnapHit));

    if (!parts.length){ if (status != null) RW._commitStatus(status); return; }
    const svg = RW._mkSvg('rw-pipe-preview', 71);
    svg.innerHTML = parts.join('');
    if (status != null) RW._commitStatus(status);
  };

  RW._renderPipeTrace = function(){
    if (!RW._pipeNetwork.length){
      RW._commitStatus('finish a path first (double-click), then Trace');
      return;
    }
    const old = document.getElementById('rw-pipe-preview'); if (old) old.remove();
    const svg = RW._mkSvg('rw-pipe-preview', 76);
    const groups = RW._pipeGroups(RW._pipeNetwork);
    let inner = '', totalPts = 0, merged = 0;
    for (const g of groups){
      let mergedOk = false;
      if (g.length > 1){
        const res = RW._pipeMergeGroup(g.map(i => RW._pipeNetwork[i]));
        if (res.poly){
          inner += '<polygon points="'+polyPx(res.poly)+'" fill="rgba(255,140,0,0.28)" stroke="#ff8c00" stroke-width="2"/>';
          totalPts += res.poly.length; merged++; mergedOk = true;
        }
      }
      if (!mergedOk){
        for (const i of g){
          const seg = RW._pipeNetwork[i];
          if (!seg.ribbon) continue;
          inner += '<polygon points="'+polyPx(seg.ribbon)+'" fill="rgba(255,140,0,0.28)" stroke="#ff8c00" stroke-width="2"/>';
          totalPts += seg.ribbon.length;
        }
      }
    }
    svg.innerHTML = inner;
    const n = RW._pipeNetwork.length;
    const outCount = groups.length;
    RW._commitStatus('traced ' + n + ' segment' + (n===1?'':'s')
      + (merged ? (' → ' + outCount + ' polygon' + (outCount===1?'':'s') + ' (' + merged + ' merged)') : '')
      + ', ' + totalPts + ' pts total — Commit Pipe to stage all ' + outCount);
  };

  RW.commitPipe = async function(){
    if (RW._pipeCommitting) return;
    if (!annotationState.currentTag){
      RW._commitStatus('no active tag — press a tag number first'); return;
    }
    const segs = RW._pipeNetwork.slice();
    if (!segs.length){
      RW._commitStatus('nothing to commit — double-click to finish a path first'); return;
    }
    RW._pipeCommitting = true; RW._syncPipeBtns();
    try {
      const total = segs.length;
      let done = 0, failed = 0, totalPts = 0, merged = 0;
      const created = [];
      RW._commitStatus('committing 0/'+total+' — tag: '+annotationState.currentTag.name);
      const groups = RW._pipeGroups(segs);
      for (const g of groups){
        const members = g.map(i => segs[i]);
        let mergedOk = false;
        if (members.length > 1){
          const res = RW._pipeMergeGroup(members);
          if (res.poly){
            const widths = Array.from(new Set(members.map(s => +s.widthPx.toFixed(2)))).sort((a,b)=>a-b);
            const notes = 'pipe run: ' + members.length + ' segments merged, widths '
              + widths.join(', ') + ' px — branched outline, centerline not recoverable';
            created.push(RW._createPendingAnnotation(res.poly, notes));
            totalPts += res.poly.length;
            done += members.length; merged++; mergedOk = true;
            RW._commitStatus('staged '+done+'/'+total+' (failed: '+failed+')');
          }
        }
        if (!mergedOk){
          for (const seg of members){
            const problem = RW._pipeSanityCheck(seg.ptsN, seg.widthPx);
            const ribbon = problem ? null : (seg.ribbon || RW._pipeRibbon(seg.ptsN, seg.widthPx));
            if (!ribbon || ribbon.length < 4){
              failed++;
              RW._commitStatus('staged '+done+'/'+total+' (failed: '+failed+')');
              continue;
            }
            created.push(RW._createPendingAnnotation(ribbon, 'pipe width: ' + seg.widthPx.toFixed(2) + ' px'));
            totalPts += ribbon.length; done++;
            RW._commitStatus('staged '+done+'/'+total+' (failed: '+failed+')');
          }
        }
      }
      if (!done){
        RW._commitStatus('refused: no segment could be turned into a ribbon');
        return;
      }
      RW._commitStatus('staged '+done+', rendering...');
      await RW._forceRender();
      RW._lastCommit = created;
      RW._pipeNetwork = [];
      RW._pipePendingLinks = Array(RW._pipePts.length).fill(null);
      RW._renderPipePreview(null, null);
      RW._commitStatus(merged
        ? ('staged ' + created.length + ' pipe annotation' + (created.length===1?'':'s')
           + ' from ' + done + ' segment' + (done===1?'':'s') + ' (' + merged + ' merged)'
           + ' (' + totalPts + ' pts total)' + (failed ? (' — ' + failed + ' failed') : '')
           + ' — review and Save. To remove one before Save, select it in the app and press Delete.'
           + ' Got an elbow fitting to mark? Press L.')
        : ('staged ' + done + ' pipe segment' + (done===1?'':'s')
           + ' (' + totalPts + ' pts total)' + (failed ? (' — ' + failed + ' failed') : '')
           + ' — review and Save. To remove one before Save, select it in the app and press Delete.'
           + ' Got an elbow fitting to mark? Press L.'));
    } finally {
      RW._pipeCommitting = false; RW._syncPipeBtns();
    }
  };

  RW.clearPipe = function(opts){
    const lost = RW._pipeNetwork.length;
    RW._pipePts = [];
    RW._pipePendingLinks = [];
    RW._pipeNetwork = [];
    RW._pipeSnapHit = null;
    const old = document.getElementById('rw-pipe-preview'); if (old) old.remove();
    if (!opts || !opts.keepStatus){
      RW._commitStatus(lost ? ('discarded ' + lost + ' unstaged pipe segment' + (lost===1?'':'s')) : '');
    }
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
    b.title = 'Click points along a pipe\'s centerline (double-click to finish); drag anywhere to measure a fixed width off the drawing. Double-click finishes a segment and immediately starts the next — click on or near an existing pipe (white/magenta ring) to connect to it: a cross means end-to-end, a dot means a tee onto its side. Shift bypasses snapping. Escape: clear the path -> discard pending segments -> exit.';
    b.style.cssText = 'font-size:11px;padding:2px 6px;';
    b.innerText = 'Pipe (C)';
    b.onclick = () => RW.setPipeMode(!RW.pipeMode);
    group.appendChild(b);

    const traceBtn = document.createElement('button');
    traceBtn.id = 'rw-pipe-trace';
    traceBtn.title = 'Preview the exact polygons that would be committed — connected segments show as one merged outline.';
    traceBtn.style.cssText = 'font-size:11px;padding:2px 6px;';
    traceBtn.innerText = 'Trace';
    traceBtn.onclick = () => RW._renderPipeTrace();
    group.appendChild(traceBtn);

    const commitBtn = document.createElement('button');
    commitBtn.id = 'rw-pipe-commit';
    commitBtn.title = 'Stage every finished segment from this drawing session as pending polygon annotations, in one batch — segments connected by snapping merge into one combined polygon. The path you\'re still drawing is not affected.';
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
    widthInp.title = 'Ribbon width in mask px. Set by dragging across the pipe in the drawing, or type a value directly. Applies to the path you\'re drawing now; each finished segment keeps the width it had when you finished it, so branches can be a different diameter.';
    widthInp.style.cssText = 'font-size:11px;padding:1px 4px;width:44px;text-align:right;';
    widthInp.onchange = function(){
      const v = parseFloat(widthInp.value);
      if (isNaN(v) || v<=0) return;
      RW._pipeWidth = v;
      RW._renderPipePreview(null, null);
    };
    group.appendChild(widthInp);

    bar.appendChild(group);
  }

  RW._syncPipeBtns = function(){
    const n = RW._pipeNetwork.length;
    const b = document.getElementById('rw-pipe');
    if (b) b.style.background = RW.pipeMode ? 'rgba(255,140,0,0.35)' : '';
    const t = document.getElementById('rw-pipe-trace');
    if (t) t.disabled = !n;
    const c = document.getElementById('rw-pipe-commit');
    if (c){
      c.disabled = !n || !!RW._pipeCommitting;
      const groupCount = n ? RW._pipeGroups(RW._pipeNetwork).length : 0;
      c.innerText = groupCount > 1 ? ('Commit ' + groupCount + ' Pipes') : 'Commit Pipe';
    }
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

  return 'v3.1 up: Pipe annotation — click a path (double-click to finish, branches connect to existing pipes), drag to measure width, Trace/Commit Pipe';
})()
