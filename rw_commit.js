// RW v2.5 — mask contours become real pending annotations via
// annotationState/editHistory.
//
// Mechanism:
//   1. build newAnnotation { id: temp_*, tag, measurement_type:'POLYGON',
//      coordinates: <normalized pts>, _pending: true, _data: {page_id,
//      measurement_type, points_data, notes, tag_id, temp_id} }
//   2. annotationState.annotations.push(newAnnotation)
//   3. editHistory.push(createHistoryEntry('create_annotation', {before:null, after:newAnnotation}))
//   4. re-render via a zoom-button round-trip
//
// Load AFTER rw_undo.js (needs v2.3).
(function(){
  const RW = window.__RW;
  if (!RW || !RW.v23) return 'need v2.3 first';
  RW.v24 = true; // supersedes
  RW.v25 = true;

  /* ---------- contour tracing (Moore neighbor), generic over any 1/0 mask ----------
     Traces/smooths/simplifies any 1/0 mask (not just RW.labels regions), so
     e.g. rw_wallspan.js's wall-span selections share this pipeline. Reads no
     global RW.smoothPasses/RW.smoothEps — callers pass explicit
     smoothPasses/eps; _groupToPolygon (below) is the only place those
     globals are read, preserving region-commit behavior.
     opts: { seed:{x,y}|null (skip the O(W*H) scan if the caller already
              knows a mask pixel), smoothPasses:int (Chaikin rounds, ~0.5-1px
              inward erosion each), eps:number (DP tolerance, ignored if
              targetPts set), targetPts:int|null (bisect eps to the vertex
              count closest to, without exceeding, this target — see
              rw_elbow.js's `pts`; bisects only the cheap final simplify
              step, not the trace/Chaikin), W:int, H:int (override RW.W/RW.H
              for a local raster not sized to the page, e.g. rw_elbow.js's
              detection crop; defaults to RW.W/RW.H) } */
  // Douglas-Peucker on an OPEN polyline, self-recursing via RW._dpOpen (not a
  // closure) so RW._traceGridBoundary's own `pts` cap can reuse it too.
  RW._dpOpen = function(pts, eps2){
    if (pts.length<3) return pts;
    const [x1,y1]=pts[0], [x2,y2]=pts[pts.length-1];
    const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy)||1;
    let maxD=0, idx=0;
    for (let i=1;i<pts.length-1;i++){
      const dd=Math.abs(dy*pts[i][0]-dx*pts[i][1]+x2*y1-y2*x1)/len;
      if (dd>maxD){maxD=dd;idx=i;}
    }
    if (maxD>eps2){
      const l=RW._dpOpen(pts.slice(0,idx+1),eps2), r=RW._dpOpen(pts.slice(idx),eps2);
      return l.slice(0,-1).concat(r);
    }
    return [pts[0], pts[pts.length-1]];
  };

  // Simplify a CLOSED ring at a given eps — splits at the point farthest
  // from ring[0] (eps-independent; pass a precomputed `far` when bisecting
  // many eps values to skip re-scanning) into two open chains, DP-simplifies
  // each, merges. Works on any closed point ring regardless of source
  // (Chaikin-smoothed Moore trace or RW._traceGridBoundary's exact walk).
  //
  // FIXED BUG: the second half used to run `RW._dpOpen(ring.slice(far),
  // eps2)`, stopping at ring[n-1] instead of wrapping back to ring[0] — the
  // final `.slice(0,-1)` merge then silently dropped the ring's true closing
  // vertex. Invisible for years on Chaikin-smoothed rings (the dropped point
  // sits ~0.25-0.75px from ring[0]) but a real, visible defect on an exact
  // grid-boundary trace (e.g. a rectangle simplified to a 3-point triangle at
  // any eps). Fixed by appending ring[0] onto the second half before
  // simplifying, so DP sees the true closing edge.
  RW._simplifyRing = function(ring, eps2, far){
    if (far == null){
      let farD=0; far=0;
      const [sx2,sy2]=ring[0];
      for (let i=0;i<ring.length;i++){
        const d=Math.hypot(ring[i][0]-sx2, ring[i][1]-sy2);
        if (d>farD){farD=d;far=i;}
      }
    }
    const h1=RW._dpOpen(ring.slice(0,far+1), eps2), h2=RW._dpOpen(ring.slice(far).concat([ring[0]]), eps2);
    return h1.slice(0,-1).concat(h2.slice(0,-1));
  };

  // Bisect eps to land at the vertex count closest to, without exceeding,
  // `targetPts` — extracted out of RW._maskToPolygon's inline bisection so
  // RW._traceGridBoundary's own `pts` cap can reuse the exact same bracket
  // and "unreachable" handling instead of re-deriving it. `far` is passed
  // straight through to RW._simplifyRing on every iteration (still
  // eps-independent, so still safe to reuse — see RW._simplifyRing's own
  // comment); each of the ~20 iterations only re-runs the cheap DP halves,
  // never re-traces or re-Chaikins.
  RW._bisectRingToTargetPts = function(ring, targetPts, far){
    // Floor above 0 (not at it): eps->0 makes DP retain nearly every point,
    // and its recursion depth scales with retained-point count — a real
    // risk once `ring` is large (a high-resolution local raster, see
    // rw_elbow.js's `res` tunable).
    let lo = 0.05, hi = 1e5;
    const at = (eps) => RW._simplifyRing(ring, eps, far);
    if (at(lo).length <= targetPts) return at(lo);
    if (at(hi).length > targetPts) return at(hi); // unreachable even at max simplification — caller should notice
    for (let iter=0; iter<20; iter++){
      const mid = (lo+hi)/2;
      if (at(mid).length <= targetPts) hi = mid; else lo = mid;
    }
    return at(hi);
  };

  RW._maskToPolygon = function(uni, opts){
    opts = opts || {};
    const W = opts.W != null ? opts.W : RW.W;
    const H = opts.H != null ? opts.H : RW.H;
    const passes = opts.smoothPasses != null ? opts.smoothPasses : 4;
    const on = (x,y)=> x>=0&&x<W&&y>=0&&y<H&&uni[y*W+x]===1;
    let sx=-1, sy=-1;
    if (opts.seed){
      sx=opts.seed.x; sy=opts.seed.y;
      if (!on(sx,sy)) return null;
    } else {
      outer: for (let y=0;y<H;y++) for (let x=0;x<W;x++){ if(on(x,y)){sx=x;sy=y;break outer;} }
    }
    if (sx<0) return null;
    const dirs=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
    let path=[[sx,sy]];
    let cx=sx, cy=sy, dir=6;
    for (let step=0; step<400000; step++){
      let found=false;
      for (let k=0;k<8;k++){
        const d=(dir+k)%8;
        const nx=cx+dirs[d][0], ny=cy+dirs[d][1];
        if (on(nx,ny)){ cx=nx; cy=ny; dir=(d+6)%8; found=true; path.push([cx,cy]); break; }
      }
      if (!found) break;
      if (cx===sx&&cy===sy&&path.length>3) break;
    }
    // Chaikin corner-cutting: smooth pixel staircases (dragon's teeth) on
    // diagonal edges. Each vertex -> two points at 25%/75% of adjacent edges.
    // `rounds` progressively erode ~0.5-1px inward per pass at mask res.
    function chaikin(pts, rounds){
      let out = pts;
      for (let p=0;p<rounds;p++){
        const next = [];
        for (let i=0;i<out.length;i++){
          const [ax,ay]=out[i], [bx,by]=out[(i+1)%out.length];
          next.push([ax*0.75+bx*0.25, ay*0.75+by*0.25]);
          next.push([ax*0.25+bx*0.75, ay*0.25+by*0.75]);
        }
        out = next;
      }
      return out;
    }
    // The `path.length>=8` gate and Chaikin's `work`/`far` split are both
    // eps-independent (far is picked by max distance from work[0], computed
    // before any eps comparison) — run them ONCE, then RW._simplifyRing just
    // re-runs the cheap DP halves. This is what makes targetPts's bisection
    // below affordable: each of its ~20 iterations only redoes DP, not the
    // Moore trace or Chaikin smoothing.
    let work = null, far = 0;
    if (path.length >= 8){
      work = chaikin(path, passes);
      let farD=0;
      const [sx2,sy2]=work[0];
      for (let i=0;i<work.length;i++){
        const d=Math.hypot(work[i][0]-sx2, work[i][1]-sy2);
        if (d>farD){farD=d;far=i;}
      }
    }
    let simp;
    if (opts.targetPts != null && opts.targetPts > 0 && work){
      simp = RW._bisectRingToTargetPts(work, opts.targetPts, far);
    } else if (work){
      const e2 = opts.eps != null ? opts.eps : 1.2;
      simp = RW._simplifyRing(work, e2, far);
    } else {
      simp = path; // too few raw points for Chaikin/DP to matter
    }
    return simp.map(([x,y])=>({x:+(x/W).toFixed(6), y:+(y/H).toFixed(6)}));
  };

  /* ---------- exact pixel-EDGE boundary tracer, distinct from the Moore
     pixel-CENTER tracer above ----------
     RW._maskToPolygon walks pixel CENTERS (8-connected, diagonal jumps
     allowed) and relies on Chaikin+DP to turn the resulting staircase into a
     smooth curve. This tracer instead walks the grid EDGES *between* pixels
     — every output edge is purely horizontal or vertical, and a vertex is
     emitted only where the walk genuinely changes direction, so a long
     straight run of boundary pixels collapses to one edge for free, with no
     simplification pass needed. Built for rw_elbow.js's "pixel-precise"
     trace mode (RW._elbowPixelPrecise) — the user's own ask, after finding
     the Px:src debug overlay more trustworthy than the smoothed trace once a
     color has been picked.

     Construction: each foreground pixel's 4 sides bordering background (or
     out-of-bounds, background by convention) become directed edges between
     the two grid corners at that side, foreground always on the RIGHT of
     travel — repeated right turns cycle N->E->S->W->N, clockwise in this
     codebase's y-down coordinates, matching the Moore tracer's orientation.

     No seed: always starts at the topmost-then-leftmost foreground pixel,
     which is provably unambiguous (an ambiguous corner needs its diagonal-
     opposite pixel foreground too, which would have to appear earlier in
     raster order — a contradiction).

     Ambiguous corners: an 8-connected region can touch itself diagonally at
     one corner, which this construction sees as 2 valid outgoing directions
     there (always an opposite pair). RULE: take the direction 90 degrees
     COUNTER-CLOCKWISE from the incoming one. This is the correct pairing for
     8-connected-foreground/4-connected-background (the standard convention
     that avoids ambiguity at a shared corner) — the CLOCKWISE reading
     instead traces only half of a diagonally-touching component, or (for a
     ring with a hole) splices the hole into the outer boundary as one wrong
     shape. Derived by hand and independently re-derived by an adversarial
     review; full worked proof (a 2x2 checkerboard, a 3x3 ring) is in
     CLAUDE.md and directly tested in verify_gridboundary.js. **Do not "fix"
     this back to clockwise without re-reading that proof** — it looks like
     an arbitrary choice but isn't.

     Output can be a WEAKLY simple polygon (a genuine pinch point revisits
     one corner) — exact for area, but a caller simplifying with DP
     (RW._bisectRingToTargetPts) must check for a resulting true self-
     intersection; that check lives in rw_elbow.js, not here, since this
     function's job is to trace exactly, not simplify.

     opts: { W:int, H:int }. Returns [{x,y}] (same 0-1 fraction format as
     RW._maskToPolygon) or null if the mask is empty or the walk can't close
     (a bug, not expected on a real boundary — the step budget is a safety
     net only). */
  RW._traceGridBoundary = function(mask, opts){
    opts = opts || {};
    const W = opts.W != null ? opts.W : RW.W;
    const H = opts.H != null ? opts.H : RW.H;
    let fgCount = 0;
    for (let i=0;i<mask.length;i++) if (mask[i]) fgCount++;
    if (!fgCount) return null;
    let startX=-1, startY=-1;
    outer: for (let y=0;y<H;y++) for (let x=0;x<W;x++){ if (mask[y*W+x]){ startX=x; startY=y; break outer; } }
    const fg = (x,y) => x>=0 && x<W && y>=0 && y<H && mask[y*W+x]===1;
    const DIRS = { E:[1,0], S:[0,1], W:[-1,0], N:[0,-1] };
    const CCW  = { N:'W', W:'S', S:'E', E:'N' };
    const maxSteps = 4*fgCount + 8; // a correct trace can never exceed this — mirrors RW._maskToPolygon's own step<400000 bailout idiom

    let cx = startX, cy = startY;
    let dir = 'E'; // proven unambiguous first direction, see header comment
    const verts = [[cx, cy]];
    let steps = 0;
    while (true){
      const [dx,dy] = DIRS[dir];
      cx += dx; cy += dy;
      steps++;
      if (steps > maxSteps) return null;
      if (cx === startX && cy === startY) break; // closed — start corner's position is already verts[0]

      // The 4 pixels touching this corner: NW=(cx-1,cy-1), NE=(cx,cy-1),
      // SW=(cx-1,cy), SE=(cx,cy). Each of the 4 possible outgoing directions
      // from a corner is valid iff exactly one of its two flanking pixels is
      // foreground — derived directly from the per-pixel-side construction
      // above (e.g. "outgoing east" is pixel(cx,cy)'s own top edge, valid
      // iff SE is foreground and NE is not).
      const NW = fg(cx-1,cy-1), NE = fg(cx,cy-1), SW = fg(cx-1,cy), SE = fg(cx,cy);
      const validE = SE && !NE, validS = SW && !SE, validW = NW && !SW, validN = NE && !NW;
      const count = (validE?1:0) + (validS?1:0) + (validW?1:0) + (validN?1:0);
      if (count === 0) return null; // structurally impossible on a real boundary — safety net, not an expected path
      const nextDir = count === 1
        ? (validE ? 'E' : validS ? 'S' : validW ? 'W' : 'N')
        : CCW[dir]; // ambiguous corner — see header proof
      if (nextDir !== dir) verts.push([cx, cy]);
      dir = nextDir;
    }
    return verts.map(([x,y]) => ({ x:+(x/W).toFixed(6), y:+(y/H).toFixed(6) }));
  };

  /* ---------- region contour tracing (union of group members) ---------- */
  RW._groupToPolygon = function(gid, eps){
    const {W,H,labels,regions} = RW;
    const memberIds = new Set(regions.filter(r=>r.group===gid).map(r=>r.id));
    if (!memberIds.size) return null;
    const uni = new Int8Array(W*H);
    for (let i=0;i<W*H;i++){
      const l = labels[i];
      uni[i] = (l>=0 && memberIds.has(l)) ? 1 : 0;
    }
    // Globals win here, exactly as before the v3.1 refactor — _maskToPolygon
    // itself no longer looks at RW.smoothPasses/RW.smoothEps at all.
    const passes = RW.smoothPasses != null ? RW.smoothPasses : 4;
    const e2 = RW.smoothEps != null ? RW.smoothEps : (eps||1.2);
    return RW._maskToPolygon(uni, {seed:null, smoothPasses:passes, eps:e2});
  };

  /* ---------- direct annotation creation ---------- */
  let tempCounter = 1;
  // notes: optional string (default '', matching every caller before this
  // parameter existed) — e.g. rw_wallspan.js's commitPipe uses this to record
  // the measured pipe width, and rw_elbow.js's commitElbow uses it to record
  // its detection tunables, without inventing a new annotation type or a
  // text-rendering mechanism of its own.
  RW._createPendingAnnotation = function(normPts, notes){
    notes = notes || '';
    const st = annotationState;
    const tag = st.currentTag;
    const tempId = 'temp_rw_' + (Date.now()%100000) + '_' + (tempCounter++);
    const annotationData = {
      page_id: st.pageId,
      measurement_type: 'POLYGON',
      points_data: normPts,
      notes: notes,
      temp_id: tempId,
    };
    if (tag) annotationData.tag_id = tag.id;
    const newAnnotation = {
      id: tempId,
      tag: tag || null,
      labels: [],
      measurement_type: 'POLYGON',
      coordinates: normPts,
      notes: notes,
      _pending: true,
      _data: annotationData,
    };
    // 1. state
    st.annotations.push(newAnnotation);
    // 2. WAL entry (this is what buildSaveManifest reads)
    window.editHistory.push(window.createHistoryEntry('create_annotation', {
      description: 'Draw polygon',
      targetId: newAnnotation.id,
      targetType: 'annotation',
      before: null,
      after: JSON.parse(JSON.stringify(newAnnotation)),
    }));
    return newAnnotation;
  };

  /* ---------- redraw: force the app to re-render annotations ----------
     renderAnnotations is module-scoped. The exposed zoom controls trigger a
     full re-render pipeline. We do a silent zoom round-trip. */
  RW._forceRender = async function(){
    const zin = document.getElementById('zoom-in-btn');
    const zout = document.getElementById('zoom-out-btn');
    if (zin && zout){
      zin.click();
      await new Promise(r=>setTimeout(r,120));
      zout.click();
      await new Promise(r=>setTimeout(r,120));
    }
  };

  /* ---------- commit flow ---------- */
  RW._commitAbort = false;
  RW.commitSelected = async function(){
    if (!RW.selected.size){ RW._commitStatus('nothing selected'); return; }
    if (!annotationState.currentTag){ RW._commitStatus('no active tag — press a tag number first'); return; }
    const groups = Array.from(RW.selected);
    const total = groups.length;
    let done = 0, failed = 0;
    const tagName = annotationState.currentTag.name;
    RW._commitStatus('committing 0/'+total+' — tag: '+tagName);
    const created = [];
    for (const gid of groups){
      const poly = RW._groupToPolygon(gid, 1.2);
      if (!poly || poly.length < 3){ failed++; continue; }
      created.push(RW._createPendingAnnotation(poly));
      done++;
      RW._commitStatus('staged '+done+'/'+total+' (failed: '+failed+')');
    }
    RW._commitStatus('staged '+done+', rendering...');
    await RW._forceRender();
    RW._commitStatus('done: '+done+' committed, '+failed+' failed — review and Save');
    RW._lastCommit = created;
    RW.selected = new Set();
    RW.renderList(); RW.renderOverlay();
    RW._renderCommitPreview();
  };
  RW.abortCommit = function(){ RW._commitAbort = true; };
  RW._commitStatus = function(msg){
    const el = document.getElementById('rw-commit-status');
    if (el) el.innerText = msg;
    console.log('[RW commit]', msg);
  };

  /* ---------- panel wiring ---------- */
  const commitBtn = document.getElementById('rw-commit');
  if (commitBtn) commitBtn.onclick = ()=>RW.commitSelected();
  const panel = document.getElementById('rw-panel');
  if (panel && !document.getElementById('rw-commit-status')){
    const s = document.createElement('div');
    s.id='rw-commit-status';
    s.style.cssText='font-size:11px;opacity:0.75;margin-top:4px;min-height:14px;';
    panel.insertBefore(s, document.getElementById('rw-list'));
  }

  return 'v2.5 direct-write commit up: instant staging, no click replay';
})()
