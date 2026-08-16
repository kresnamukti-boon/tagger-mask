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
  RW._pipeAnchor   = 'center'; // 'center'|'edgeA'|'edgeB' — which rail the click represents, frozen per-segment at finish time
  RW._pipeNetwork  = [];      // finished-but-unstaged segments this session: {ptsN, widthPx, anchor, ribbon, links}
  RW._pipePendingLinks = [];  // parallel to RW._pipePts: a RW._pipeNetwork index or null per placed point
  RW._pipeSnapHit  = null;     // side-channel result of the last _tryPipeSnap call
  RW._pipeSnapEnabled = true;
  RW._pipeCommitting  = false; // re-entrancy guard for commitPipe
  RW._pipeMergeRes    = 4;      // local raster px per mask px, for merging connected segments
  RW._pipeMergeBudget = 12_000_000; // local raster px cap
  RW._pipeMergeEpsMaskPx = 1.0; // DP tolerance target, in MASK px (not raster px) — scaled by `scale` at use, so it stays a constant real-world tolerance regardless of merge resolution
  RW._pipeDragHandle = null;  // {segIdx, end:'start'|'end'} while dragging a free network-segment endpoint, else null
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
  //
  // offL/offR (mask-px, offL+offR === widthPx) let each rail sit at a
  // different distance from the clicked path instead of splitting it evenly
  // — offR=0 means the click IS the right rail (an edge-anchor), etc. This
  // does NOT break centerline recovery: midpoint(left[i],right[i]) is always
  // the ribbon's true geometric center regardless of offL/offR, verified
  // directly (including at a miter joint) against RW._pipeCenterlineFromRibbon.
  const MITER_LIMIT = 4;
  function analyticPipeRibbon(ptsN, widthPx, offL, offR){
    if (offL == null || offR == null){ offL = widthPx/2; offR = widthPx/2; }
    const {W,H} = RW;
    const pts = ptsN.map(([nx,ny]) => [nx*W, ny*H]);
    const clean = [pts[0]];
    for (let i=1;i<pts.length;i++){
      const [px,py] = clean[clean.length-1], [x,y] = pts[i];
      if (Math.hypot(x-px, y-py) > 1e-6) clean.push(pts[i]);
    }
    if (clean.length < 2) return null;
    const n = clean.length;

    const perp = [];
    for (let i=0;i<n-1;i++){
      const [x1,y1] = clean[i], [x2,y2] = clean[i+1];
      const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy) || 1e-6;
      perp.push([-dy/len, dx/len]);
    }

    const left = [], right = [];
    left.push([clean[0][0]+perp[0][0]*offL, clean[0][1]+perp[0][1]*offL]);
    right.push([clean[0][0]-perp[0][0]*offR, clean[0][1]-perp[0][1]*offR]);

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
        left.push([vx+p1[0]*offL, vy+p1[1]*offL], [vx+p2[0]*offL, vy+p2[1]*offL]);
        right.push([vx-p1[0]*offR, vy-p1[1]*offR], [vx-p2[0]*offR, vy-p2[1]*offR]);
      } else {
        left.push([vx+mx*offL, vy+my*offL]);
        right.push([vx-mx*offR, vy-my*offR]);
      }
    }

    left.push([clean[n-1][0]+perp[n-2][0]*offL, clean[n-1][1]+perp[n-2][1]*offL]);
    right.push([clean[n-1][0]-perp[n-2][0]*offR, clean[n-1][1]-perp[n-2][1]*offR]);

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

  // anchor: 'center' (default, splits width evenly — today's exact
  // behavior) | 'edgeA' (click = the right rail, full width to the left) |
  // 'edgeB' (click = the left rail, full width to the right). Lets a click
  // trace one visible edge of a thick drawn line instead of its (often
  // unmarked) centerline; RW._pipeCenterlineFromRibbon still recovers the
  // true center from the result with no changes of its own.
  RW._pipeAnchorOffsets = function(widthPx, anchor){
    if (anchor === 'edgeA') return [widthPx, 0];
    if (anchor === 'edgeB') return [0, widthPx];
    return [widthPx/2, widthPx/2];
  };

  RW._pipeRibbon = function(ptsN, widthPx, anchor){
    if (!ptsN || ptsN.length < 2 || !(widthPx > 0)) return null;
    const clean = RW._pipeDedupe(ptsN);
    if (clean.length < 2) return null;
    const [offL, offR] = RW._pipeAnchorOffsets(widthPx, anchor);
    return analyticPipeRibbon(clean, widthPx, offL, offR);
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

  // Extracts a pipe's three meaningful snap curves from its ribbon — the
  // true centerline and its two edges (rails) — each in the same forward
  // vertex order, so t=0/t=1 on any of the three consistently means "this
  // pipe's real start/end" regardless of which curve a click actually hit.
  // Independent of how the pipe was originally anchored: even a
  // center-anchored pipe has two real edges, and an edge-anchored pipe's
  // true center is still recoverable exactly (see RW._pipeCenterlineFromRibbon).
  // Returns null if the ribbon is invalid.
  RW._pipeRailsFromRibbon = function(ribbon){
    if (!Array.isArray(ribbon) || ribbon.length < 4 || (ribbon.length % 2)) return null;
    const k = ribbon.length / 2;
    const toPts = arr => arr.map(p => [p.x, p.y]);
    const center = RW._pipeCenterlineFromRibbon(ribbon);
    return { center: center, left: toPts(ribbon.slice(0, k)), right: toPts(ribbon.slice(k).reverse()) };
  };

  // Every curve the current point may connect to: for each of this
  // session's finished-but-unstaged segments and every already-committed
  // pipe-tagged annotation (identified by the 'pipe width: ' notes prefix —
  // the only existing marker, same 4-gate discipline every annotation
  // reader in this codebase already uses), offers its centerline AND both
  // edges as separate candidates — a click always snaps to whichever of the
  // three is actually closest, regardless of what anchor the target pipe was
  // originally drawn with (previously, an uncommitted segment only offered
  // its raw clicked curve — its centerline for a center anchor, but an EDGE
  // for an edge anchor — while a committed one always recovered the true
  // center; that inconsistency is what this fixes). Excludes RW._pipePts.
  RW._pipeSnapCandidates = function(){
    const out = [];
    const pushRails = (ribbon, widthPx, src, ref) => {
      const rails = RW._pipeRailsFromRibbon(ribbon);
      if (!rails) return;
      if (rails.center && rails.center.length >= 2) out.push({ptsN:rails.center, widthPx:widthPx, src:src, ref:ref, rail:'center'});
      if (rails.left && rails.left.length >= 2) out.push({ptsN:rails.left, widthPx:widthPx, src:src, ref:ref, rail:'left'});
      if (rails.right && rails.right.length >= 2) out.push({ptsN:rails.right, widthPx:widthPx, src:src, ref:ref, rail:'right'});
    };
    for (let i=0;i<RW._pipeNetwork.length;i++){
      const s = RW._pipeNetwork[i];
      if (s && Array.isArray(s.ribbon)) pushRails(s.ribbon, s.widthPx, 'network', i);
    }
    if (typeof annotationState === 'undefined' || !annotationState || !annotationState.annotations) return out;
    for (const a of annotationState.annotations){
      if (a._hidden || a.is_void) continue;
      const pts = a.coordinates; if (!Array.isArray(pts) || pts.length < 3) continue;
      if (typeof a.notes !== 'string' || a.notes.indexOf('pipe width: ') !== 0) continue;
      const m = /^pipe width:\s*([0-9.]+)/.exec(a.notes);
      const w = m ? parseFloat(m[1]) : NaN;
      pushRails(pts, (isFinite(w) && w>0) ? w : 0, 'annotation', a.id);
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
          // Real click precision almost never lands exactly past a segment's
          // own true endpoint (the old t===0/t===1 clamp test), so an
          // intended end-to-end click routinely came back mid-span. Use a
          // distance tolerance against the true endpoint instead — same
          // catchPx radius the snap itself already uses, no new tunable.
          let te = null;
          if (i === 0 && Math.hypot(mx-ax, my-ay) <= catchPx) te = 'start';
          else if (i === last && Math.hypot(mx-bx, my-by) <= catchPx) te = 'end';
          best = { x:fx, y:fy, nx:fx/RW.W, ny:fy/RW.H, dist:d, rank:rank,
                    inside:(rank===0),
                    atEnd:(te !== null),
                    targetEnd:te, // 'start'|'end'|null — which end of the target this hit, if either
                    src:c.src, ref:c.ref, widthPx:c.widthPx };
        }
      }
    }
    if (!best) return [nx, ny];
    RW._pipeSnapHit = best;
    return [best.nx, best.ny];
  };

  // Dedupes rawPts exactly like RW._pipeDedupe (same 1e-6 mask-px rule against
  // the previously-kept point), while tracking which ORIGINAL index each kept
  // point came from — so a link recorded on a point dedupe later drops (a
  // double-click artifact) still lands on the kept point it collapsed into.
  // `links` is the same flat, deduped array RW._pipeGroups already consumes;
  // linkStart/linkEnd/linkMid are new, additive info for the chain fast path.
  RW._pipeResolveLinks = function(rawPts, pending, netLen){
    const {W,H} = RW;
    const out = { ptsN: [], links: [], linkStart: null, linkEnd: null, linkMid: false };
    if (!Array.isArray(rawPts) || !rawPts.length) return out;
    pending = Array.isArray(pending) ? pending : [];

    const ptsN = [rawPts[0]];
    const keep = [0];
    for (let i=1;i<rawPts.length;i++){
      const [px,py] = ptsN[ptsN.length-1], [x,y] = rawPts[i];
      if (Math.hypot((x-px)*W, (y-py)*H) > 1e-6){ ptsN.push(rawPts[i]); keep.push(i); }
    }
    out.ptsN = ptsN;

    const bucket = new Array(rawPts.length).fill(0);
    for (let i=0, b=0; i<rawPts.length; i++){
      if (b+1 < keep.length && i >= keep[b+1]) b++;
      bucket[i] = b;
    }
    const lastB = ptsN.length - 1;

    const norm = function(l){
      if (Number.isInteger(l)) return {ref:l, targetEnd:null}; // legacy bare integer
      if (l && Number.isInteger(l.ref)){
        const te = (l.targetEnd === 'start' || l.targetEnd === 'end') ? l.targetEnd : null;
        return {ref:l.ref, targetEnd:te};
      }
      return null;
    };
    // an end slot prefers a link that names a target end over a mid-span one
    const pick = function(cur, l){ if (!cur) return l; if (cur.targetEnd) return cur; return l.targetEnd ? l : cur; };

    const seen = new Set();
    for (let i=0;i<pending.length;i++){
      const l = norm(pending[i]);
      if (!l || l.ref < 0 || l.ref >= netLen) continue;
      if (!seen.has(l.ref)){ seen.add(l.ref); out.links.push(l.ref); }
      if (i >= rawPts.length) continue;
      const b = bucket[i];
      if (b === 0)          out.linkStart = pick(out.linkStart, l);
      else if (b === lastB) out.linkEnd   = pick(out.linkEnd,   l);
      else                  out.linkMid   = true;
    }
    return out;
  };

  /* ---------- finishing a path: push into the network, ready for the next ---------- */
  RW._pipeFinishPath = function(){
    if (RW._pipePts.length < 2) return false;
    const info = RW._pipeResolveLinks(RW._pipePts, RW._pipePendingLinks, RW._pipeNetwork.length);
    const ptsN = info.ptsN;
    const ribbon = RW._pipeRibbon(ptsN, RW._pipeWidth, RW._pipeAnchor);
    if (!ribbon || ribbon.length < 4){
      RW._commitStatus('need two distinct points — keep clicking, or Escape to clear');
      return false;
    }
    RW._pipeNetwork.push({
      ptsN: ptsN, widthPx: RW._pipeWidth, anchor: RW._pipeAnchor, ribbon: ribbon,
      links: info.links,         // unchanged contract for RW._pipeGroups
      linkStart: info.linkStart, // {ref,targetEnd}|null — this segment's OWN first point
      linkEnd: info.linkEnd,     // {ref,targetEnd}|null — this segment's OWN last point
      linkMid: info.linkMid      // true if an interior point also carried a link
    });
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

  RW._pipeGapSinFloor = 0.3;  // bounds the crossing extension for a near-parallel tee
  RW._pipeGapMarginPx = 2;    // extra mask-px past the crossing point, absorbs DP/raster rounding

  // Nearest-segment local direction (unit vector, mask-px) of ptsN to (mx,my).
  // Pure/testable; null if ptsN has no usable segment.
  RW._pipeNearestDir = function(ptsN, mx, my){
    let best = null, bestD = Infinity;
    for (let i=0;i<ptsN.length-1;i++){
      const ax=ptsN[i][0]*RW.W, ay=ptsN[i][1]*RW.H;
      const bx=ptsN[i+1][0]*RW.W, by=ptsN[i+1][1]*RW.H;
      const dx=bx-ax, dy=by-ay, len=Math.hypot(dx,dy);
      if (len < 1e-9) continue;
      let t = ((mx-ax)*dx+(my-ay)*dy)/(len*len);
      if (t<0) t=0; else if (t>1) t=1;
      const fx=ax+t*dx, fy=ay+t*dy;
      const d = Math.hypot(fx-mx, fy-my);
      if (d < bestD){ bestD=d; best=[dx/len, dy/len]; }
    }
    return best;
  };

  // A segment's own ribbon has a flat cap at each end, perpendicular to ITS
  // OWN direction — fine for a free end, but wrong for a mid-span tee: the
  // cap generally doesn't line up with the TARGET's local direction, so the
  // raster union leaves a wedge-shaped gap between the two shapes right at
  // the join (worse the closer the join sits to the target's own edge rail
  // rather than its centerline — snapping onto an edge is the extreme case).
  // Extends the linked end far enough along the segment's own direction to
  // cross the target's full width even at a shallow approach angle
  // (bounded by RW._pipeGapSinFloor so a near-parallel tee doesn't runaway),
  // then rebuilds a ribbon from that extended point for rasterizing ONLY —
  // seg.ptsN/seg.ribbon themselves are never mutated. Falls back to the
  // segment's own unmodified ribbon whenever the target can't be resolved,
  // or the link isn't a genuine mid-span tee (targetEnd !== null).
  RW._pipeExtendRibbonForMerge = function(seg){
    const ribbon = seg.ribbon;
    if (!Array.isArray(seg.ptsN) || seg.ptsN.length < 2) return ribbon;
    const ends = [];
    if (seg.linkStart && seg.linkStart.targetEnd === null) ends.push('start');
    if (seg.linkEnd && seg.linkEnd.targetEnd === null) ends.push('end');
    if (!ends.length) return ribbon;

    const pts = seg.ptsN.map(p => p.slice());
    let changed = false;
    for (const end of ends){
      const link = end === 'start' ? seg.linkStart : seg.linkEnd;
      const target = RW._pipeNetwork[link.ref];
      if (!target || !Array.isArray(target.ptsN) || target.ptsN.length < 2) continue;
      const idx = end === 'start' ? 0 : pts.length - 1;
      const nbrIdx = end === 'start' ? 1 : pts.length - 2;
      if (nbrIdx < 0 || nbrIdx >= pts.length || nbrIdx === idx) continue;
      const joinX = pts[idx][0]*RW.W, joinY = pts[idx][1]*RW.H;
      const nbrX = pts[nbrIdx][0]*RW.W, nbrY = pts[nbrIdx][1]*RW.H;
      const ownDx = joinX-nbrX, ownDy = joinY-nbrY, ownLen = Math.hypot(ownDx,ownDy);
      if (ownLen < 1e-6) continue;
      const ownDir = [ownDx/ownLen, ownDy/ownLen];
      const tgtDir = RW._pipeNearestDir(target.ptsN, joinX, joinY);
      if (!tgtDir) continue;
      const sinTheta = Math.abs(ownDir[0]*tgtDir[1] - ownDir[1]*tgtDir[0]);
      const targetHalf = (target.widthPx||0)/2;
      const crossDist = targetHalf / Math.max(sinTheta, RW._pipeGapSinFloor);
      const ext = crossDist + RW._pipeGapMarginPx;
      pts[idx] = [(joinX + ownDir[0]*ext)/RW.W, (joinY + ownDir[1]*ext)/RW.H];
      changed = true;
    }
    if (!changed) return ribbon;
    const extended = RW._pipeRibbon(pts, seg.widthPx, seg.anchor);
    return extended || ribbon;
  };

  // Raster-union + re-trace a connected group of RW._pipeNetwork segments into
  // one combined polygon. Returns {poly, meta} or {error, meta}.
  RW._pipeMergeGroup = function(segs){
    const {W,H} = RW;
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    let maxHalf = 0;
    const ribbons = [];
    for (const seg of segs){
      if (!seg || !Array.isArray(seg.ribbon)) return {error:'missing ribbon', meta:{}};
      const ribbon = RW._pipeExtendRibbonForMerge(seg);
      if (!Array.isArray(ribbon)) return {error:'missing ribbon', meta:{}};
      ribbons.push(ribbon);
      maxHalf = Math.max(maxHalf, (seg.widthPx||0)/2);
      for (const p of ribbon){
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
    for (const ribbon of ribbons){
      const localPts = ribbon.map(p => toLocal(p.x, p.y));
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

    // eps must scale WITH the raster's own resolution, not stay flat: it's a
    // local-raster-px tolerance, and higher scale means each raster px is a
    // smaller real-world (mask-px) distance — a flat eps quietly becomes too
    // tight to absorb the raster's own pixel staircase once scale climbs
    // toward RW._pipeMergeRes for a small, tightly-bounded merge, leaving
    // hundreds of leftover staircase vertices in the committed polygon.
    const eps = (RW._pipeMergeEpsMaskPx != null ? RW._pipeMergeEpsMaskPx : 1.0) * scale;
    const poly = RW._maskToPolygon(mask, {
      W: localW, H: localH, seed: {x:seedX, y:seedY}, smoothPasses: 1, eps: eps
    });
    if (!poly || poly.length < 3) return {error:'trace failed', meta:{}};

    const out = poly.map(p => ({
      x: +(((p.x*localW - pad)/scale + minX)/W).toFixed(6),
      y: +(((p.y*localH - pad)/scale + minY)/H).toFixed(6)
    }));
    return { poly: out, meta: { scale:scale, localW:localW, localH:localH, pixels: total } };
  };

  // Pure vector fast path for a connected group that is a SIMPLE end-to-end
  // chain (no mid-span tees, no 3+-way end junction, uniform width) — builds
  // one ribbon via RW._pipeRibbon directly, no rasterizing at all. Returns
  // {poly, meta} or {error, meta}, mirroring RW._pipeMergeGroup's contract.
  // `indices[k]` is the RW._pipeNetwork index of `members[k]`.
  //
  // The walk below picks its start node by DEGREE (a free end-slot), not by
  // draw order or array index, so a segment drawn last but sitting in the
  // MIDDLE of the final path (e.g. draw A, then B off A's end, then go back
  // and draw C off A's other end) still walks correctly — the start is
  // whichever segment happens to have a free slot, and each segment's own
  // point array is reversed whenever it's entered through its `end` slot
  // rather than its `start` slot. A segment linked at both its own ends
  // (bridging two others) falls out of the same loop with no extra code.
  RW._pipeChainMerge = function(members, indices){
    const meta = {method:'chain', count: Array.isArray(members) ? members.length : 0};
    if (!Array.isArray(members) || !Array.isArray(indices)
        || members.length !== indices.length || !members.length)
      return {error:'bad group', meta:meta};

    const pos = new Map();
    for (let k=0;k<indices.length;k++){
      if (!Number.isInteger(indices[k]) || pos.has(indices[k])) return {error:'bad group indices', meta:meta};
      pos.set(indices[k], k);
    }

    const w0 = members[0] && members[0].widthPx;
    if (!(typeof w0 === 'number' && w0 > 0)) return {error:'bad width', meta:meta};
    const wKey = w0.toFixed(2);
    const anchor0 = (members[0] && members[0].anchor) || 'center';
    for (const s of members){
      if (!s || !Array.isArray(s.ptsN) || s.ptsN.length < 2) return {error:'bad member', meta:meta};
      if (!(typeof s.widthPx === 'number' && s.widthPx > 0) || s.widthPx.toFixed(2) !== wKey)
        return {error:'mixed widths', meta:meta};
      // Concatenating segments whose raw ptsN mean different things (one's
      // clicks are a centerline, another's are an edge) into one combined
      // path and building it with a single anchor would be geometrically
      // wrong — the whole group must agree, same shape of gate as width.
      if (((s.anchor) || 'center') !== anchor0) return {error:'mixed anchors', meta:meta};
    }
    meta.widthPx = w0;
    meta.anchor = anchor0;

    // Each segment end is a slot usable at most once; a chain edge only ever
    // connects one segment's own start/end to ANOTHER segment's true start/end.
    const slot  = members.map(()=>({start:-1, end:-1}));
    const edges = [];
    const norm = l => (l && Number.isInteger(l.ref)
                       && (l.targetEnd === 'start' || l.targetEnd === 'end')) ? l : null;

    for (let k=0;k<members.length;k++){
      const s = members[k];
      if (s.linkMid) return {error:'link at an interior vertex', meta:meta};
      const own = [['start', norm(s.linkStart)], ['end', norm(s.linkEnd)]];

      // every plain union-find link must be explained by an end-to-end link,
      // or the group is held together by something concatenation can't represent
      const endRefs = new Set();
      for (const pair of own) if (pair[1]) endRefs.add(pair[1].ref);
      for (const l of (s.links || [])){
        if (!Number.isInteger(l) || l === indices[k]) continue;
        if (!pos.has(l))     return {error:'link outside the group', meta:meta};
        if (!endRefs.has(l)) return {error:'mid-span or interior link', meta:meta};
      }

      for (const pair of own){
        const mySlot = pair[0], L = pair[1];
        if (!L) continue;
        if (!pos.has(L.ref)) return {error:'link outside the group', meta:meta};
        const j = pos.get(L.ref);
        if (j === k) return {error:'self link', meta:meta};
        if (slot[k][mySlot] !== -1 || slot[j][L.targetEnd] !== -1)
          return {error:'3+ segments meet at one end', meta:meta};
        const id = edges.length;
        slot[k][mySlot] = id; slot[j][L.targetEnd] = id;
        edges.push({a:{k:k, slot:mySlot}, b:{k:j, slot:L.targetEnd}});
      }
    }
    meta.edges = edges.length;
    // every node degree <=2 by slot occupancy, so V-1 edges + no revisit == simple path
    if (edges.length !== members.length - 1) return {error:'not a simple path (cycle or split)', meta:meta};

    let startK = -1;
    for (let k=0;k<members.length;k++){
      if ((slot[k].start === -1 ? 0:1) + (slot[k].end === -1 ? 0:1) <= 1){ startK = k; break; }
    }
    if (startK < 0) return {error:'no free end (cycle)', meta:meta};

    const {W,H} = RW;
    const order = [], reversed = [], seen = new Uint8Array(members.length);
    const combined = [];
    let cur = startK, maxJoint = 0;
    let enter = (slot[startK].start === -1) ? 'start' : 'end';
    for (;;){
      if (seen[cur]) return {error:'revisited a segment', meta:meta};
      seen[cur] = 1;
      const rev = (enter === 'end');
      const pts = rev ? members[cur].ptsN.slice().reverse() : members[cur].ptsN;
      order.push(indices[cur]); reversed.push(rev);
      let from = 0;
      if (combined.length){
        const t = combined[combined.length-1], p = pts[0];
        const gap = Math.hypot((p[0]-t[0])*W, (p[1]-t[1])*H);
        if (gap > maxJoint) maxJoint = gap;
        if (gap > Math.max(1, w0)) return {error:'joint geometry does not match the recorded link', meta:meta};
        if (gap <= 1e-6) from = 1; // drop the shared joint point
      }
      for (let i=from;i<pts.length;i++) combined.push(pts[i]);
      const exit = (enter === 'start') ? 'end' : 'start';
      const id = slot[cur][exit];
      if (id === -1) break;
      const e = edges[id];
      const other = (e.a.k === cur && e.a.slot === exit) ? e.b : e.a;
      enter = other.slot; cur = other.k;
    }
    if (order.length !== members.length) return {error:'chain does not cover the group', meta:meta};
    meta.segmentOrder = order; meta.reversed = reversed; meta.jointGapPx = maxJoint; meta.points = combined.length;

    const problem = RW._pipeSanityCheck(combined, w0);
    if (problem) return {error:problem, meta:meta};
    const poly = RW._pipeRibbon(combined, w0, anchor0); // the SAME builder a lone pipe uses
    if (!poly || poly.length < 4) return {error:'ribbon build failed', meta:meta};
    meta.polyPoints = poly.length;
    return {poly:poly, meta:meta};
  };

  // Single dispatch used by BOTH _renderPipeTrace and commitPipe, so Trace can
  // never disagree with Commit. Vector chain first (deterministic, no
  // rasterizing, re-snappable result); raster union otherwise.
  RW._pipeMergeConnected = function(members, indices){
    const chain = RW._pipeChainMerge(members, indices);
    if (chain && chain.poly) return chain;
    const raster = RW._pipeMergeGroup(members);
    const meta = Object.assign({}, (raster && raster.meta) || {}, {
      method: (raster && raster.poly) ? 'raster' : 'none',
      chainError: chain && chain.error
    });
    if (raster && raster.poly) return {poly: raster.poly, meta: meta};
    return {error: (raster && raster.error) || 'merge failed', meta: meta};
  };

  // True if RW._pipeNetwork[segIdx]'s given end ('start'|'end') has no
  // connection at all — neither did this segment link outward from that end,
  // nor does any OTHER segment's linkStart/linkEnd point at this specific
  // segment+end. A link is recorded only on the LATER-drawn segment, so both
  // directions must be checked — the earlier segment has no reciprocal field.
  RW._pipeEndpointIsFree = function(segIdx, end){
    const seg = RW._pipeNetwork[segIdx];
    if (!seg) return false;
    const own = end === 'start' ? seg.linkStart : seg.linkEnd;
    if (own) return false;
    for (let i=0;i<RW._pipeNetwork.length;i++){
      if (i === segIdx) continue;
      const other = RW._pipeNetwork[i];
      if (!other) continue;
      if ((other.linkStart && other.linkStart.ref === segIdx && other.linkStart.targetEnd === end)
          || (other.linkEnd && other.linkEnd.ref === segIdx && other.linkEnd.targetEnd === end))
        return false;
    }
    return true;
  };

  // Hit-tests a free network-segment endpoint against a client point.
  // Container-relative px, mirrors rw_elbow.js's hitTestElbowHandle exactly.
  function hitTestPipeHandle(clientX, clientY){
    const cr = document.getElementById('pdf-container').getBoundingClientRect();
    const mx = clientX - cr.x, my = clientY - cr.y;
    const HIT = 10;
    for (let i=0;i<RW._pipeNetwork.length;i++){
      const seg = RW._pipeNetwork[i];
      if (!seg || !Array.isArray(seg.ptsN) || seg.ptsN.length < 2) continue;
      const ends = [['start', seg.ptsN[0]], ['end', seg.ptsN[seg.ptsN.length-1]]];
      for (const [end, pt] of ends){
        if (!RW._pipeEndpointIsFree(i, end)) continue;
        const [px,py] = RW._toPx(pt[0], pt[1]);
        if (Math.hypot(px-mx, py-my) <= HIT) return { segIdx:i, end:end };
      }
    }
    return null;
  }

  /* ---------- click / drag / finish state machine ---------- */
  let pipeHandleCandidate = null; // hit-test result at mousedown, not yet armed as a real drag
  ac.addEventListener('mousedown', function(e){
    if (!RW.pipeMode) return;
    e.stopPropagation(); e.preventDefault();
    shiftHeld = e.shiftKey;
    // Deliberately NOT armed yet: a plain click here must still fall through
    // to the existing click-to-place/snap-onto-this-same-tip behavior
    // unchanged. Only an actual drag (>5px, checked in mousemove) commits to
    // reshaping this endpoint instead of starting a new branch there.
    pipeHandleCandidate = hitTestPipeHandle(e.clientX, e.clientY);
    downPos = {x:e.clientX, y:e.clientY};
    dragging = false;
    dragCurClient = null;
  }, true);

  ac.addEventListener('mousemove', function(e){
    if (!RW.pipeMode) return;
    e.stopPropagation();
    shiftHeld = e.shiftKey;
    if (RW._pipeDragHandle){
      applyPipeDragPoint(e.clientX, e.clientY);
      RW._renderPipePreview(e.clientX, e.clientY);
      return;
    }
    if (downPos){
      const d = Math.hypot(e.clientX-downPos.x, e.clientY-downPos.y);
      if (d > 5){
        if (pipeHandleCandidate){
          RW._pipeDragHandle = pipeHandleCandidate;
          pipeHandleCandidate = null;
          applyPipeDragPoint(e.clientX, e.clientY); // apply THIS frame's position too, no one-frame lag
          RW._renderPipePreview(e.clientX, e.clientY);
          return;
        }
        dragging = true;
        dragCurClient = {x:e.clientX, y:e.clientY};
        RW._renderPipePreview(e.clientX, e.clientY);
        return;
      }
    }
    RW._renderPipePreview(e.clientX, e.clientY);
  }, true);

  // Moves the currently-armed drag handle's endpoint to (clientX,clientY),
  // rebuilding that segment's ribbon. Refuses (leaves the point untouched)
  // if the result would collapse the segment onto its own neighbor point.
  function applyPipeDragPoint(clientX, clientY){
    const { segIdx, end } = RW._pipeDragHandle;
    const seg = RW._pipeNetwork[segIdx];
    if (!seg) return;
    const n = RW._toNorm(clientX, clientY);
    const idx = end === 'start' ? 0 : seg.ptsN.length - 1;
    const neighborIdx = end === 'start' ? 1 : seg.ptsN.length - 2;
    const neighbor = seg.ptsN[neighborIdx];
    const distPx = Math.hypot((n[0]-neighbor[0])*RW.W, (n[1]-neighbor[1])*RW.H);
    if (distPx > 1){ // refuse to collapse the segment onto its neighbor point
      seg.ptsN[idx] = n;
      seg.ribbon = RW._pipeRibbon(seg.ptsN, seg.widthPx, seg.anchor);
    }
  }

  ac.addEventListener('mouseup', function(e){
    if (!RW.pipeMode) return;
    e.stopPropagation(); e.preventDefault();
    shiftHeld = e.shiftKey;
    pipeHandleCandidate = null;
    if (RW._pipeDragHandle){
      RW._pipeDragHandle = null;
      downPos = null;
      RW._renderPipePreview(e.clientX, e.clientY);
      return;
    }
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
      const p = RW._tryPipeSnap(nx, ny);
      // Pipe mode snaps to PIPES ONLY — this session's _pipeNetwork segments and
      // already-committed pipe annotations (_tryPipeSnap's full candidate set).
      // _trySnap still runs, unconditionally, but purely so RW._lastSnapHit stays
      // fresh for Poly2's own preview marker after a tool switch — its result is
      // never used to choose where the pipe point lands.
      if (RW._trySnap) RW._trySnap(nx, ny);
      if (RW._pipeSnapHit){ nx = p[0]; ny = p[1]; }
    } else {
      RW._pipeSnapHit = null;
    }
    let link = null;
    if (!e.shiftKey && RW._pipeSnapHit && RW._pipeSnapHit.src === 'network'
        && Number.isInteger(RW._pipeSnapHit.ref)
        && RW._pipeSnapHit.ref >= 0 && RW._pipeSnapHit.ref < RW._pipeNetwork.length){
      link = { ref: RW._pipeSnapHit.ref, targetEnd: RW._pipeSnapHit.targetEnd || null };
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
  // Live width-measure dimension line: main line + perpendicular end ticks
  // (any drag angle) + a labeled backdrop centered on the offset midpoint.
  // Coordinates must already be container-relative (RW._toPx output), like
  // every other element this preview draws.
  function dimensionLineSvg(x1,y1,x2,y2,label){
    const dx = x2-x1, dy = y2-y1;
    const len = Math.hypot(dx,dy) || 1;
    const ux = dx/len, uy = dy/len;
    let px = -uy, py = ux; // unit normal
    if (py > 0){ px = -px; py = -py; } // keep the label above the line regardless of drag direction
    const TICK=7, OFF=15, FS=12, CHW=7, PADX=8, BH=18;
    let s = '<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2
      + '" stroke="#ff8c00" stroke-width="2" stroke-dasharray="4,3"/>';
    s += '<line x1="'+(x1-px*TICK)+'" y1="'+(y1-py*TICK)+'" x2="'+(x1+px*TICK)+'" y2="'+(y1+py*TICK)
      + '" stroke="#ff8c00" stroke-width="2"/>';
    s += '<line x1="'+(x2-px*TICK)+'" y1="'+(y2-py*TICK)+'" x2="'+(x2+px*TICK)+'" y2="'+(y2+py*TICK)
      + '" stroke="#ff8c00" stroke-width="2"/>';
    const bw = label.length*CHW + PADX*2;
    const lx = (x1+x2)/2 + px*OFF, ly = (y1+y2)/2 + py*OFF;
    s += '<rect x="'+(lx-bw/2)+'" y="'+(ly-BH/2)+'" width="'+bw+'" height="'+BH
      + '" rx="4" ry="4" fill="rgba(20,20,20,0.85)"/>';
    s += '<text x="'+lx+'" y="'+ly+'" fill="#ffffff" font-size="'+FS
      + '" font-family="sans-serif" text-anchor="middle" dominant-baseline="central">' + label + '</text>';
    return s;
  }
  RW._pipeDimensionLineSvg = dimensionLineSvg; // exposed for direct Node-testability, same convention as RW._pipeRibbon
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

    for (let i=0;i<RW._pipeNetwork.length;i++){
      const seg = RW._pipeNetwork[i];
      parts.push('<polygon points="'+ polyPx(seg.ribbon) +'" fill="rgba(255,140,0,0.16)" '
        + 'stroke="#ff8c00" stroke-width="1" stroke-opacity="0.85"/>');
      parts.push('<polyline points="'+ linePx(seg.ptsN) +'" fill="none" stroke="#ff8c00" '
        + 'stroke-width="1" stroke-opacity="0.45" stroke-dasharray="2,4"/>');
      // A handle only at genuinely free (unconnected) endpoints — communicates
      // which ends are draggable, mirroring rw_elbow.js's own handle style.
      if (Array.isArray(seg.ptsN) && seg.ptsN.length >= 2){
        const ends = [['start', seg.ptsN[0]], ['end', seg.ptsN[seg.ptsN.length-1]]];
        for (const [end, pt] of ends){
          if (!RW._pipeEndpointIsFree(i, end)) continue;
          const [px,py] = RW._toPx(pt[0], pt[1]);
          parts.push('<circle cx="'+px+'" cy="'+py+'" r="5" fill="#fff" stroke="#ff8c00" stroke-width="2"/>');
        }
      }
    }

    if (dragging && dragCurClient && downPos){
      RW._pipeSnapHit = null; // clear a stale marker from before the drag started
      const [ax,ay] = RW._toNorm(downPos.x, downPos.y), [bx,by] = RW._toNorm(dragCurClient.x, dragCurClient.y);
      const liveW = Math.hypot((bx-ax)*RW.W, (by-ay)*RW.H);
      // Container-relative, matching every other element in this SVG — raw
      // clientX/clientY would be offset by #pdf-container's own left/top.
      const [x1,y1] = RW._toPx(ax,ay), [x2,y2] = RW._toPx(bx,by);
      parts.push(dimensionLineSvg(x1,y1,x2,y2, RW._fmtWidth(liveW) + ' px'));
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
        const ribbon = RW._pipeRibbon(pts, RW._pipeWidth, RW._pipeAnchor);
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
        const res = RW._pipeMergeConnected(g.map(i => RW._pipeNetwork[i]), g);
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
          const res = RW._pipeMergeConnected(members, g);
          if (res.poly){
            let notes;
            if (res.meta && res.meta.method === 'chain'){
              // Same analyticPipeRibbon a lone pipe uses, so this stays a
              // first-class, re-snappable pipe — ordinary prefix, not 'pipe run:'.
              notes = 'pipe width: ' + res.meta.widthPx.toFixed(2) + ' px — '
                + members.length + ' segments joined';
            } else {
              const widths = Array.from(new Set(members.map(s => +s.widthPx.toFixed(2)))).sort((a,b)=>a-b);
              notes = 'pipe run: ' + members.length + ' segments merged, widths '
                + widths.join(', ') + ' px — branched outline, centerline not recoverable';
            }
            created.push(RW._createPendingAnnotation(res.poly, notes));
            totalPts += res.poly.length;
            done += members.length; merged++; mergedOk = true;
            RW._commitStatus('staged '+done+'/'+total+' (failed: '+failed+')');
          }
        }
        if (!mergedOk){
          for (const seg of members){
            const problem = RW._pipeSanityCheck(seg.ptsN, seg.widthPx);
            const ribbon = problem ? null : (seg.ribbon || RW._pipeRibbon(seg.ptsN, seg.widthPx, seg.anchor));
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
    RW._pipeDragHandle = null;
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

    const anchorBtn = document.createElement('button');
    anchorBtn.id = 'rw-pipe-anchor';
    anchorBtn.style.cssText = 'font-size:11px;padding:2px 6px;';
    RW._syncPipeAnchorBtn = function(){
      const label = RW._pipeAnchor === 'edgeA' ? 'Edge A' : RW._pipeAnchor === 'edgeB' ? 'Edge B' : 'Center';
      anchorBtn.innerText = 'Anchor: ' + label;
      anchorBtn.title = 'What your click represents: Center splits the width evenly to each side '
        + '(today\'s default). Edge A/Edge B put the click on one rail instead, with the full width '
        + 'to the other side — useful for tracing along one visible edge of a thick line instead of '
        + 'its (often unmarked) centerline. Which side is "A" vs "B" depends on your click direction, '
        + 'not absolute screen position. Applies to the path you\'re drawing now; each finished '
        + 'segment keeps the anchor it had when finished.';
    };
    anchorBtn.onclick = function(){
      RW._pipeAnchor = RW._pipeAnchor === 'center' ? 'edgeA' : RW._pipeAnchor === 'edgeA' ? 'edgeB' : 'center';
      RW._syncPipeAnchorBtn();
      RW._renderPipePreview(null, null);
    };
    RW._syncPipeAnchorBtn();
    group.appendChild(anchorBtn);

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
