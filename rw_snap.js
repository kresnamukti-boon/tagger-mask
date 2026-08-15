// RW v2.7 — vertex snapping for the Poly2 tool.
// Load AFTER rw_brushpoly.js (needs v2.6). Snaps Poly2 vertices (mousedown)
// and the live preview point (mousemove) to nearby line endpoints/
// intersections on the wall bitmap, or to any included region's outline.
//
// Pipeline (rebuilt lazily on RW._snapDirty):
//   1. Density-prefilter RW.wall (RW._buildThinMask, integral image).
//   2. Skeletonize (Zhang-Suen thinning, active-list based).
//   3. Classify by 8-neighbor count: 1 = endpoint, 3+ = junction, 2 = not a candidate.
//   4. Cluster nearby candidates (junction wins over endpoint in a mixed cluster).
//   5. RW._buildEdgePoints adds every included region's boundary pixel as its
//      own unclustered 'edge' candidate.
//   6. Index all points in a bucket grid; catch radius (RW._snapCatchPx)
//      recomputed per-query, ~14 screen px regardless of zoom.
(function(){
  const RW = window.__RW;
  if (!RW || !RW.v26) return 'need v2.6 first';
  if (RW.v27) return 'v2.7 already installed';
  RW.v27 = true;

  RW._snapEnabled = true;
  RW._snapDirty = true;
  RW._snapPoints = [];
  RW._lastSnapHit = null;

  /* ---------- 1. density prefilter (integral image) ---------- */
  // Window radius/density threshold deciding "thin line" vs "fill/hatch".
  // Scaled like _areaFloor (2592-px baseline).
  RW._snapFillRadiusPx = function(){
    return Math.max(4, Math.round(10 * (RW.W/2592)));
  };
  RW._snapFillDensityThresh = 0.55;

  RW._buildThinMask = function(){
    const {W,H,wall} = RW;
    // Summed-area table, padded with a zero row/col.
    const integ = new Float64Array((W+1)*(H+1));
    for (let y=0;y<H;y++){
      let rowSum=0;
      const rowBase=(y+1)*(W+1), prevBase=y*(W+1);
      for (let x=0;x<W;x++){
        rowSum += wall[y*W+x];
        integ[rowBase+x+1] = integ[prevBase+x+1] + rowSum;
      }
    }
    function S(x,y){ return integ[(y+1)*(W+1)+(x+1)]; }
    function windowSum(x0,y0,x1,y1){
      x0=Math.max(0,x0); y0=Math.max(0,y0); x1=Math.min(W-1,x1); y1=Math.min(H-1,y1);
      return S(x1,y1) - S(x0-1,y1) - S(x1,y0-1) + S(x0-1,y0-1);
    }
    const r = RW._snapFillRadiusPx();
    const winArea = (2*r+1)*(2*r+1);
    const capacity = winArea * RW._snapFillDensityThresh;
    const thin = new Uint8Array(W*H);
    for (let y=0;y<H;y++) for (let x=0;x<W;x++){
      const i=y*W+x;
      if (!wall[i]) continue;
      if (windowSum(x-r,y-r,x+r,y+r) <= capacity) thin[i]=1;
    }
    return thin;
  };

  /* ---------- 2. skeletonize (Zhang-Suen, active-list optimized) ---------- */
  // seed: the already density-filtered mask.
  RW._skeletonize = function(seed){
    const {W,H} = RW;
    const skel = new Uint8Array(seed);
    let active = [];
    for (let i=0;i<W*H;i++) if (skel[i]) active.push(i);

    // 8-neighbors clockwise from north (P2..P9, Zhang-Suen paper). Border
    // pixels are skipped (never deleted/classified).
    let changed = true, iter = 0;
    while (changed && iter < 60){
      changed = false; iter++;
      const del1 = [];
      for (const i of active){
        if (!skel[i]) continue;
        const x=i%W, y=(i/W)|0;
        if (x===0||x===W-1||y===0||y===H-1) continue;
        const n0=skel[i-W], n1=skel[i-W+1], n2=skel[i+1], n3=skel[i+W+1],
              n4=skel[i+W], n5=skel[i+W-1], n6=skel[i-1], n7=skel[i-W-1];
        const B = n0+n1+n2+n3+n4+n5+n6+n7;
        if (B<2||B>6) continue;
        let A=0;
        if (n0===0&&n1===1)A++; if(n1===0&&n2===1)A++; if(n2===0&&n3===1)A++; if(n3===0&&n4===1)A++;
        if (n4===0&&n5===1)A++; if(n5===0&&n6===1)A++; if(n6===0&&n7===1)A++; if(n7===0&&n0===1)A++;
        if (A!==1) continue;
        if (n0*n2*n4!==0) continue; // P2*P4*P6
        if (n2*n4*n6!==0) continue; // P4*P6*P8
        del1.push(i);
      }
      if (del1.length){ for (const i of del1) skel[i]=0; changed=true; }

      const del2 = [];
      for (const i of active){
        if (!skel[i]) continue;
        const x=i%W, y=(i/W)|0;
        if (x===0||x===W-1||y===0||y===H-1) continue;
        const n0=skel[i-W], n1=skel[i-W+1], n2=skel[i+1], n3=skel[i+W+1],
              n4=skel[i+W], n5=skel[i+W-1], n6=skel[i-1], n7=skel[i-W-1];
        const B = n0+n1+n2+n3+n4+n5+n6+n7;
        if (B<2||B>6) continue;
        let A=0;
        if (n0===0&&n1===1)A++; if(n1===0&&n2===1)A++; if(n2===0&&n3===1)A++; if(n3===0&&n4===1)A++;
        if (n4===0&&n5===1)A++; if(n5===0&&n6===1)A++; if(n6===0&&n7===1)A++; if(n7===0&&n0===1)A++;
        if (A!==1) continue;
        if (n0*n2*n6!==0) continue; // P2*P4*P8
        if (n0*n4*n6!==0) continue; // P2*P6*P8
        del2.push(i);
      }
      if (del2.length){ for (const i of del2) skel[i]=0; changed=true; }

      if (changed) active = active.filter(i=>skel[i]);
    }
    return {skel, pts: active};
  };

  /* ---------- 3. classify skeleton points ---------- */
  RW._classifySkeleton = function(skel, pts){
    const {W,H} = RW;
    const candidates = [];
    for (const i of pts){
      const x=i%W, y=(i/W)|0;
      if (x===0||x===W-1||y===0||y===H-1) continue;
      const c = skel[i-W]+skel[i-W+1]+skel[i+1]+skel[i+W+1]
              + skel[i+W]+skel[i+W-1]+skel[i-1]+skel[i-W-1];
      if (c===1) candidates.push({x,y,kind:'endpoint'});
      else if (c>=3) candidates.push({x,y,kind:'junction'});
    }
    return candidates;
  };

  /* ---------- 4. cluster nearby candidates ---------- */
  RW._clusterPoints = function(candidates, mergeR){
    const buckets = new Map();
    const clusters = [];
    for (const p of candidates){
      const bx=(p.x/mergeR)|0, by=(p.y/mergeR)|0;
      let found = null;
      outer:
      for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++){
        const arr = buckets.get((bx+dx)+'_'+(by+dy));
        if (!arr) continue;
        for (const c of arr){
          const ddx=c.x-p.x, ddy=c.y-p.y;
          if (ddx*ddx+ddy*ddy <= mergeR*mergeR){ found=c; break outer; }
        }
      }
      if (found){
        found.sx+=p.x; found.sy+=p.y; found.n++;
        found.x = found.sx/found.n; found.y = found.sy/found.n;
        if (p.kind==='junction') found.kind='junction'; // junction beats endpoint
      } else {
        const c = {x:p.x,y:p.y,sx:p.x,sy:p.y,n:1,kind:p.kind};
        clusters.push(c);
        const k = ((c.x/mergeR)|0)+'_'+((c.y/mergeR)|0);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(c);
      }
    }
    return clusters;
  };

  /* ---------- 5. region-outline edge points (single-pass, unclustered) ---------- */
  RW._buildEdgePoints = function(){
    const {W,H,labels,regions} = RW;
    const edgePts = [];
    function group(x,y){
      const l = labels[y*W+x];
      return (l>=0 && regions[l] && regions[l].included) ? regions[l].group : null;
    }
    for (let y=0;y<H;y++){
      for (let x=0;x<W;x++){
        const g = group(x,y);
        if (g===null) continue;
        const isBoundary =
          (x===0   || group(x-1,y)!==g) ||
          (x===W-1 || group(x+1,y)!==g) ||
          (y===0   || group(x,y-1)!==g) ||
          (y===H-1 || group(x,y+1)!==g);
        if (isBoundary) edgePts.push({x,y,kind:'edge'});
      }
    }
    return edgePts;
  };

  /* ---------- 6. spatial index + zoom-invariant catch radius ---------- */
  RW._snapMergeRadiusPx = function(){
    return Math.max(3, Math.round(6 * (RW.W/2592)));
  };
  RW._snapCellPx = function(){
    return Math.max(4, Math.round(RW.W/200));
  };
  RW._snapCatchPx = function(){
    const cr = document.getElementById('pdf-container').getBoundingClientRect();
    return (14 / cr.width) * RW.W;
  };

  RW._buildSnapIndex = function(){
    const cell = RW._snapCellPx();
    RW._snapCell = cell;
    const grid = new Map();
    for (const p of RW._snapPoints){
      const k = ((p.x/cell)|0)+'_'+((p.y/cell)|0);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    }
    RW._snapGrid = grid;
  };

  RW._nearestSnapPoint = function(mx, my){
    const grid = RW._snapGrid; if (!grid) return null;
    const cell = RW._snapCell;
    const rad = RW._snapCatchPx();
    const bx=(mx/cell)|0, by=(my/cell)|0;
    const c = Math.max(1, Math.ceil(rad/cell));
    let best=null, bestD=rad*rad;
    for (let dy=-c;dy<=c;dy++) for (let dx=-c;dx<=c;dx++){
      const arr = grid.get((bx+dx)+'_'+(by+dy));
      if (!arr) continue;
      for (const p of arr){
        const ddx=p.x-mx, ddy=p.y-my;
        const d=ddx*ddx+ddy*ddy;
        if (d<bestD){ bestD=d; best=p; }
      }
    }
    return best;
  };

  RW._buildSnapPoints = function(){
    if (!RW.wall || !RW.W || !RW.H){ RW._snapPoints=[]; RW._skeletonCandidates=[]; RW._snapDirty=false; return; }
    const thin = RW._buildThinMask();
    const {skel, pts} = RW._skeletonize(thin);
    const candidates = RW._classifySkeleton(skel, pts);
    RW._skeletonCandidates = candidates;
    const clustered = RW._clusterPoints(candidates, RW._snapMergeRadiusPx());
    const edgePts = (RW.labels && RW.regions) ? RW._buildEdgePoints() : [];
    RW._snapPoints = clustered.concat(edgePts);
    RW._buildSnapIndex();
    RW._snapDirty = false;
  };

  // nx,ny normalized page coords. Returns [nx,ny], snapped if enabled and a hit was found.
  RW._trySnap = function(nx, ny){
    if (!RW._snapEnabled){ RW._lastSnapHit=null; return [nx, ny]; }
    if (RW._snapDirty) RW._buildSnapPoints();
    if (!RW._snapPoints || !RW._snapPoints.length){ RW._lastSnapHit=null; return [nx, ny]; }
    const mx = nx*RW.W, my = ny*RW.H;
    const hit = RW._nearestSnapPoint(mx, my);
    RW._lastSnapHit = hit || null;
    if (!hit) return [nx, ny];
    return [hit.x/RW.W, hit.y/RW.H];
  };

  /* ---------- invalidate on any wall-bitmap change ---------- */
  const origRelabel = RW._relabel;
  RW._relabel = function(){ const r = origRelabel.apply(RW, arguments); RW._snapDirty = true; return r; };
  const origExtract = RW.extract;
  RW.extract = function(){ const r = origExtract.apply(RW, arguments); RW._snapDirty = true; return r; };

  /* ---------- snap-hit marker on the poly2 preview ---------- */
  (function(){
    const orig = RW._renderPreview;
    RW._renderPreview = function(cursorClient){
      const ret = orig.call(RW, cursorClient);
      if (RW.maskMode2==='poly2' && RW._lastSnapHit){
        const svg = document.getElementById('rw-polyline');
        if (svg){
          const [px,py] = RW._toPx(RW._lastSnapHit.x/RW.W, RW._lastSnapHit.y/RW.H);
          const ring = document.createElementNS('http://www.w3.org/2000/svg','circle');
          ring.setAttribute('cx', px); ring.setAttribute('cy', py); ring.setAttribute('r', 6);
          ring.setAttribute('fill','none');
          ring.setAttribute('stroke', RW._lastSnapHit.kind==='junction' ? '#0f0' : RW._lastSnapHit.kind==='endpoint' ? '#0ff' : '#ff0');
          ring.setAttribute('stroke-width','2');
          svg.appendChild(ring);
        }
      }
      return ret;
    };
  })();

  /* ---------- panel toggle ---------- */
  const bar = (document.getElementById('rw-pick') || {}).parentNode;
  if (bar && !document.getElementById('rw-snap')){
    const sb = document.createElement('button');
    sb.id = 'rw-snap';
    sb.title = 'Snap Poly2 vertices to nearby line endpoints/intersections (green/cyan) or along any included region\'s outline (yellow). Hold Shift while clicking to place a vertex without snapping.';
    sb.style.cssText = 'font-size:11px;padding:2px 6px;';
    function sync(){
      sb.innerText = 'Snap ' + (RW._snapEnabled ? 'On' : 'Off');
      sb.style.background = RW._snapEnabled ? 'rgba(50,205,50,0.3)' : '';
    }
    sb.onclick = ()=>{ RW._snapEnabled = !RW._snapEnabled; sync(); };
    bar.appendChild(sb);
    sync();
  }

  return 'v2.7 up: Poly2 vertex snapping (endpoints/intersections + region outlines). Shift bypasses.';
})()
