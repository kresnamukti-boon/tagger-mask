// RW v3.2 — Elbow fitting: drag a box (or click points + double-click to
// close a tighter polygon region) around a pipe fitting and trace the REAL
// linework inside it into a polygon (not a shape inferred from where you
// dragged). Color-pick + tolerance is the primary control over what counts
// as ink; the single largest connected piece inside the box/region is
// selected, traced pixel-exactly (RW._traceGridBoundary), then diagonal/
// curved staircase runs are collapsed into clean chords via the same
// Douglas-Peucker simplifier region commits use (RW._simplifyRing).
//
// Full design history (rejected approaches, live-found bugs, why fuse/hug/
// shrink were removed) lives in CLAUDE.md — this file only carries the
// "why" that's load-bearing for the code itself.
//
// Load LAST (after rw_panelsections.js, needs v31). Depends on:
//   - RW.wall / RW.extract (rw_install.js) — fallback linework source.
//   - RW._buildAnnotationMask (rw_textdetect.js) — excludes already-committed
//     annotations from the detection source.
//   - RW._traceGridBoundary, RW._dpOpen/_simplifyRing/_bisectRingToTargetPts
//     (rw_commit.js) — exact tracing + Douglas-Peucker collapsing.
//   - RW._createPendingAnnotation, RW._forceRender, RW._commitStatus (rw_commit.js).
//   - RW._toNorm/_toPx/_mkSvg (rw_stable.js).
//   - RW.panelSection (rw_panelsections.js) — optional; falls back to the
//     legacy #rw-pick-parentNode bar-append idiom if absent.
(function(){
  const RW = window.__RW;
  if (!RW || !RW.v31) return 'need v3.1 (rw_wallspan.js) first';
  if (RW.v32) return 'v3.2 already installed';
  RW.v32 = true;

  const ac = document.getElementById('annotation-canvas');

  /* ---------- state ---------- */
  RW.elbowMode      = false;
  RW._elbowBoxN     = null;   // detection box {x0,y0,x1,y1}, normalized, min/max-ordered — always set (even for a region, it's the region's own bbox)
  RW._elbowRegionN  = null;   // committed polygon region, normalized [[x,y],...], or null (rectangle-only detection)
  RW._elbowRegionWip = null;  // in-progress (not yet double-clicked closed) polygon vertices, normalized [[x,y],...]
  RW._elbowPoly     = null;   // detected polygon, normalized [{x,y}], or null — one shape (the largest qualifying piece)
  RW._elbowRaster   = null;   // {localW,localH,pad,scale,gx0,gy0, src,selected} — for the Px debug overlay
  RW._elbowMeta     = null;   // {totalComps,candidateComps,keptPx,srcPx,coverage,source,capFallback}
  // Tunables, mask-px, defaults per user preference (not the resolution-scaled formula).
  RW._elbowMinArea  = 1;
  RW._elbowSubAnn   = true;   // subtract already-committed annotations from the detection source
  RW._elbowRes      = 100;    // sample the box at this many x the current mask resolution (RASTER_BUDGET still caps a large box)
  RW._elbowTargetPts = 24;    // 0 = auto; >0 = bisect eps to hit this many output vertices
  RW._elbowPxState  = 0;      // 0 off, 1 source (thresholded+clipped), 2 selected (the piece that gets traced/committed)
  RW._elbowPicking     = false; // one-shot "next click samples a color" mode, armed by the Pick Color button
  RW._elbowTargetColor = null;  // {r,g,b} once picked — replaces the darkness threshold when set
  RW._elbowColorTol    = 100;   // Euclidean RGB distance tolerance, used when RW._elbowTargetColor is set
  RW._elbowDragHandle  = null;  // {type:'box', anchor:[nx,ny]} or {type:'region', index} while dragging an existing corner/vertex

  let downClient  = null;   // client {x,y} at mousedown, for the click-vs-drag threshold
  let dragStartN  = null;   // normalized start corner of the in-progress box drag
  let dragging    = false;
  let elbowRerunTimer = null;
  // Shared 250ms-debounced re-detect, used by both the panel's tunable
  // inputs and handle-dragging below, so dragging doesn't re-run the full
  // raster/trace pipeline on every mousemove frame.
  function scheduleElbowRerun(){
    clearTimeout(elbowRerunTimer);
    elbowRerunTimer = setTimeout(() => { if (RW._elbowBoxN) RW._runElbowDetect(); }, 250);
  }

  // Hit-tests an existing box corner or region vertex against a client
  // point, for click-and-drag editing. Container-relative px, matching
  // RW._toPx's own coordinate space.
  function hitTestElbowHandle(clientX, clientY){
    const cr = document.getElementById('pdf-container').getBoundingClientRect();
    const mx = clientX - cr.x, my = clientY - cr.y;
    const HIT = 10;
    if (RW._elbowRegionN){
      for (let i=0;i<RW._elbowRegionN.length;i++){
        const [px,py] = RW._toPx(RW._elbowRegionN[i][0], RW._elbowRegionN[i][1]);
        if (Math.hypot(px-mx, py-my) <= HIT) return { type:'region', index:i };
      }
    } else if (RW._elbowBoxN){
      const b = RW._elbowBoxN;
      const corners = [[b.x0,b.y0],[b.x1,b.y0],[b.x1,b.y1],[b.x0,b.y1]];
      const opposite = [[b.x1,b.y1],[b.x0,b.y1],[b.x0,b.y0],[b.x1,b.y0]];
      for (let i=0;i<corners.length;i++){
        const [px,py] = RW._toPx(corners[i][0], corners[i][1]);
        if (Math.hypot(px-mx, py-my) <= HIT) return { type:'box', anchor:opposite[i] };
      }
    }
    return null;
  }

  /* ---------- pure geometry/raster helpers (Node-testable, no DOM) ---------- */

  // 8-connected component labeling scoped to a local raster. Tracks each
  // component's size and its min distance to (cx,cy) during the same flood.
  function labelComponents(mask, w, h, cx, cy){
    const labels = new Int32Array(w*h).fill(-1);
    const comps = [];
    for (let s=0; s<w*h; s++){
      if (!mask[s] || labels[s]>=0) continue;
      const id = comps.length;
      const stack=[s]; labels[s]=id;
      let size=0, dCenter=Infinity, x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
      while (stack.length){
        const i = stack.pop(); size++;
        const x=i%w, y=(i/w)|0;
        if (x<x0)x0=x; if (x>x1)x1=x; if (y<y0)y0=y; if (y>y1)y1=y;
        const d = Math.hypot(x-cx, y-cy); if (d<dCenter) dCenter=d;
        for (let dy=-1; dy<=1; dy++){
          for (let dx=-1; dx<=1; dx++){
            if (!dx && !dy) continue;
            const nx=x+dx, ny=y+dy;
            if (nx<0||nx>=w||ny<0||ny>=h) continue;
            const ni = ny*w+nx;
            if (mask[ni] && labels[ni]<0){ labels[ni]=id; stack.push(ni); }
          }
        }
      }
      comps.push({id, size, x0,y0,x1,y1, dCenter});
    }
    return {labels, comps};
  }

  // Shoelace area of a normalized {x,y} polygon, in mask-px^2 (coverage sanity check).
  function shoelaceAreaPx(poly, W, H){
    let a = 0;
    for (let i=0;i<poly.length;i++){
      const p1=poly[i], p2=poly[(i+1)%poly.length];
      a += (p1.x*W)*(p2.y*H) - (p2.x*W)*(p1.y*H);
    }
    return Math.abs(a)/2;
  }
  // Same, for a raw [x,y] (mask-px) ring — used for a drawn region's own area.
  function shoelaceRaw(pts){
    let a = 0;
    for (let i=0;i<pts.length;i++){
      const [x1,y1]=pts[i], [x2,y2]=pts[(i+1)%pts.length];
      a += x1*y2 - x2*y1;
    }
    return Math.abs(a)/2;
  }

  // Segment-intersection test (orientation-based) — used only to check a
  // Douglas-Peucker-capped grid-boundary trace for a genuine self-crossing.
  // RW._traceGridBoundary's raw output can be a WEAKLY simple ring (a pinch
  // point revisits one corner — harmless on its own), and DP could in
  // principle cut across the pinch into a true crossing. Adjacent edges
  // (sharing a ring index, including the wraparound pair) are skipped.
  function segmentsIntersect(p1,p2,p3,p4){
    function orient(a,b,c){ return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]); }
    function onSeg(a,b,c){
      return Math.min(a[0],b[0])<=c[0] && c[0]<=Math.max(a[0],b[0])
          && Math.min(a[1],b[1])<=c[1] && c[1]<=Math.max(a[1],b[1]);
    }
    const o1=orient(p1,p2,p3), o2=orient(p1,p2,p4), o3=orient(p3,p4,p1), o4=orient(p3,p4,p2);
    if (((o1>0&&o2<0)||(o1<0&&o2>0)) && ((o3>0&&o4<0)||(o3<0&&o4>0))) return true;
    if (o1===0 && onSeg(p1,p2,p3)) return true;
    if (o2===0 && onSeg(p1,p2,p4)) return true;
    if (o3===0 && onSeg(p3,p4,p1)) return true;
    if (o4===0 && onSeg(p3,p4,p2)) return true;
    return false;
  }
  function isSimplePolygon(ring){
    const n = ring.length;
    if (n < 3) return false;
    for (let i=0;i<n;i++){
      const a1=ring[i], a2=ring[(i+1)%n];
      for (let j=i+1;j<n;j++){
        if (j === i+1) continue;           // shares vertex ring[i+1]
        if (i === 0 && j === n-1) continue; // wraparound adjacency
        const b1=ring[j], b2=ring[(j+1)%n];
        if (segmentsIntersect(a1,a2,b1,b2)) return false;
      }
    }
    return true;
  }

  // Pixel color-match decision, extracted so it's directly Node-testable
  // without a real canvas. No color picked -> the flat darkness threshold
  // RW.extract also uses; once picked, this REPLACES the darkness test.
  RW._elbowColorMatch = function(r, g, b){
    const tc = RW._elbowTargetColor;
    if (!tc) return Math.min(r,g,b) < 200;
    const tol = RW._elbowColorTol != null ? RW._elbowColorTol : 40;
    const dr=r-tc.r, dg=g-tc.g, db=b-tc.b;
    return Math.sqrt(dr*dr+dg*dg+db*db) < tol;
  };

  // width -> {minArea} seed formula, so the panel's `width` input can stay a
  // one-shot write (see its oninput handler below) rather than a standing
  // recompute rule.
  RW._elbowSeedFromWidth = function(width){
    return { minArea: Math.max(1, Math.round(2.5 * width * width)) };
  };

  // Even-odd scanline fill of a polygon (given in LOCAL raster px already)
  // into a fresh mask — a from-scratch reimplementation rather than reusing
  // RW._paintPoly (rw_masktools.js), which is hardcoded to RW.wall/RW.W/RW.H.
  function rasterizePolyLocal(localPts, w, h){
    const mask = new Uint8Array(w*h);
    let minY=Infinity, maxY=-Infinity;
    for (const [,y] of localPts){ if (y<minY) minY=y; if (y>maxY) maxY=y; }
    minY = Math.max(0, Math.floor(minY)); maxY = Math.min(h-1, Math.ceil(maxY));
    for (let y=minY; y<=maxY; y++){
      const xs=[];
      for (let i=0,j=localPts.length-1; i<localPts.length; j=i++){
        const [xi,yi]=localPts[i], [xj,yj]=localPts[j];
        if ((yi>y)!==(yj>y)) xs.push(xi + (y-yi)/(yj-yi)*(xj-xi));
      }
      xs.sort((a,b)=>a-b);
      for (let k=0;k+1<xs.length;k+=2){
        const xa=Math.max(0,Math.round(xs[k])), xb=Math.min(w-1,Math.round(xs[k+1]));
        for (let x=xa;x<=xb;x++) mask[y*w+x]=1;
      }
    }
    return mask;
  }

  /* ---------- raster acquisition ----------
     Two sources, tried in order. Kept separate from the pure pixel pipeline
     below (RW._elbowProcessRaster) so the Node test suite keeps injecting a
     synthetic raster directly, while the real DOM path stays exercised live. */

  // Eyedropper: sample #pdf-canvas's actual pixel color at a normalized page
  // point. Only meaningful against the real canvas — RW.wall has already
  // thrown color information away by the time it's a binary mask.
  RW._elbowSampleColorAt = function(nx, ny){
    try {
      const src = document.getElementById('pdf-canvas');
      if (!src || typeof src.getContext !== 'function') return null;
      const cv = document.createElement('canvas');
      cv.width = 1; cv.height = 1;
      const ctx = cv.getContext('2d');
      if (!ctx) return null;
      const gx = Math.max(0, Math.min(src.width-1, Math.round(nx*src.width)));
      const gy = Math.max(0, Math.min(src.height-1, Math.round(ny*src.height)));
      ctx.drawImage(src, gx, gy, 1, 1, 0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r:d[0], g:d[1], b:d[2] };
    } catch (e){
      return null;
    }
  };

  // Primary: sample #pdf-canvas directly at `res` x the current mask
  // resolution — sidesteps RW.extract's page-wide width cap so a small box
  // genuinely benefits from more source detail. Returns null (falls through
  // to the RW.wall crop) if the canvas is unavailable, throws, or the
  // sampled region comes back entirely blank.
  RW._elbowAcquireRaster = function(geom){
    try {
      const src = document.getElementById('pdf-canvas');
      if (!src || typeof src.getContext !== 'function') return null;
      const cv = document.createElement('canvas');
      cv.width = geom.localW; cv.height = geom.localH;
      const ctx = cv.getContext('2d');
      if (!ctx) return null;
      // Fill white first: a fresh canvas reads back (0,0,0,0) wherever
      // nothing is drawn, and the darkness threshold would mark that as
      // wall — the pad margin needs to read as genuinely empty.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, geom.localW, geom.localH);
      const dw = geom.rawW*geom.scale, dh = geom.rawH*geom.scale;
      // geom.* are RW.W-space; pdf-canvas's native backing store can be a
      // larger, different resolution when RW.extract's width cap kicked in
      // — scale through nativeScale so drawImage samples the right region
      // (a real bug, found live: an un-scaled crop silently sampled the
      // wrong sub-region on a page where the cap had triggered).
      const nativeScale = src.width / RW.W;
      const sgx0 = geom.gx0*nativeScale, sgy0 = geom.gy0*nativeScale;
      const srawW = geom.rawW*nativeScale, srawH = geom.rawH*nativeScale;
      ctx.drawImage(src, sgx0, sgy0, srawW, srawH, geom.pad, geom.pad, dw, dh);
      const img = ctx.getImageData(0, 0, geom.localW, geom.localH).data;
      const data = new Uint8Array(geom.localW*geom.localH);
      let srcPx = 0;
      for (let i=0;i<data.length;i++){
        if (RW._elbowColorMatch(img[i*4], img[i*4+1], img[i*4+2])){ data[i]=1; srcPx++; }
      }
      if (!srcPx) return null; // blank crop -> fall back rather than report a false empty box
      if (RW._elbowSubAnn && typeof annotationState !== 'undefined'){
        const acv = document.createElement('canvas');
        acv.width = geom.localW; acv.height = geom.localH;
        const actx = acv.getContext('2d');
        actx.fillStyle = '#000';
        for (const a of annotationState.annotations){
          if (a._hidden || a.is_void) continue;
          const pts = a.coordinates; if (!Array.isArray(pts) || pts.length<3) continue;
          actx.beginPath();
          pts.forEach((p,i)=>{
            const X = (p.x*RW.W - geom.gx0)*geom.scale + geom.pad;
            const Y = (p.y*RW.H - geom.gy0)*geom.scale + geom.pad;
            i ? actx.lineTo(X,Y) : actx.moveTo(X,Y);
          });
          actx.closePath(); actx.fill();
        }
        const adata = actx.getImageData(0, 0, geom.localW, geom.localH).data;
        for (let i=0;i<data.length;i++) if (adata[i*4+3]>127) data[i]=0;
      }
      return { data, localW:geom.localW, localH:geom.localH, pad:geom.pad, scale:geom.scale,
        gx0:geom.gx0, gy0:geom.gy0, source:'canvas' };
    } catch (e){
      return null; // e.g. a tainted canvas
    }
  };

  // Fallback: crop the existing page-wide RW.wall mask. Loses anything only
  // visible in RW.wall and not on the real canvas but never hard-fails.
  // Fills each source pixel's full scale x scale destination footprint
  // (not just a single rounded point) so upsampling (`scale`>1) doesn't
  // leave a sparse, gap-riddled pattern.
  function acquireFromWall(geom){
    if (!RW.wall) RW.extract();
    const ann = RW._elbowSubAnn && RW._buildAnnotationMask ? RW._buildAnnotationMask() : null;
    const data = new Uint8Array(geom.localW*geom.localH);
    let srcPx = 0;
    const {W,H} = RW;
    const gx0i = Math.max(0, Math.floor(geom.gx0)), gx1i = Math.min(W-1, Math.ceil(geom.gx0+geom.rawW));
    const gy0i = Math.max(0, Math.floor(geom.gy0)), gy1i = Math.min(H-1, Math.ceil(geom.gy0+geom.rawH));
    for (let gy=gy0i; gy<=gy1i; gy++){
      for (let gx=gx0i; gx<=gx1i; gx++){
        const gi = gy*W+gx;
        if (!RW.wall[gi]) continue;
        if (ann && ann[gi]) continue;
        const lx0 = Math.round((gx-geom.gx0)*geom.scale) + geom.pad;
        const lx1 = Math.round((gx+1-geom.gx0)*geom.scale) + geom.pad;
        const ly0 = Math.round((gy-geom.gy0)*geom.scale) + geom.pad;
        const ly1 = Math.round((gy+1-geom.gy0)*geom.scale) + geom.pad;
        const lxa = Math.max(0,lx0), lxb = Math.min(geom.localW-1, lx1-1);
        const lya = Math.max(0,ly0), lyb = Math.min(geom.localH-1, ly1-1);
        for (let ly=lya; ly<=lyb; ly++){
          for (let lx=lxa; lx<=lxb; lx++){
            const li = ly*geom.localW+lx;
            if (!data[li]){ data[li]=1; srcPx++; }
          }
        }
      }
    }
    return { data, localW:geom.localW, localH:geom.localH, pad:geom.pad, scale:geom.scale,
      gx0:geom.gx0, gy0:geom.gy0, source:'wall', srcPx };
  }

  /* ---------- pure pixel pipeline ----------
     A function of a raster + tunables only — no DOM, directly Node-testable.
     Returns {poly, stages, meta} or {error}. */
  RW._elbowProcessRaster = function(raster, opts){
    const { localW, localH } = raster;
    let src = raster.data;
    // Clip to the region polygon if one is active, otherwise the box's own
    // interior (pad is just working room for the trace/coordinate math near
    // the raster edge — nothing dilates past this clip once applied, since
    // there's no dilation step anymore).
    let clipMask;
    if (opts.regionLocalPts){
      clipMask = rasterizePolyLocal(opts.regionLocalPts, localW, localH);
    } else {
      clipMask = new Uint8Array(localW*localH);
      const { pad } = raster;
      for (let y=pad; y<localH-pad; y++) for (let x=pad; x<localW-pad; x++) clipMask[y*localW+x]=1;
    }
    {
      const masked = new Uint8Array(localW*localH);
      for (let i=0;i<masked.length;i++) masked[i] = src[i] && clipMask[i] ? 1 : 0;
      src = masked;
    }
    let srcPx = 0; for (let i=0;i<src.length;i++) srcPx += src[i];
    if (!srcPx){
      return { error: 'no linework found in that box' +
        (RW._elbowSubAnn ? ' — try turning off "sub ann", or hit Re-extract if the page changed' : ' — hit Re-extract if the page changed') };
    }

    const minAreaLocal = Math.max(1, Math.round(opts.minArea * raster.scale * raster.scale));
    const cx = localW/2, cy = localH/2;

    // Label 8-connected components on the thresholded, clipped source
    // directly — no dilation/bridging. Color-pick + `tol` is the primary
    // control over what counts as ink; a genuinely separate piece just
    // isn't included rather than being forced together.
    const { labels, comps } = labelComponents(src, localW, localH, cx, cy);
    if (!comps.length) return { error: 'no connected shape found inside the box — try picking a color, or raising "tol"' };
    const candidates = comps.filter(c => c.size >= minAreaLocal);
    if (!candidates.length){
      return { error: 'only noise-sized pieces found inside the box — lower "min px"' };
    }
    // Pick the component with the MOST raw pixels.
    candidates.sort((a,b) => b.size - a.size);
    const keep = candidates[0];

    const selected = new Uint8Array(localW*localH);
    for (let i=0;i<selected.length;i++) if (labels[i]===keep.id) selected[i]=1;

    // Exact rectilinear trace — the only tracer.
    let traced = RW._traceGridBoundary(selected, { W:localW, H:localH });
    if (!traced) return { error: 'trace failed — try adjusting the box, the color, or "tol"' };
    const rawAreaPx = shoelaceAreaPx(traced, localW, localH);
    if (rawAreaPx < 4) return { error: 'traced shape is too small (likely noise) — try a bigger box or raise "min px"' };

    // Diagonal collapsing: Douglas-Peucker (RW._simplifyRing /
    // RW._bisectRingToTargetPts, rw_commit.js) on the exact trace's raw
    // vertices — a small fixed eps by default, or bisected to a `pts` target.
    let capFallback = false;
    const targetPts = opts.targetPts != null && opts.targetPts > 0 ? Math.max(5, Math.round(opts.targetPts)) : 0;
    const ring = traced.map(p => [p.x*localW, p.y*localH]);
    const simplifiedRing = targetPts
      ? RW._bisectRingToTargetPts(ring, targetPts, null)
      : RW._simplifyRing(ring, 0.8, null);
    // The raw trace can be only WEAKLY simple (a pinch point) — DP over a
    // pinch could in principle cut across it into a true self-intersection.
    // Fall back to the full uncollapsed trace rather than ship a bad polygon.
    if (isSimplePolygon(simplifiedRing)){
      traced = simplifiedRing.map(([x,y]) => ({ x:+(x/localW).toFixed(6), y:+(y/localH).toFixed(6) }));
    } else {
      capFallback = true;
    }
    if (traced.length < 3) return { error: 'traced shape has too few points' };

    // Map local-normalized -> global mask-px -> page-normalized.
    const poly = traced.map(p => ({
      x: +((((p.x*localW) - raster.pad)/raster.scale + raster.gx0)/RW.W).toFixed(6),
      y: +((((p.y*localH) - raster.pad)/raster.scale + raster.gy0)/RW.H).toFixed(6),
    }));

    return {
      poly,
      stages: { src, selected, localW, localH, pad:raster.pad, scale:raster.scale, gx0:raster.gx0, gy0:raster.gy0 },
      meta: { totalComps: comps.length, candidateComps: candidates.length, keptPx: keep.size, srcPx,
        source: raster.source, res: raster.scale, localW, localH, capFallback },
    };
  };

  /* ---------- orchestrator: acquire a raster, then process it ---------- */
  RW._elbowDetect = function(boxN, opts){
    if (!boxN) return { error: 'no box' };
    opts = opts || {};
    const { W, H } = RW;

    const gx0raw = Math.min(boxN.x0,boxN.x1)*W, gx1raw = Math.max(boxN.x0,boxN.x1)*W;
    const gy0raw = Math.min(boxN.y0,boxN.y1)*H, gy1raw = Math.max(boxN.y0,boxN.y1)*H;
    const gx0 = Math.max(0, gx0raw), gx1 = Math.min(W-1, gx1raw);
    const gy0 = Math.max(0, gy0raw), gy1 = Math.min(H-1, gy1raw);
    const rawW = gx1-gx0, rawH = gy1-gy0;
    if (rawW < 4 || rawH < 4) return { error: "that's a click, not a box — drag out a bigger area around the fitting" };

    // Budget-scale-cap: scale = min(res, sqrt(budget/area)) — bounds a
    // pathologically large box while letting `res` genuinely upscale a
    // normal-sized one.
    const RASTER_BUDGET = 1_500_000;
    const res = RW._elbowRes != null ? RW._elbowRes : 3;
    const scale = Math.min(res, Math.sqrt(RASTER_BUDGET / Math.max(1, rawW*rawH)));
    const pad = Math.max(2, Math.round(2*scale));
    const localW = Math.max(2, Math.round(rawW*scale)) + 2*pad;
    const localH = Math.max(2, Math.round(rawH*scale)) + 2*pad;
    const geom = { gx0, gy0, rawW, rawH, pad, scale, localW, localH };

    let raster = RW._elbowAcquireRaster ? RW._elbowAcquireRaster(geom) : null;
    if (!raster) raster = acquireFromWall(geom);

    let regionLocalPts = null;
    let regionAreaPx = null;
    if (opts.regionN && opts.regionN.length >= 3){
      const globalPts = opts.regionN.map(([nx,ny]) => [nx*W, ny*H]);
      regionLocalPts = globalPts.map(([gx,gy]) => [ (gx-gx0)*scale+pad, (gy-gy0)*scale+pad ]);
      regionAreaPx = shoelaceRaw(globalPts);
    }

    const result = RW._elbowProcessRaster(raster, {
      minArea: RW._elbowMinArea, regionLocalPts, targetPts: RW._elbowTargetPts,
    });
    if (result.error) return result;

    const polyAreaPx = shoelaceAreaPx(result.poly, W, H);
    const boxAreaPx = rawW*rawH;
    // Coverage against the REGION's own area when one is active, not its
    // (larger) bounding box's — otherwise a tight region inside a much
    // looser bbox would read as artificially low coverage.
    result.meta.coverage = regionAreaPx != null
      ? (regionAreaPx>0 ? polyAreaPx/regionAreaPx : 0)
      : (boxAreaPx>0 ? polyAreaPx/boxAreaPx : 0);
    return result;
  };

  /* ---------- sanity check ----------
     Refuses on structurally-broken results; WARNS (doesn't refuse) on a
     high-coverage trace — the user decides whether a near-100% trace is
     right or a sign the box sat inside an existing annotation/solid fill. */
  RW._elbowSanityCheck = function(poly, boxN, meta){
    if (!poly || poly.length < 3) return 'traced shape has too few points';
    if (meta && meta.coverage < 0.0002) return 'found almost nothing inside the box — try picking a color, or raising "tol"';
    const warnings = [];
    if (meta && meta.coverage > 0.95){
      warnings.push('warning: the trace covers ~the whole box — that usually means it sits inside an existing annotation or a solid fill; try lowering "tol" or redrawing tighter');
    }
    if (boxN){
      const areaN = Math.abs(boxN.x1-boxN.x0) * Math.abs(boxN.y1-boxN.y0);
      if (areaN > 0.2) warnings.push('warning: this box covers a large chunk of the page — elbow fittings are small; detection will be dominated by whatever else is in there');
    }
    return warnings.length ? warnings.join(' ') : null;
  };

  /* ---------- run detection + update state/status/preview ---------- */
  RW._runElbowDetect = function(){
    if (!RW._elbowBoxN) return;
    const result = RW._elbowDetect(RW._elbowBoxN, { regionN: RW._elbowRegionN });
    if (result.error){
      RW._elbowPoly = null; RW._elbowMeta = null; RW._elbowRaster = null;
      RW._commitStatus('elbow: ' + result.error);
      RW._renderElbowPreview();
      RW._syncElbowBtns();
      return;
    }
    RW._elbowRaster = result.stages;
    const problem = RW._elbowSanityCheck(result.poly, RW._elbowBoxN, result.meta);
    if (problem && problem.indexOf('warning:') !== 0){
      RW._elbowPoly = null; RW._elbowMeta = result.meta;
      RW._commitStatus('elbow: refused: ' + problem);
      RW._renderElbowPreview();
      RW._syncElbowBtns();
      return;
    }
    RW._elbowPoly = result.poly;
    RW._elbowMeta = result.meta;
    const m = result.meta;
    const pctCov = Math.round((m.coverage||0)*100);
    const colorNote = RW._elbowTargetColor
      ? (m.source==='wall' ? ' — color pick ignored (no canvas access this time, used darkness threshold)' : ' — color-matched')
      : '';
    const piecesNote = m.candidateComps > 1
      ? ' — selected the largest of ' + m.candidateComps + ' candidate pieces (' + m.keptPx + 'px)'
      : '';
    const capNote = m.capFallback
      ? ' — could not simplify safely (a pinch point) — showing the full exact trace instead'
      : '';
    const bigNote = (result.poly.length > 200)
      ? ' — ' + result.poly.length + ' points is a lot; consider setting "pts" to simplify'
      : '';
    RW._commitStatus('elbow: traced ' + result.poly.length + ' pts, ' + pctCov + '% of '
      + (RW._elbowRegionN ? 'region' : 'box') + ' — raster '
      + m.localW + 'x' + m.localH + ' (res ' + m.res.toFixed(2) + 'x, src:' + m.source + ')' + colorNote
      + piecesNote + capNote + bigNote
      + (problem ? ' — ' + problem : '') + ' — Commit Elbow to stage (tunables re-detect live)');
    RW._renderElbowPreview();
    RW._syncElbowBtns();
  };

  /* ---------- interaction: drag a box, OR click a series of points and
     double-click to close a tighter polygon region (same 5px click/drag
     threshold and capture-phase mousedown/mousemove/mouseup/click/dblclick
     template the Rect mask tool / Pipe tool already use) ---------- */
  ac.addEventListener('mousedown', function(e){
    if (!RW.elbowMode) return;
    e.stopPropagation(); e.preventDefault();
    if (!RW._elbowPicking){
      const hit = hitTestElbowHandle(e.clientX, e.clientY);
      if (hit){
        RW._elbowDragHandle = hit;
        downClient = {x:e.clientX, y:e.clientY};
        dragging = false;
        return;
      }
    }
    downClient = {x:e.clientX, y:e.clientY};
    dragStartN = RW._toNorm(e.clientX, e.clientY);
    dragging = false;
  }, true);

  ac.addEventListener('mousemove', function(e){
    if (!RW.elbowMode || !downClient) return;
    e.stopPropagation();
    // dragging an existing box corner or region vertex: mutate it, redraw
    // immediately, and debounce a full re-detect so the traced highlight
    // updates live without re-running the pipeline on every mouse event.
    if (RW._elbowDragHandle){
      const n = RW._toNorm(e.clientX, e.clientY);
      if (RW._elbowDragHandle.type === 'box'){
        const [ax,ay] = RW._elbowDragHandle.anchor;
        RW._elbowBoxN = { x0:Math.min(ax,n[0]), y0:Math.min(ay,n[1]), x1:Math.max(ax,n[0]), y1:Math.max(ay,n[1]) };
      } else {
        RW._elbowRegionN[RW._elbowDragHandle.index] = n;
        const xs=RW._elbowRegionN.map(p=>p[0]), ys=RW._elbowRegionN.map(p=>p[1]);
        RW._elbowBoxN = { x0:Math.min(...xs), y0:Math.min(...ys), x1:Math.max(...xs), y1:Math.max(...ys) };
      }
      RW._renderElbowPreview();
      scheduleElbowRerun();
      return;
    }
    // once a region vertex exists, never fall into rectangle-drag — a shaky
    // click while placing a vertex shouldn't silently discard the polygon.
    if (RW._elbowRegionWip && RW._elbowRegionWip.length) return;
    const d = Math.hypot(e.clientX-downClient.x, e.clientY-downClient.y);
    if (d > 5) dragging = true;
    if (dragging){
      const curN = RW._toNorm(e.clientX, e.clientY);
      RW._renderElbowRect(dragStartN, curN);
    }
  }, true);

  ac.addEventListener('mouseup', function(e){
    if (!RW.elbowMode || !downClient) return;
    e.stopPropagation(); e.preventDefault();
    const down = downClient; downClient = null;
    const rl = document.getElementById('rw-elbow-rect'); if (rl) rl.remove();
    const wasDragging = dragging; dragging = false;
    if (RW._elbowDragHandle){
      // release: settle on an immediate, non-debounced detect so the final
      // result matches exactly where the handle was dropped.
      RW._elbowDragHandle = null;
      clearTimeout(elbowRerunTimer);
      RW._runElbowDetect();
      return;
    }
    if (RW._elbowPicking){
      // one-shot color sample: a plain click while armed samples the ink
      // color at that point instead of placing a vertex/starting a box; a
      // real drag cancels picking without sampling.
      RW._elbowPicking = false;
      if (!wasDragging){
        const n = RW._toNorm(down.x, down.y);
        const c = RW._elbowSampleColorAt(n[0], n[1]);
        if (c){
          RW._elbowTargetColor = c;
          RW._commitStatus('elbow: picked color rgb(' + c.r + ',' + c.g + ',' + c.b + ') — detection now matches this color (tol ' + RW._elbowColorTol + ')');
        } else {
          RW._commitStatus('elbow: could not sample a color there — canvas unavailable');
        }
      }
      RW._syncElbowBtns();
      if (RW._elbowBoxN) RW._runElbowDetect();
      return;
    }
    if (!wasDragging){
      // a plain click: place (or continue) a polygon-region vertex, at the
      // MOUSEDOWN position (not mouseup) so it lands where the user aimed.
      // Every plain click adds a vertex, whether or not one already exists —
      // an earlier version of this handler returned early once a first
      // vertex existed, which silently discarded every click after the
      // first and made a polygon region impossible to ever close.
      if (!RW._elbowRegionWip) RW._elbowRegionWip = [];
      RW._elbowRegionWip.push(RW._toNorm(down.x, down.y));
      dragStartN = null;
      RW._renderElbowPreview();
      return;
    }
    const curN = RW._toNorm(e.clientX, e.clientY);
    const [ax,ay] = dragStartN, [bx,by] = curN;
    dragStartN = null;
    RW._elbowBoxN = { x0:Math.min(ax,bx), y0:Math.min(ay,by), x1:Math.max(ax,bx), y1:Math.max(ay,by) };
    RW._elbowRegionN = null; RW._elbowRegionWip = null;
    RW._runElbowDetect();
  }, true);

  ac.addEventListener('click', function(e){
    if (RW.elbowMode){ e.stopPropagation(); e.preventDefault(); }
  }, true);

  ac.addEventListener('dblclick', function(e){
    if (!RW.elbowMode) return;
    e.stopPropagation(); e.preventDefault();
    if (!RW._elbowRegionWip || RW._elbowRegionWip.length < 3) return;
    // a real double-click fires two full mousedown/mouseup pairs before this
    // event, so the closing click already appended a near-duplicate vertex
    // — drop it.
    const pts = RW._elbowRegionWip.slice();
    const [lx,ly] = pts[pts.length-1], [px,py] = pts[pts.length-2];
    if (Math.hypot(lx-px, ly-py) < 0.002) pts.pop();
    if (pts.length < 3) return;
    RW._elbowRegionN = pts;
    RW._elbowRegionWip = null;
    const xs = pts.map(p=>p[0]), ys = pts.map(p=>p[1]);
    RW._elbowBoxN = { x0:Math.min(...xs), y0:Math.min(...ys), x1:Math.max(...xs), y1:Math.max(...ys) };
    RW._runElbowDetect();
  }, true);

  window.addEventListener('keydown', function(e){
    const t = e.target;
    if (t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (!RW.elbowMode) return;
    if (e.key==='Escape'){
      e.preventDefault(); e.stopImmediatePropagation();
      if (RW._elbowPicking){
        RW._elbowPicking = false;
        RW._syncElbowBtns();
        RW._commitStatus('');
      } else if (RW._elbowRegionWip && RW._elbowRegionWip.length){
        RW._elbowRegionWip = null;
        RW._renderElbowPreview();
      } else if (RW._elbowBoxN || RW._elbowPoly || RW._elbowRegionN){
        RW.clearElbow();
      } else {
        RW.setElbowMode(false);
      }
    }
  }, true);

  // `L` arms/disarms the tool itself — works even when RW.elbowMode is
  // currently false (matches RW.pipeMode's own `C` key, rw_wallspan.js).
  window.addEventListener('keydown', function(e){
    const t = e.target;
    if (t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (e.ctrlKey||e.metaKey||e.altKey) return;
    if (e.key==='l'||e.key==='L'){
      e.preventDefault(); e.stopImmediatePropagation();
      RW.setElbowMode(!RW.elbowMode);
    }
  }, true);

  /* ---------- preview rendering ---------- */
  RW._renderElbowRect = function(aN, bN){
    const svg = RW._mkSvg('rw-elbow-rect', 71);
    const [ax,ay] = RW._toPx(Math.min(aN[0],bN[0]), Math.min(aN[1],bN[1]));
    const [bx,by] = RW._toPx(Math.max(aN[0],bN[0]), Math.max(aN[1],bN[1]));
    svg.innerHTML = '<rect x="'+ax+'" y="'+ay+'" width="'+(bx-ax)+'" height="'+(by-ay)
      + '" fill="rgba(255,140,0,0.08)" stroke="#ff8c00" stroke-width="1.5" stroke-dasharray="5,3"/>';
  };

  RW._renderElbowPreview = function(){
    const old = document.getElementById('rw-elbow-preview'); if (old) old.remove();
    if (!RW.elbowMode || (!RW._elbowBoxN && !(RW._elbowRegionWip && RW._elbowRegionWip.length))){ RW._renderElbowPx(); return; }
    const svg = RW._mkSvg('rw-elbow-preview', 76);
    let html = '';
    if (RW._elbowBoxN && !RW._elbowRegionN){
      const b = RW._elbowBoxN;
      const [bx0,by0] = RW._toPx(b.x0,b.y0), [bx1,by1] = RW._toPx(b.x1,b.y1);
      html += '<rect x="'+bx0+'" y="'+by0+'" width="'+(bx1-bx0)+'" height="'+(by1-by0)
        + '" fill="none" stroke="#ff8c00" stroke-width="1" stroke-dasharray="4,3" opacity="0.6"/>';
      // draggable corner handles
      [[b.x0,b.y0],[b.x1,b.y0],[b.x1,b.y1],[b.x0,b.y1]].forEach(([nx,ny])=>{
        const [px,py] = RW._toPx(nx,ny);
        html += '<circle cx="'+px+'" cy="'+py+'" r="5" fill="#fff" stroke="#ff8c00" stroke-width="2"/>';
      });
    }
    if (RW._elbowRegionN){
      const pts = RW._elbowRegionN.map(([nx,ny]) => { const [px,py]=RW._toPx(nx,ny); return px+','+py; }).join(' ');
      html += '<polygon points="'+pts+'" fill="none" stroke="#ff8c00" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.7"/>';
      // draggable vertex handles
      RW._elbowRegionN.forEach(([nx,ny])=>{
        const [px,py] = RW._toPx(nx,ny);
        html += '<circle cx="'+px+'" cy="'+py+'" r="5" fill="#fff" stroke="#ff8c00" stroke-width="2"/>';
      });
    }
    if (RW._elbowRegionWip && RW._elbowRegionWip.length){
      const pts = RW._elbowRegionWip.map(([nx,ny]) => { const [px,py]=RW._toPx(nx,ny); return px+','+py; }).join(' ');
      html += '<polyline points="'+pts+'" fill="none" stroke="#ff8c00" stroke-width="1.5"/>';
      RW._elbowRegionWip.forEach(([nx,ny])=>{ const [px,py]=RW._toPx(nx,ny); html += '<circle cx="'+px+'" cy="'+py+'" r="3" fill="#ff8c00"/>'; });
    }
    if (RW._elbowPoly && RW._elbowPoly.length >= 3){
      const poly = RW._elbowPoly.map(p => { const [px,py]=RW._toPx(p.x,p.y); return px+','+py; }).join(' ');
      html += '<polygon points="'+poly+'" fill="rgba(255,140,0,0.28)" stroke="#ff8c00" stroke-width="2"/>';
    }
    svg.innerHTML = html;
    RW._renderElbowPx();
  };

  // Debug overlay — a 2-state cycle (source / selected), mirroring the `W`
  // wall-overlay convention. Positioned in PERCENTAGE coordinates of
  // #pdf-container so it stays glued to the drawing through pan/zoom.
  RW._renderElbowPx = function(){
    const old = document.getElementById('rw-elbow-px'); if (old) old.remove();
    if (!RW._elbowPxState || !RW._elbowRaster) return;
    const r = RW._elbowRaster;
    const stageKey = RW._elbowPxState===1 ? 'src' : 'selected';
    const data = r[stageKey];
    if (!data) return;
    const {W,H} = RW;
    const cv = document.createElement('canvas');
    cv.id = 'rw-elbow-px';
    cv.width = r.localW; cv.height = r.localH;
    const leftN = (r.gx0 - r.pad/r.scale) / W;
    const topN  = (r.gy0 - r.pad/r.scale) / H;
    const wN    = (r.localW/r.scale) / W;
    const hN    = (r.localH/r.scale) / H;
    cv.style.cssText = 'position:absolute;left:'+(leftN*100)+'%;top:'+(topN*100)+'%;width:'+(wN*100)+'%;height:'+(hN*100)
      + '%;pointer-events:none;z-index:75;opacity:0.75;image-rendering:pixelated;';
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(r.localW, r.localH);
    for (let i=0;i<data.length;i++) if (data[i]){ img.data[i*4]=255; img.data[i*4+1]=140; img.data[i*4+2]=0; img.data[i*4+3]=220; }
    ctx.putImageData(img,0,0);
    document.getElementById('pdf-container').appendChild(cv);
  };

  /* ---------- commit ---------- */
  RW.commitElbow = async function(){
    if (!annotationState.currentTag){
      RW._commitStatus('no active tag — press a tag number first'); return;
    }
    if (!RW._elbowPoly || RW._elbowPoly.length < 3){
      RW._commitStatus('elbow: nothing traced yet — drag a box (or draw a region) around a fitting first'); return;
    }
    const n = RW._elbowPoly.length;
    const colorDesc = RW._elbowTargetColor
      ? ('color rgb(' + RW._elbowTargetColor.r + ',' + RW._elbowTargetColor.g + ',' + RW._elbowTargetColor.b + '), tol ' + RW._elbowColorTol)
      : 'darkness threshold';
    const a = RW._createPendingAnnotation(RW._elbowPoly,
      'elbow fitting (traced: ' + colorDesc + ', min px ' + RW._elbowMinArea.toFixed(2) + ', res ' + RW._elbowRes.toFixed(2)
      + (RW._elbowRegionN ? ', region' : '') + ')');
    await RW._forceRender();
    RW._lastCommit = [a];
    RW.clearElbow({keepStatus:true});
    RW._commitStatus('staged 1 elbow (' + n + ' pts) — review and Save. To remove it before Save, select it in the app and press Delete.');
  };

  RW.clearElbow = function(opts){
    RW._elbowBoxN = null;
    RW._elbowRegionN = null;
    RW._elbowRegionWip = null;
    RW._elbowPoly = null;
    RW._elbowMeta = null;
    RW._elbowRaster = null;
    RW._elbowPicking = false;
    RW._elbowDragHandle = null;
    clearTimeout(elbowRerunTimer);
    ['rw-elbow-rect','rw-elbow-preview','rw-elbow-px'].forEach(id=>{
      const el = document.getElementById(id); if (el) el.remove();
    });
    if (!opts || !opts.keepStatus) RW._commitStatus('');
    RW._syncElbowBtns();
  };

  /* ---------- mode arm/disarm, cross-disarm both directions ---------- */
  RW.setElbowMode = function(on){
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
      if (RW.pipeMode)      RW.setPipeMode(false);
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      const popup=document.getElementById('selection-popup'); if (popup) popup.style.display='none';
      RW._commitStatus('elbow mode: drag a box, or click points + double-click to close a tighter region, around an elbow fitting');
    }
    RW.elbowMode = !!on;
    ac.style.cursor = on ? 'crosshair' : '';
    if (!on) RW.clearElbow();
    RW._syncElbowBtns();
  };

  ['setPick','setCut','setMaskMode2','setHealBrushMode','setPipeMode'].forEach(fn=>{
    const orig = RW[fn];
    if (typeof orig !== 'function') return;
    RW[fn] = function(arg){
      if (arg && RW.elbowMode) RW.setElbowMode(false);
      return orig.apply(RW, arguments);
    };
  });
  if (RW._syncRectBtn){
    const origSyncRectBtn = RW._syncRectBtn;
    RW._syncRectBtn = function(){
      origSyncRectBtn.apply(RW, arguments);
      if (RW.maskMode==='rect' && RW.elbowMode) RW.setElbowMode(false);
    };
  }

  /* ---------- panel ---------- */
  // Mounts into the FITTINGS section (rw_panelsections.js) if present;
  // otherwise falls back to the legacy bar-append idiom.
  const sec = (RW.panelSection && RW.panelSection('fittings', 'FITTINGS'))
    || (document.getElementById('rw-pick') || {}).parentNode;

  if (sec && !document.getElementById('rw-elbow')){
    const b = document.createElement('button');
    b.id = 'rw-elbow';
    b.title = 'Drag a box (or click points + double-click to close a tighter region) around an elbow fitting; traces the real linework inside it into a polygon that hugs the fitting (curve + any side stub). Once drawn, drag any corner/vertex to reshape it live. Escape backs out one step at a time.';
    b.style.cssText = 'font-size:11px;padding:2px 6px;';
    b.innerText = 'Elbow (L)';
    b.onclick = () => RW.setElbowMode(!RW.elbowMode);
    sec.appendChild(b);

    const commitBtn = document.createElement('button');
    commitBtn.id = 'rw-elbow-commit';
    commitBtn.title = 'Stage the traced elbow shape as a pending polygon annotation.';
    commitBtn.style.cssText = 'font-size:11px;padding:2px 6px;background:rgba(255,140,0,0.25);';
    commitBtn.innerText = 'Commit Elbow';
    commitBtn.onclick = () => RW.commitElbow();
    sec.appendChild(commitBtn);

    const pxBtn = document.createElement('button');
    pxBtn.id = 'rw-elbow-px-btn';
    pxBtn.title = 'Cycle a debug overlay of the detection pixels: off -> source (thresholded+clipped) -> selected (the one piece that will be traced/committed) -> off. Shows what got dropped and why.';
    pxBtn.style.cssText = 'font-size:11px;padding:2px 6px;';
    pxBtn.innerText = 'Px?';
    pxBtn.onclick = () => {
      RW._elbowPxState = (RW._elbowPxState + 1) % 3;
      RW._syncElbowPxBtn();
      RW._renderElbowPx();
    };
    sec.appendChild(pxBtn);

    const pickBtn = document.createElement('button');
    pickBtn.id = 'rw-elbow-pick-color';
    pickBtn.title = 'Click this, then click a pixel on the drawing to sample its ink color. Detection then matches that color (within "tol") instead of the flat darkness threshold — replaces it entirely, not an additional filter.';
    pickBtn.style.cssText = 'font-size:11px;padding:2px 6px;';
    pickBtn.innerText = 'Pick Color';
    pickBtn.onclick = () => {
      RW._elbowPicking = !RW._elbowPicking;
      pickBtn.style.background = RW._elbowPicking ? 'rgba(255,140,0,0.35)' : '';
      RW._commitStatus(RW._elbowPicking ? 'elbow: click a pixel on the drawing to sample its color' : '');
    };
    sec.appendChild(pickBtn);

    const clearColorBtn = document.createElement('button');
    clearColorBtn.id = 'rw-elbow-clear-color';
    clearColorBtn.title = 'Clear the picked color — detection goes back to the flat darkness threshold.';
    clearColorBtn.style.cssText = 'font-size:11px;padding:2px 6px;';
    clearColorBtn.innerText = 'Clear Color';
    clearColorBtn.onclick = () => {
      RW._elbowTargetColor = null;
      RW._commitStatus('elbow: color cleared — back to the darkness threshold');
      if (RW._elbowBoxN) RW._runElbowDetect();
    };
    sec.appendChild(clearColorBtn);

    function numInput(id, label, value, title){
      const l = document.createElement('span');
      l.innerText = label; l.style.cssText = 'font-size:10px;opacity:0.7;margin-left:4px;';
      sec.appendChild(l);
      const inp = document.createElement('input');
      inp.id = id; inp.type='number'; inp.step='any'; inp.value = value;
      inp.title = title;
      inp.style.cssText = 'font-size:11px;padding:1px 4px;width:40px;text-align:right;';
      sec.appendChild(inp);
      return inp;
    }
    const tolInp = numInput('rw-elbow-tol', 'tol', RW._elbowColorTol,
      'Color-match tolerance (Euclidean RGB distance) used once a color has been picked (Pick Color) — the PRIMARY control over what counts as ink now. Has no effect until a color is picked (falls back to the flat darkness threshold).');
    const minInp = numInput('rw-elbow-min', 'min px', RW._elbowMinArea,
      'Minimum connected-shape size (mask px area) to be considered a real candidate rather than noise — the primary defense against a stray pixel being picked as "the largest piece," since there is no dilation step to smooth noise away implicitly.');
    const resInp = numInput('rw-elbow-res', 'res', RW._elbowRes,
      'Sample the detection box at this many times the current mask resolution — higher genuinely adds detail for a small box (up to a pixel budget), not just interpolation.');
    const ptsInp = numInput('rw-elbow-pts', 'pts', RW._elbowTargetPts,
      'Target vertex count for the traced output polygon. 0 = auto (fixed detail level — still collapses genuine diagonal/curved runs into straight chords). The preview and the committed shape are always the same polygon.');
    const widthInp = numInput('rw-elbow-width', 'width', 2,
      'The fitting\'s approximate drawn line thickness in mask px. Entering a value seeds "min px" from THIS instead of a generic guess — a one-time starting point you can still fine-tune directly afterward.');

    const subLabel = document.createElement('label');
    subLabel.style.cssText = 'font-size:10px;opacity:0.7;margin-left:4px;display:inline-flex;align-items:center;gap:2px;';
    subLabel.title = 'Subtract already-committed annotations (e.g. the pipe itself) from the detection so they don\'t dominate as "the largest shape in the box."';
    const subCb = document.createElement('input');
    subCb.type = 'checkbox'; subCb.id = 'rw-elbow-subann'; subCb.checked = !!RW._elbowSubAnn;
    subLabel.appendChild(subCb);
    subLabel.appendChild(document.createTextNode('sub ann'));
    sec.appendChild(subLabel);

    minInp.oninput    = () => { const v=parseFloat(minInp.value);    if (!isNaN(v) && v>=0){ RW._elbowMinArea=v; scheduleElbowRerun(); } };
    resInp.oninput    = () => { const v=parseFloat(resInp.value);    if (!isNaN(v) && v>0){  RW._elbowRes=v;     scheduleElbowRerun(); } };
    ptsInp.oninput    = () => { const v=parseInt(ptsInp.value,10);   if (!isNaN(v) && v>=0){ RW._elbowTargetPts=v; scheduleElbowRerun(); } };
    tolInp.oninput    = () => { const v=parseFloat(tolInp.value);    if (!isNaN(v) && v>=0){ RW._elbowColorTol=v; scheduleElbowRerun(); } };
    // width is a ONE-SHOT seed, not a standing tunable — writes a concrete
    // value into "min px" once, exactly like typing into that input directly.
    widthInp.oninput  = () => {
      const v = parseFloat(widthInp.value);
      if (isNaN(v) || v<=0) return;
      RW._elbowMinArea = RW._elbowSeedFromWidth(v).minArea;
      minInp.value = RW._elbowMinArea;
      scheduleElbowRerun();
    };
    subCb.onchange    = () => { RW._elbowSubAnn = subCb.checked; scheduleElbowRerun(); };
  }

  RW._syncElbowPxBtn = function(){
    const pxBtn = document.getElementById('rw-elbow-px-btn');
    if (!pxBtn) return;
    const labels = ['Px?','Px:src','Px:selected'];
    pxBtn.innerText = labels[RW._elbowPxState] || 'Px?';
    pxBtn.style.background = RW._elbowPxState ? 'rgba(255,140,0,0.35)' : '';
  };

  RW._syncElbowBtns = function(){
    const b = document.getElementById('rw-elbow');
    if (b) b.style.background = RW.elbowMode ? 'rgba(255,140,0,0.35)' : '';
    const c = document.getElementById('rw-elbow-commit');
    if (c) c.disabled = !(RW._elbowPoly && RW._elbowPoly.length >= 3);
    const p = document.getElementById('rw-elbow-pick-color');
    if (p) p.style.background = RW._elbowPicking ? 'rgba(255,140,0,0.35)' : '';
    RW._syncElbowPxBtn();
  };
  RW._syncElbowBtns();

  const hideBtn = document.getElementById('rw-hide');
  if (hideBtn){
    const origHideClick = hideBtn.onclick;
    hideBtn.onclick = function(){
      if (origHideClick) origHideClick.apply(this, arguments);
      ['rw-elbow-preview','rw-elbow-px'].forEach(id=>{
        const el = document.getElementById(id);
        if (el) el.style.display = (el.style.display==='none') ? '' : 'none';
      });
    };
  }

  return 'v3.2 up: Elbow fitting — drag a box (L), traces the real fitting inside it, Commit Elbow';
})()
