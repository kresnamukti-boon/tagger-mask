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
     Traces/smooths/simplifies any 1/0 mask, not just RW.labels regions.
     Reads no global RW.smoothPasses/RW.smoothEps; callers pass explicit
     smoothPasses/eps.
     opts: { seed:{x,y}|null, smoothPasses:int (Chaikin rounds, ~0.5-1px
              inward erosion each), eps:number (DP tolerance, ignored if
              targetPts set), targetPts:int|null (bisect eps to the vertex
              count closest to, without exceeding, this target), W:int, H:int
              (override RW.W/RW.H, default RW.W/RW.H) } */
  // Douglas-Peucker on an open polyline.
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

  // Simplify a closed ring at a given eps: splits at the point farthest from
  // ring[0] into two open chains (each including ring[0] as an endpoint),
  // DP-simplifies each, merges. `far` optional, precomputed if given.
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

  // Bisects eps (range 0.05-1e5) to the point count closest to, without
  // exceeding, `targetPts`.
  RW._bisectRingToTargetPts = function(ring, targetPts, far){
    let lo = 0.05, hi = 1e5;
    const at = (eps) => RW._simplifyRing(ring, eps, far);
    if (at(lo).length <= targetPts) return at(lo);
    if (at(hi).length > targetPts) return at(hi);
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
    // Chaikin corner-cutting: each vertex -> two points at 25%/75% of adjacent edges.
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

  /* ---------- exact pixel-edge boundary tracer ----------
     Walks the grid edges between pixels: every output edge is horizontal or
     vertical, a vertex only where the walk changes direction. No Chaikin/DP.

     Each foreground pixel's 4 sides bordering background (or out-of-bounds)
     are directed edges between the two grid corners at that side, foreground
     on the RIGHT of travel — right turns cycle N->E->S->W->N, clockwise in
     this codebase's y-down coordinates.

     Starts at the topmost-then-leftmost foreground pixel, no seed param.

     Ambiguous corner (an 8-connected region touching itself diagonally, 2
     valid outgoing directions): take the direction 90 degrees
     COUNTER-CLOCKWISE from the incoming one. Full proof: CLAUDE.md,
     verify_gridboundary.js.

     Output can be a weakly simple polygon (a pinch point revisits one
     corner); a caller simplifying with DP (RW._bisectRingToTargetPts) must
     check for a resulting self-intersection (done in rw_elbow.js).

     opts: { W:int, H:int }. Returns [{x,y}] or null if the mask is empty or
     the walk can't close. */
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
    const maxSteps = 4*fgCount + 8;

    let cx = startX, cy = startY;
    let dir = 'E';
    const verts = [[cx, cy]];
    let steps = 0;
    while (true){
      const [dx,dy] = DIRS[dir];
      cx += dx; cy += dy;
      steps++;
      if (steps > maxSteps) return null;
      if (cx === startX && cy === startY) break;

      // 4 pixels touching this corner: NW=(cx-1,cy-1), NE=(cx,cy-1), SW=(cx-1,cy), SE=(cx,cy).
      const NW = fg(cx-1,cy-1), NE = fg(cx,cy-1), SW = fg(cx-1,cy), SE = fg(cx,cy);
      const validE = SE && !NE, validS = SW && !SE, validW = NW && !SW, validN = NE && !NW;
      const count = (validE?1:0) + (validS?1:0) + (validW?1:0) + (validN?1:0);
      if (count === 0) return null;
      const nextDir = count === 1
        ? (validE ? 'E' : validS ? 'S' : validW ? 'W' : 'N')
        : CCW[dir];
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
    const passes = RW.smoothPasses != null ? RW.smoothPasses : 4;
    const e2 = RW.smoothEps != null ? RW.smoothEps : (eps||1.2);
    return RW._maskToPolygon(uni, {seed:null, smoothPasses:passes, eps:e2});
  };

  /* ---------- direct annotation creation ---------- */
  let tempCounter = 1;
  // notes: optional string, default ''.
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
    st.annotations.push(newAnnotation);
    window.editHistory.push(window.createHistoryEntry('create_annotation', {
      description: 'Draw polygon',
      targetId: newAnnotation.id,
      targetType: 'annotation',
      before: null,
      after: JSON.parse(JSON.stringify(newAnnotation)),
    }));
    return newAnnotation;
  };

  /* ---------- redraw: zoom-button round-trip ---------- */
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
