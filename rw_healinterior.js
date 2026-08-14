// RW v3 — interior noise healing.
//
// Status: shipped, in both console loaders. Paused for a time after four
// rounds of live testing each surfacing a genuinely different failure mode
// (see below); a fifth round (annotation-knockout protection) fixed the
// remaining known issue and this was re-enabled. If a new failure mode turns
// up, read the five rounds below first before assuming it's something new —
// the fix for one round has occasionally looked like it broke another.
//
// Reframed from the whole-page text-density overlay (rw_textdetect.js) after
// live testing showed the real problem isn't "where does text sit on the
// page" — it's "which wall pixels inside a region about to be committed are
// pure interior noise (text/hatch/dimension/leader marks) versus the
// region's genuine perimeter." Dimension/extension/leader lines legitimately
// touch a region's true boundary and reach into its interior, so the commit
// contour trace doesn't just ignore them — it weaves in and follows the
// text/hatch shape itself, producing a jagged polygon instead of one clean
// outline.
//
// Five failure modes found live, in order:
//   1. Connected-component veto (flood all touching wall into one blob, veto
//      the WHOLE blob if any part touches something unsafe) was fatally
//      coarse — dimension/leader lines touch the real perimeter often enough
//      that nearly all interior noise ends up wall-connected to the true
//      boundary into one network. Measured: a real region's wall split into
//      4 components, the largest 65% of all wall in its bbox, ALL vetoed.
//   2. Per-pixel safety test (fixed the veto problem) but bounded by a small
//      padding around the region's own OPEN-pixel bounding box — wrong on a
//      hatch-heavy job, where that open "clearing" can sit deep inside a much
//      larger connected mass of hatch fill. The padding never reached real
//      exterior, so 100% of wall in the window came back "safe."
//   3. Unbounded reachability flood (let the search stop naturally at real
//      barriers instead of guessing a padding size) fixed #2, but on a page
//      with only ONE included region, there was nothing nearby to fence the
//      search in — it explored ~2.65M pixels, nearly the whole non-blank
//      page, before hitting a real barrier anywhere.
//   4. Added a size threshold so a neighboring non-included area only counts
//      as "protected" if it's bigger than a tunable hole-size cutoff (a
//      building's room is not "tiny noise" the way a letter's hole is) — but
//      this can't help when the "room" isn't even a separate label to begin
//      with: door-opening gaps in the linework had already merged a real
//      building's floor plan into the SAME connected open region as the
//      pavement around it, so its walls were floating inside one blob with
//      no second region to be "not merged with" in the first place. From
//      pure wall/label topology, that's indistinguishable from actual noise.
//   5. (Fixed, currently shipped.) Existing committed annotations get knocked
//      out into RW.wall as uniform filled interior (the same step
//      RW.extract() already does so they're never re-proposed as candidate
//      regions) — but that knockout doesn't distinguish itself from
//      text/hatch wall, so a wall pixel deep inside an already-annotated area
//      looked exactly as "safe" as real noise. Healing tried to erase into
//      already-completed territory. Fixed by rebuilding the same
//      annotation-knockout mask here and hard-excluding it, both from the
//      reachability flood (never steps into it) and as a final filter on the
//      result (belt-and-suspenders, given the history above).
//
// The throughline: this approach can only ever reason from wall/label
// topology, and real drawings have cases (structure connected via a small
// gap, hatch-heavy jobs with no nearby second region, already-annotated
// territory with no distinguishing marker) where topology alone doesn't
// encode the distinction a human makes by recognizing the content.
(function(){
  const RW = window.__RW;
  // Needs v26 (rw_brushpoly.js), not just v23 — the cross-disarm wrap below
  // reads RW.setMaskMode2, which doesn't exist until rw_brushpoly.js has
  // loaded. Loading this module before that point silently skipped the wrap
  // (the `if (RW.setMaskMode2)` guard just found nothing to wrap) rather than
  // erroring, so arming Poly2/Brush didn't disarm the heal brush as intended
  // — confirmed live. Gating on v26 turns that into a loud, obvious bail
  // instead of a silent partial failure if the load order ever regresses.
  if (!RW || !RW.v26) return 'need v2.6 (rw_brushpoly.js) first';
  if (RW.v3) return 'v3 already installed';
  RW.v3 = true;

  RW._healPreviewOn = false;
  RW._healNoiseMask = null;

  // For the given set of groups, find wall pixels that are both:
  //   (a) RELEVANT — reachable from the region's own open pixels through a
  //       path of only wall/same-region pixels (never crossing into exterior,
  //       a different included region, or a tiny excluded speck), and
  //   (b) SAFE — none of the pixel's own 4-neighbors are true unenclosed
  //       exterior or a different included region (a purely local, per-pixel
  //       test, not a connected-component veto).
  //
  // Earlier attempts got both parts wrong in different ways:
  //  - v1 used connected-component flood + "if ANY part of the component ever
  //    touches something bad, veto the WHOLE component." Fatally coarse:
  //    dimension/leader lines and hatch marks routinely touch the real
  //    perimeter by a pixel or two, so nearly all interior noise ended up
  //    wall-connected to the true boundary into one giant network — measured
  //    live, a real region's wall pixels formed 4 components, the largest
  //    65% of all wall pixels in its bbox, ALL vetoed together.
  //  - v2 (per-pixel test alone, bounded by a small fixed padding around the
  //    region's own open-pixel bounding box) fixed the veto problem but
  //    revealed a second one: on a hatch-heavy job, a region's own open
  //    pixels can be a small clearing deeply embedded in a much larger mass
  //    of dense hatch fill, so a small fixed pad never reaches anywhere near
  //    the true exterior-facing edge — measured live, 100% of wall in the
  //    padded window came back "safe" because NONE of it was close enough to
  //    touch real exterior within that window at all.
  //
  // Bounding by REACHABILITY (rather than guessing a padding size) fixes
  // this: the flood naturally stops wherever it would have to cross into
  // exterior/a different region/a tiny speck, however far that actually is,
  // and the per-pixel test (applied only within that reachable set) is what
  // avoids the whole-component veto bug.
  RW._computeInteriorNoise = function(gids){
    const {W,H,labels,regions,wall} = RW;
    const memberIds = new Set(regions.filter(r=>gids.has(r.group)).map(r=>r.id));
    if (!memberIds.size) return null;

    const isSameRegion = i => { const l=labels[i]; return l>=0 && memberIds.has(l); };

    // A neighboring open area counts as "protected" (never merge into it) if
    // it's either already included, OR bigger than RW._healNoiseHoleMax — a
    // dedicated, separately-tunable threshold for "how big can a hole be
    // before it's a real feature rather than negligible noise." This is
    // deliberately NOT the same value as RW._areaFloor: that one answers "is
    // this worth showing as a selectable candidate region" and is tuned for
    // that purpose (session default seen live: 6026px). A building's floor
    // plan drawn inside a large pavement region has its own room interiors as
    // separate labeled areas — confirmed live, several rooms measured
    // 868–5296px, all comfortably BELOW that area-floor value, so reusing it
    // here failed to protect them: real rooms and text-glyph holes both
    // count as "not included," but they're very different sizes, and a hole
    // threshold needs to sit well below real-feature size, not above it.
    const holeMax = RW._healNoiseHoleMax != null ? RW._healNoiseHoleMax : Math.round(300*(RW.W/2592));
    const isProtectedRegion = i => {
      const l = labels[i];
      if (l<0 || memberIds.has(l)) return false;
      const r = regions[l];
      return !!r && (r.included || r.size > holeMax);
    };

    // Existing committed annotations get knocked out into RW.wall as filled
    // interiors (the same step RW.extract() already does, so they never get
    // re-proposed as candidate regions) — but that knockout is just uniform
    // wall, with nothing distinguishing "wall because an already-completed
    // annotation lives here" from "wall because it's text/hatch." A wall
    // pixel deep inside an existing annotation is surrounded by more wall on
    // all sides, never touching a labeled region or true exterior, so it
    // looked exactly as "safe" as real noise — confirmed live: healing tried
    // to erase into already-annotated territory. Rebuilding that same
    // knockout mask here (mirroring RW.extract()'s own logic) and hard-
    // excluding it from the result fixes this directly, regardless of what
    // the reachability/per-pixel checks above conclude.
    const annotationMask = new Uint8Array(W*H);
    if (typeof annotationState !== 'undefined'){
      const cv = document.createElement('canvas'); cv.width=W; cv.height=H;
      const actx = cv.getContext('2d');
      actx.fillStyle = '#000';
      for (const a of annotationState.annotations){
        if (a._hidden || a.is_void) continue;
        // Array.isArray, not just !pts.length — a bbox-type annotation stores
        // coordinates as {x,y,width,height}, not a point array; that object
        // has no .length at all, and `undefined < 3` is false in JS, so the
        // old `pts.length<3` guard let it silently through to pts.forEach(),
        // which doesn't exist on a plain object. Confirmed live.
        const pts = a.coordinates; if (!Array.isArray(pts) || pts.length<3) continue;
        actx.beginPath();
        pts.forEach((p,idx)=>{ const X=p.x*W, Y=p.y*H; idx?actx.lineTo(X,Y):actx.moveTo(X,Y); });
        actx.closePath(); actx.fill();
      }
      const adata = actx.getImageData(0,0,W,H).data;
      for (let i=0;i<W*H;i++) if (adata[i*4+3]>127) annotationMask[i]=1;
    }

    // True-unenclosed-exterior mask (reachable from the sheet border without
    // crossing a wall or any protected region), mirroring the same
    // border-protected flood RW._relabel already uses internally.
    const exterior = new Uint8Array(W*H);
    {
      const q = [];
      for (let x=0;x<W;x++){ q.push(x,(H-1)*W+x); }
      for (let y=0;y<H;y++){ q.push(y*W,y*W+W-1); }
      while (q.length){
        const i = q.pop();
        if (exterior[i] || wall[i]) continue;
        if (isProtectedRegion(i)) continue;
        exterior[i]=1;
        const x=i%W, y=(i/W)|0;
        if (x>0) q.push(i-1); if (x<W-1) q.push(i+1);
        if (y>0) q.push(i-W); if (y<H-1) q.push(i+W);
      }
    }

    // Reachability flood: from the region's own open pixels, step only into
    // more same-region-open or wall pixels — never into exterior, a
    // different included region, or a tiny speck (those are natural stopping
    // barriers, not something to tunnel past). Everything this reaches is
    // "relevant" wall; anything it can't reach is irrelevant to this region
    // and left alone regardless of how the per-pixel test alone would judge it.
    const reachableWall = new Uint8Array(W*H);
    const seenReach = new Uint8Array(W*H);
    const q2 = [];
    for (let i=0;i<W*H;i++) if (isSameRegion(i)){ seenReach[i]=1; q2.push(i); }
    while (q2.length){
      const i = q2.pop();
      const x=i%W, y=(i/W)|0;
      const neigh = [];
      if (x>0) neigh.push(i-1);
      if (x<W-1) neigh.push(i+1);
      if (y>0) neigh.push(i-W);
      if (y<H-1) neigh.push(i+W);
      for (const n of neigh){
        if (seenReach[n]) continue;
        if (annotationMask[n]) continue; // never enter an existing annotation's knockout
        if (wall[n]===1){ seenReach[n]=1; reachableWall[n]=1; q2.push(n); }
        else if (isSameRegion(n)){ seenReach[n]=1; q2.push(n); }
        // otherIncluded / exterior / tiny-speck-open: stop here, don't cross
      }
    }

    // Per-pixel safety test, restricted to the reachable wall set.
    const noise = new Uint8Array(W*H);
    for (let i=0;i<W*H;i++){
      if (!reachableWall[i] || annotationMask[i]) continue; // belt-and-suspenders on top of the flood exclusion above
      const x=i%W, y=(i/W)|0;
      let safe = true;
      if (x>0 && (exterior[i-1] || isProtectedRegion(i-1) || annotationMask[i-1])) safe=false;
      if (safe && x<W-1 && (exterior[i+1] || isProtectedRegion(i+1) || annotationMask[i+1])) safe=false;
      if (safe && y>0 && (exterior[i-W] || isProtectedRegion(i-W) || annotationMask[i-W])) safe=false;
      if (safe && y<H-1 && (exterior[i+W] || isProtectedRegion(i+W) || annotationMask[i+W])) safe=false;
      if (safe) noise[i]=1;
    }
    return noise;
  };

  RW._renderHealPreview = function(){
    const old = document.getElementById('rw-heal-overlay'); if (old) old.remove();
    if (!RW._healPreviewOn || !RW._healNoiseMask) return;
    const {W,H} = RW;
    const ov = document.createElement('canvas');
    ov.id = 'rw-heal-overlay';
    ov.width = W; ov.height = H;
    ov.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:47;opacity:0.75;image-rendering:pixelated;';
    const ctx = ov.getContext('2d');
    const img = ctx.createImageData(W,H);
    const mask = RW._healNoiseMask;
    for (let i=0;i<W*H;i++) if (mask[i]){ img.data[i*4]=255; img.data[i*4+1]=140; img.data[i*4+2]=0; img.data[i*4+3]=220; }
    ctx.putImageData(img,0,0);
    document.getElementById('pdf-container').appendChild(ov);
  };

  RW.toggleHealPreview = function(){
    if (!RW.selected.size){
      RW._healPreviewOn = false; RW._healNoiseMask = null; RW._renderHealPreview();
      RW._syncHealButtons();
      return;
    }
    RW._healPreviewOn = !RW._healPreviewOn;
    RW._healNoiseMask = RW._healPreviewOn ? RW._computeInteriorNoise(RW.selected) : null;
    RW._renderHealPreview();
    RW._syncHealButtons();
  };

  RW.applyHeal = function(){
    if (!RW._healNoiseMask) return;
    RW._snapshot('heal-interior');
    const {W,H,wall} = RW;
    let erased = 0;
    for (let i=0;i<W*H;i++) if (RW._healNoiseMask[i]){ wall[i]=0; erased++; }
    RW._healPreviewOn = false;
    RW._healNoiseMask = null;
    RW._renderHealPreview();
    RW._relabel();
    RW.renderList(); RW.renderOverlay();
    if (RW._renderCommitPreview) RW._renderCommitPreview();
    RW._syncHealButtons();
    console.log('[RW] healed ' + erased + ' interior-noise wall px');
  };

  RW._syncHealButtons = function(){
    const b = document.getElementById('rw-heal-btn');
    if (b) b.style.background = RW._healPreviewOn ? 'rgba(255,140,0,0.35)' : '';
    const ab = document.getElementById('rw-heal-apply-btn');
    if (ab) ab.style.display = (RW._healPreviewOn && RW._healNoiseMask) ? '' : 'none';
  };

  // keep the preview in sync if the selection changes while it's on
  const origToggleGroup = RW.toggleGroup;
  RW.toggleGroup = function(gid){
    origToggleGroup.call(RW, gid);
    if (RW._healPreviewOn){
      RW._healNoiseMask = RW.selected.size ? RW._computeInteriorNoise(RW.selected) : null;
      RW._renderHealPreview();
      RW._syncHealButtons();
    }
  };

  /* ---------- panel controls ---------- */
  const bar = (document.getElementById('rw-pick') || {}).parentNode;
  if (bar && !document.getElementById('rw-heal-btn')){
    const b = document.createElement('button');
    b.id = 'rw-heal-btn';
    b.title = 'Preview interior noise (text/hatch/dimension marks) inside the SELECTED region(s) that\'s safe to erase without merging with any other region. Pick a region first. Detection only until you Apply Heal.';
    b.style.cssText = 'font-size:11px;padding:2px 6px;';
    b.innerText = 'Heal Interior?';
    b.onclick = () => RW.toggleHealPreview();
    bar.appendChild(b);

    const ab = document.createElement('button');
    ab.id = 'rw-heal-apply-btn';
    ab.title = 'Erase the highlighted interior noise from the selected region(s).';
    ab.style.cssText = 'font-size:11px;padding:2px 6px;display:none;background:rgba(255,140,0,0.25);';
    ab.innerText = 'Apply Heal';
    ab.onclick = () => RW.applyHeal();
    bar.appendChild(ab);

    const label = document.createElement('span');
    label.innerText = 'hole≤'; label.style.cssText = 'font-size:10px;opacity:0.7;margin-left:4px;';
    bar.appendChild(label);
    const holeInp = document.createElement('input');
    holeInp.type = 'number';
    holeInp.value = RW._healNoiseHoleMax != null ? RW._healNoiseHoleMax : Math.round(300*(RW.W/2592));
    holeInp.title = 'Max pixel size for a non-included area to still count as a negligible hole (safe to merge) rather than a real feature (protected). Separate from the area-floor input — that one is for candidate regions, this one is for "how big is too big to be noise."';
    holeInp.style.cssText = 'font-size:11px;padding:1px 4px;width:52px;text-align:right;';
    let holeDebounce = null;
    holeInp.oninput = function(){
      // live preview while typing/spinning, debounced — _computeInteriorNoise
      // is a real O(W×H)-ish recompute (measured 200ms-1.5s live), so firing
      // on every keystroke would make typing feel laggy rather than "live."
      clearTimeout(holeDebounce);
      const v = parseInt(holeInp.value, 10);
      if (isNaN(v)) return;
      holeDebounce = setTimeout(function(){
        RW._healNoiseHoleMax = Math.max(0, v);
        if (RW._healPreviewOn && RW.selected.size){
          RW._healNoiseMask = RW._computeInteriorNoise(RW.selected);
          RW._renderHealPreview();
          RW._syncHealButtons();
        }
      }, 250);
    };
    bar.appendChild(holeInp);
  }

  /* ---------- manual brush correction for the heal preview ---------- */
  // The topology-based detector will sometimes get it wrong in ways no
  // threshold can fix (e.g. an isolated solid symbol swept up as "noise"
  // because it never happens to border true exterior/a protected region
  // within reach — confirmed live). Rather than chase every such case
  // algorithmically, let the user paint directly onto RW._healNoiseMask
  // before Apply Heal — the same interaction as the existing Brush tool
  // (rw_brushpoly.js), just targeting the heal mask instead of RW.wall.
  // Requires a preview to already exist; arms it automatically (computing it
  // if needed) if a region is already selected.
  const ac = document.getElementById('annotation-canvas');
  RW.healBrushMode = false;
  RW.healBrushAction = 'add'; // 'add' — mark more as noise; 'remove' — protect/un-mark
  RW.healBrushR = Math.max(3, Math.round(6*(RW.W/2592)));
  let healBrushDown = false;

  RW._paintHealDisk = function(mx, my, r, val){
    if (!RW._healNoiseMask) return;
    const {W,H} = RW;
    const mask = RW._healNoiseMask;
    const x0=Math.max(0,Math.round(mx-r)), x1=Math.min(W-1,Math.round(mx+r));
    const y0=Math.max(0,Math.round(my-r)), y1=Math.min(H-1,Math.round(my+r));
    const r2=r*r;
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++){
      const dx=x-mx, dy=y-my;
      if (dx*dx+dy*dy<=r2) mask[y*W+x]=val;
    }
  };

  RW.setHealBrushMode = function(on){
    if (on){
      // cross-disarm the other mask tools, same pattern used throughout
      if (RW.maskMode){
        RW.maskMode=null; ac.style.cursor='';
        const rl=document.getElementById('rw-rectline'); if(rl) rl.remove();
        if (RW._syncRectBtn) RW._syncRectBtn();
      }
      if (RW.maskMode2) RW.setMaskMode2(null);
      if (RW.samBoxMode) RW.samBoxMode = false;
      if (!RW._healPreviewOn || !RW._healNoiseMask){
        if (!RW.selected.size){
          console.warn('[RW] Heal Brush: pick a region and preview Heal Interior first');
          return;
        }
        RW.toggleHealPreview();
        if (!RW._healNoiseMask) return;
      }
    }
    RW.healBrushMode = !!on;
    ac.style.cursor = RW.healBrushMode ? 'crosshair' : '';
    const btn = document.getElementById('rw-healbrush-btn');
    if (btn) btn.style.background = RW.healBrushMode ? 'rgba(255,140,0,0.4)' : '';
    if (!RW.healBrushMode){
      const cur = document.getElementById('rw-healbrush-cursor'); if (cur) cur.remove();
    }
  };

  RW._renderHealBrushCursor = function(cx, cy){
    const svg = RW._mkSvg('rw-healbrush-cursor', 73);
    const [nx,ny] = RW._toNorm(cx,cy);
    const [px,py] = RW._toPx(nx,ny);
    const pr = RW._toPx(RW.healBrushR/RW.W, 0)[0];
    const col = RW.healBrushAction==='add' ? '#ff8c00' : '#0af';
    svg.innerHTML = '<circle cx="'+px+'" cy="'+py+'" r="'+pr+'" fill="none" stroke="'+col+'" stroke-width="1.4" stroke-dasharray="6"/>';
  };

  ac.addEventListener('mousedown', function(e){
    if (!RW.healBrushMode) return;
    e.stopPropagation(); e.preventDefault();
    healBrushDown = true;
    RW.healBrushAction = e.shiftKey ? 'remove' : 'add';
    const [nx,ny] = RW._toNorm(e.clientX, e.clientY);
    RW._paintHealDisk(nx*RW.W, ny*RW.H, RW.healBrushR, RW.healBrushAction==='add'?1:0);
    RW._renderHealPreview();
  }, true);

  ac.addEventListener('mousemove', function(e){
    if (!RW.healBrushMode) return;
    e.stopPropagation();
    if (healBrushDown){
      const [nx,ny] = RW._toNorm(e.clientX, e.clientY);
      RW._paintHealDisk(nx*RW.W, ny*RW.H, RW.healBrushR, RW.healBrushAction==='add'?1:0);
      RW._renderHealPreview();
    }
    RW._renderHealBrushCursor(e.clientX, e.clientY);
  }, true);

  ac.addEventListener('mouseup', function(e){
    if (!RW.healBrushMode) return;
    e.stopPropagation(); e.preventDefault();
    healBrushDown = false;
  }, true);

  ac.addEventListener('wheel', function(e){
    if (!RW.healBrushMode || !RW.__tabHeld) return;
    e.stopPropagation(); e.preventDefault();
    RW.healBrushR = Math.max(2, Math.min(60, RW.healBrushR + (e.deltaY<0?1:-1)));
    RW._renderHealBrushCursor(e.clientX, e.clientY);
  }, {capture:true, passive:false});

  // RW.__tabHeld is a shared flag, but rw_brushpoly.js's own Tab handler only
  // ever sets it when RW.maskMode2==='brush' (the *original* Brush tool's own
  // mode) — pressing Tab while THIS tool is armed instead never set it, so
  // the wheel handler above always bailed out immediately. Cross-disarm
  // already guarantees only one of these tools is active at a time, so
  // sharing the flag is safe: extend the same keydown/keyup pair to also
  // fire for RW.healBrushMode, rather than introducing a second flag.
  window.addEventListener('keydown', function(e){
    if (e.key==='Tab' && RW.healBrushMode){
      RW.__tabHeld = true;
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener('keyup', function(e){
    if (e.key==='Tab') RW.__tabHeld = false;
  }, true);

  window.addEventListener('keydown', function(e){
    const t = e.target;
    if (t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (e.key==='Escape' && RW.healBrushMode){
      e.preventDefault(); e.stopImmediatePropagation();
      RW.setHealBrushMode(false);
    }
  }, true);

  // Reactive cross-disarm: wrap the shared functions Rect/Poly2/Brush already
  // call right after arming themselves (from BOTH their keydown handler and
  // their panel button's onclick — one shared touchpoint covers both input
  // paths, rather than only catching the keyboard shortcut).
  if (RW._syncRectBtn){
    const origSyncRectBtn = RW._syncRectBtn;
    RW._syncRectBtn = function(){
      origSyncRectBtn.apply(RW, arguments);
      if (RW.maskMode==='rect' && RW.healBrushMode) RW.setHealBrushMode(false);
    };
  }
  if (RW.setMaskMode2){
    const origSetMaskMode2 = RW.setMaskMode2;
    RW.setMaskMode2 = function(mode){
      origSetMaskMode2.call(RW, mode);
      if (mode && RW.healBrushMode) RW.setHealBrushMode(false);
    };
  }
  // SAM Box (rw_sam.js, SAM build only) has no equivalent shared touchpoint —
  // fall back to catching its keyboard shortcut specifically.
  window.addEventListener('keydown', function(e){
    const t = e.target;
    if (t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (RW.healBrushMode && e.key==='S' && e.shiftKey) RW.setHealBrushMode(false);
  }, true);

  if (bar && !document.getElementById('rw-healbrush-btn')){
    const hb = document.createElement('button');
    hb.id = 'rw-healbrush-btn';
    hb.title = 'Manually correct the Heal preview: drag to mark more area as noise (safe to erase), Shift+drag to protect/un-mark an area (e.g. a real symbol the detector got wrong). Tab+scroll resizes the brush.';
    hb.style.cssText = 'font-size:11px;padding:2px 6px;';
    hb.innerText = 'Edit Heal (Brush)';
    hb.onclick = () => RW.setHealBrushMode(!RW.healBrushMode);
    bar.appendChild(hb);
  }

  return 'v3 up: Heal Interior? preview + Apply Heal + Edit Heal (Brush) manual correction';
})()
