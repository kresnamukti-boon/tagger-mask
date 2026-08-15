// RW v3 — interior noise healing.
//
// Detects wall pixels inside a selected region's group that are interior
// noise (text/hatch/dimension/leader marks) rather than the region's
// perimeter, and can erase them.
//
// Detection steps:
//   1. Per-pixel safety test (not a whole-component veto).
//   2. Bounded by reachability flood, not a fixed pad.
//   3. Hole-size threshold (RW._healNoiseHoleMax): a neighboring open area
//      larger than this counts as protected even if not `included`.
//   4. Door-opening gaps that merge a floor plan into the same open region
//      as the noise are not distinguished from noise.
//   5. Existing annotations' wall-knockout mask is rebuilt and excluded from
//      both the flood and the result.
//   6. Unsafe shell widened via a bounded BFS (RW._healBarrierMargin).
//
// RW._healBarrierMargin expands only inward from a region's own outer wall
// face, not both sides. Set barrier≥ to the line's full visible thickness,
// not half.
(function(){
  const RW = window.__RW;
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
  //       exterior or a different included region (per-pixel test).
  RW._computeInteriorNoise = function(gids){
    const {W,H,labels,regions,wall} = RW;
    const memberIds = new Set(regions.filter(r=>gids.has(r.group)).map(r=>r.id));
    if (!memberIds.size) return null;

    const isSameRegion = i => { const l=labels[i]; return l>=0 && memberIds.has(l); };

    // Protected: included, or bigger than RW._healNoiseHoleMax.
    const holeMax = RW._healNoiseHoleMax != null ? RW._healNoiseHoleMax : Math.round(300*(RW.W/2592));
    const isProtectedRegion = i => {
      const l = labels[i];
      if (l<0 || memberIds.has(l)) return false;
      const r = regions[l];
      return !!r && (r.included || r.size > holeMax);
    };

    // Rebuild existing annotations' wall-knockout mask; excluded from both the flood and the result.
    const annotationMask = new Uint8Array(W*H);
    if (typeof annotationState !== 'undefined'){
      const cv = document.createElement('canvas'); cv.width=W; cv.height=H;
      const actx = cv.getContext('2d');
      actx.fillStyle = '#000';
      for (const a of annotationState.annotations){
        if (a._hidden || a.is_void) continue;
        const pts = a.coordinates; if (!Array.isArray(pts) || pts.length<3) continue;
        actx.beginPath();
        pts.forEach((p,idx)=>{ const X=p.x*W, Y=p.y*H; idx?actx.lineTo(X,Y):actx.moveTo(X,Y); });
        actx.closePath(); actx.fill();
      }
      const adata = actx.getImageData(0,0,W,H).data;
      for (let i=0;i<W*H;i++) if (adata[i*4+3]>127) annotationMask[i]=1;
    }

    // True-unenclosed-exterior mask: reachable from the sheet border without crossing a wall or protected region.
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

    // Reachability flood from the region's own open pixels, stepping only into wall/same-region pixels.
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
        if (annotationMask[n]) continue;
        if (wall[n]===1){ seenReach[n]=1; reachableWall[n]=1; q2.push(n); }
        else if (isSameRegion(n)){ seenReach[n]=1; q2.push(n); }
      }
    }

    // Unsafe shell: reachable wall pixels whose immediate neighbor is exterior/protected/annotation.
    const unsafeShell = new Uint8Array(W*H);
    for (let i=0;i<W*H;i++){
      if (!reachableWall[i] || annotationMask[i]) continue;
      const x=i%W, y=(i/W)|0;
      let unsafe = false;
      if (x>0 && (exterior[i-1] || isProtectedRegion(i-1) || annotationMask[i-1])) unsafe=true;
      if (!unsafe && x<W-1 && (exterior[i+1] || isProtectedRegion(i+1) || annotationMask[i+1])) unsafe=true;
      if (!unsafe && y>0 && (exterior[i-W] || isProtectedRegion(i-W) || annotationMask[i-W])) unsafe=true;
      if (!unsafe && y<H-1 && (exterior[i+W] || isProtectedRegion(i+W) || annotationMask[i+W])) unsafe=true;
      if (unsafe) unsafeShell[i]=1;
    }

    // Widen the unsafe shell by RW._healBarrierMargin via bounded BFS through reachable wall.
    const margin = RW._healBarrierMargin != null ? RW._healBarrierMargin : Math.max(4, Math.round(12*(RW.W/2592)));
    const protectedExpanded = new Uint8Array(W*H);
    {
      let frontier = [];
      for (let i=0;i<W*H;i++) if (unsafeShell[i]){ protectedExpanded[i]=1; frontier.push(i); }
      for (let step=0; step<margin && frontier.length; step++){
        const next = [];
        for (const i of frontier){
          const x=i%W, y=(i/W)|0;
          const neigh = [];
          if (x>0) neigh.push(i-1);
          if (x<W-1) neigh.push(i+1);
          if (y>0) neigh.push(i-W);
          if (y<H-1) neigh.push(i+W);
          for (const n of neigh){
            if (protectedExpanded[n] || !reachableWall[n]) continue;
            protectedExpanded[n]=1;
            next.push(n);
          }
        }
        frontier = next;
      }
    }

    const noise = new Uint8Array(W*H);
    for (let i=0;i<W*H;i++){
      if (reachableWall[i] && !annotationMask[i] && !protectedExpanded[i]) noise[i]=1;
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
    const group = document.createElement('span');
    group.id = 'rw-heal-group';
    group.style.cssText = 'display:inline-flex;gap:4px;align-items:center;';

    const b = document.createElement('button');
    b.id = 'rw-heal-btn';
    b.title = 'Preview interior noise (text/hatch/dimension marks) inside the SELECTED region(s) that\'s safe to erase without merging with any other region. Pick a region first. Detection only until you Apply Heal.';
    b.style.cssText = 'font-size:11px;padding:2px 6px;';
    b.innerText = 'Heal Interior?';
    b.onclick = () => RW.toggleHealPreview();
    group.appendChild(b);

    const ab = document.createElement('button');
    ab.id = 'rw-heal-apply-btn';
    ab.title = 'Erase the highlighted interior noise from the selected region(s).';
    ab.style.cssText = 'font-size:11px;padding:2px 6px;display:none;background:rgba(255,140,0,0.25);';
    ab.innerText = 'Apply Heal';
    ab.onclick = () => RW.applyHeal();
    group.appendChild(ab);

    const label = document.createElement('span');
    label.innerText = 'hole≤'; label.style.cssText = 'font-size:10px;opacity:0.7;margin-left:4px;';
    group.appendChild(label);
    const holeInp = document.createElement('input');
    holeInp.id = 'rw-heal-hole';
    holeInp.type = 'number';
    holeInp.value = RW._healNoiseHoleMax != null ? RW._healNoiseHoleMax : Math.round(300*(RW.W/2592));
    holeInp.title = 'Max pixel size for a non-included area to still count as a negligible hole (safe to merge) rather than a real feature (protected). Separate from the area-floor input — that one is for candidate regions, this one is for "how big is too big to be noise."';
    holeInp.style.cssText = 'font-size:11px;padding:1px 4px;width:52px;text-align:right;';
    let holeDebounce = null;
    holeInp.oninput = function(){
      // debounced — _computeInteriorNoise is O(W×H)-ish (200ms-1.5s live),
      // so firing on every keystroke would feel laggy rather than "live."
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
    group.appendChild(holeInp);

    const label3 = document.createElement('span');
    label3.innerText = 'barrier≥'; label3.style.cssText = 'font-size:10px;opacity:0.7;margin-left:4px;';
    group.appendChild(label3);
    const marginInp = document.createElement('input');
    marginInp.id = 'rw-heal-margin';
    marginInp.type = 'number';
    marginInp.value = RW._healBarrierMargin != null ? RW._healBarrierMargin : Math.max(4, Math.round(12*(RW.W/2592)));
    marginInp.title = 'Protection margin (mask px) around any real barrier — raise this if a thick boundary line is getting partially eaten through its middle. Set this to roughly the FULL pixel thickness of the line you see (not half) — protection only expands inward from the line\'s outer face, not from both sides at once.';
    marginInp.style.cssText = 'font-size:11px;padding:1px 4px;width:44px;text-align:right;';
    let marginDebounce = null;
    marginInp.oninput = function(){
      clearTimeout(marginDebounce);
      const v = parseInt(marginInp.value, 10);
      if (isNaN(v)) return;
      marginDebounce = setTimeout(function(){
        RW._healBarrierMargin = Math.max(0, v);
        if (RW._healPreviewOn && RW.selected.size){
          RW._healNoiseMask = RW._computeInteriorNoise(RW.selected);
          RW._renderHealPreview();
          RW._syncHealButtons();
        }
      }, 250);
    };
    group.appendChild(marginInp);

    bar.appendChild(group);
  }

  /* ---------- manual brush correction for the heal preview ---------- */
  // The topology-based detector can still be wrong in cases no threshold
  // fixes (e.g. an isolated solid symbol that never borders exterior/a
  // protected region within reach — confirmed live). Let the user paint
  // directly onto RW._healNoiseMask before Apply Heal, same interaction as
  // the Brush tool (rw_brushpoly.js). Requires a preview to already exist;
  // arms it automatically if a region is already selected.
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
      if (RW.maskMode){
        RW.maskMode=null; ac.style.cursor='';
        const rl=document.getElementById('rw-rectline'); if(rl) rl.remove();
        if (RW._syncRectBtn) RW._syncRectBtn();
      }
      if (RW.maskMode2) RW.setMaskMode2(null);
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
