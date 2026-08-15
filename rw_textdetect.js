// RW v2.9 — text/dimension density overlay (DETECTION ONLY — no mask edits).
// Load AFTER rw_snap.js (needs v27, reuses its skeleton-candidate data).
// Flags areas where skeleton endpoint/junction candidates cluster densely.
// Never touches RW.wall/RW.labels/RW.regions — visualization only.
(function(){
  const RW = window.__RW;
  if (!RW || !RW.v27) return 'need v2.7 (rw_snap.js) first';
  if (RW.v29) return 'v2.9 already installed';
  RW.v29 = true;

  RW._textCellPx = Math.max(6, Math.round(16 * (RW.W/2592)));
  RW._textMinPerCell = 4;
  RW._textDirty = true;
  RW._textCandidates = [];

  // Builds a mask of annotation interiors, used to exclude those pixels from the scan.
  RW._buildAnnotationMask = function(){
    const {W,H} = RW;
    const cv = document.createElement('canvas'); cv.width=W; cv.height=H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    for (const a of (typeof annotationState!=='undefined' ? annotationState.annotations : [])){
      if (a._hidden || a.is_void) continue;
      // Skip bbox-type annotations (no point array).
      const pts = a.coordinates; if (!Array.isArray(pts) || pts.length<3) continue;
      ctx.beginPath();
      pts.forEach((p,i)=>{ const X=p.x*W, Y=p.y*H; i?ctx.lineTo(X,Y):ctx.moveTo(X,Y); });
      ctx.closePath(); ctx.fill();
    }
    const data = ctx.getImageData(0,0,W,H).data;
    const mask = new Uint8Array(W*H);
    for (let i=0;i<W*H;i++) if (data[i*4+3]>127) mask[i]=1;
    return mask;
  };

  /* ---------- grid-bucket candidate density, then connect hot cells ---------- */
  RW._buildTextCandidates = function(){
    if (RW._snapDirty) RW._buildSnapPoints(); // refreshes RW._skeletonCandidates
    const annMask = RW._buildAnnotationMask();
    const pts = (RW._skeletonCandidates || []).filter(p => !annMask[p.y*RW.W + p.x]);
    const cell = RW._textCellPx;
    const minPerCell = RW._textMinPerCell;
    if (!pts.length){ RW._textCandidates = []; RW._textDirty = false; return; }

    const counts = new Map();       // 'cx_cy' -> count
    const cellPts = new Map();      // 'cx_cy' -> [{x,y},...]
    for (const p of pts){
      const cx=(p.x/cell)|0, cy=(p.y/cell)|0;
      const k = cx+'_'+cy;
      counts.set(k, (counts.get(k)||0)+1);
      if (!cellPts.has(k)) cellPts.set(k, []);
      cellPts.get(k).push(p);
    }

    const hot = new Set();
    for (const [k,c] of counts) if (c >= minPerCell) hot.add(k);

    // connect adjacent hot cells (4-connected)
    const visited = new Set();
    const candidates = [];
    for (const k of hot){
      if (visited.has(k)) continue;
      const stack = [k];
      visited.add(k);
      const group = [];
      while (stack.length){
        const cur = stack.pop();
        group.push(cur);
        const [cx,cy] = cur.split('_').map(Number);
        for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
          const nk = (cx+dx)+'_'+(cy+dy);
          if (hot.has(nk) && !visited.has(nk)){ visited.add(nk); stack.push(nk); }
        }
      }
      let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity,total=0;
      for (const k2 of group){
        for (const p of cellPts.get(k2)){
          if (p.x<x0) x0=p.x; if (p.x>x1) x1=p.x;
          if (p.y<y0) y0=p.y; if (p.y>y1) y1=p.y;
          total++;
        }
      }
      candidates.push({x0,y0,x1,y1,count:total,cells:group.length});
    }
    RW._textCandidates = candidates;
    RW._textDirty = false;
  };

  /* ---------- overlay rendering (visualization only) ---------- */
  RW.textOverlayOn = false;
  RW.toggleTextOverlay = function(){
    RW.textOverlayOn = !RW.textOverlayOn;
    RW._renderTextOverlay();
    const btn = document.getElementById('rw-textdetect');
    if (btn) btn.style.background = RW.textOverlayOn ? 'rgba(200,80,220,0.35)' : '';
  };
  RW._renderTextOverlay = function(){
    const old = document.getElementById('rw-text-overlay'); if (old) old.remove();
    if (!RW.textOverlayOn) return;
    if (RW._textDirty) RW._buildTextCandidates();
    const svg = RW._mkSvg('rw-text-overlay', 46);
    let inner = '';
    for (const c of RW._textCandidates){
      const [ax,ay] = RW._toPx(c.x0/RW.W, c.y0/RW.H);
      const [bx,by] = RW._toPx((c.x1+1)/RW.W, (c.y1+1)/RW.H);
      inner += '<rect x="'+ax+'" y="'+ay+'" width="'+(bx-ax)+'" height="'+(by-ay)
        +'" fill="rgba(200,80,220,0.22)" stroke="#c850dc" stroke-width="1.5"/>';
    }
    svg.innerHTML = inner;
    const status = document.getElementById('rw-textdetect-count');
    if (status) status.innerText = RW._textCandidates.length + ' candidates';
  };

  // piggyback on RW._snapDirty (already wired to RW._relabel/RW.extract)
  // instead of adding a second wrapper layer.
  RW._textDirty = true;
  const origBuildSnapPoints = RW._buildSnapPoints;
  RW._buildSnapPoints = function(){ origBuildSnapPoints.apply(RW, arguments); RW._textDirty = true; };

  /* ---------- panel controls ---------- */
  const bar = (document.getElementById('rw-pick') || {}).parentNode;
  if (bar && !document.getElementById('rw-textdetect')){
    // wrapper lets the whole cluster be hidden as one unit (see below).
    const group = document.createElement('span');
    group.id = 'rw-textdetect-group';

    const b = document.createElement('button');
    b.id = 'rw-textdetect';
    b.title = 'Prototype: highlight areas where skeleton points cluster densely (likely text/dimensions). Detection only — nothing is edited.';
    b.style.cssText = 'font-size:11px;padding:2px 6px;';
    b.innerText = 'Text? (density)';
    b.onclick = () => RW.toggleTextOverlay();
    group.appendChild(b);

    const label1 = document.createElement('span');
    label1.innerText = 'cell'; label1.style.cssText = 'font-size:10px;opacity:0.7;margin-left:4px;';
    group.appendChild(label1);
    const cellInp = document.createElement('input');
    cellInp.type = 'number'; cellInp.value = RW._textCellPx;
    cellInp.title = 'Density grid cell size (mask px). Roughly a character height.';
    cellInp.style.cssText = 'font-size:11px;padding:1px 4px;width:44px;text-align:right;';
    cellInp.onchange = function(){
      const v = parseInt(this.value, 10);
      RW._textCellPx = isNaN(v) ? RW._textCellPx : Math.max(2, v);
      RW._textDirty = true;
      RW._renderTextOverlay();
    };
    group.appendChild(cellInp);

    const label2 = document.createElement('span');
    label2.innerText = 'min'; label2.style.cssText = 'font-size:10px;opacity:0.7;margin-left:4px;';
    group.appendChild(label2);
    const minInp = document.createElement('input');
    minInp.type = 'number'; minInp.value = RW._textMinPerCell;
    minInp.title = 'Minimum candidate points per cell to flag as text-like.';
    minInp.style.cssText = 'font-size:11px;padding:1px 4px;width:36px;text-align:right;';
    minInp.onchange = function(){
      const v = parseInt(this.value, 10);
      RW._textMinPerCell = isNaN(v) ? RW._textMinPerCell : Math.max(1, v);
      RW._textDirty = true;
      RW._renderTextOverlay();
    };
    group.appendChild(minInp);

    const status = document.createElement('span');
    status.id = 'rw-textdetect-count';
    status.style.cssText = 'font-size:10px;opacity:0.7;margin-left:4px;';
    group.appendChild(status);

    bar.appendChild(group);
  }

  /* ---------- hide clutter (per user request): hide, don't remove — same
     convention as rw_brushpoly.js's legacy 'poly' button. Done here since
     Relabel/Add live in earlier-loaded files. ---------- */
  ['rw-relabel-btn', 'rw-addmode', 'rw-textdetect-group'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  return 'v2.9 up: text-density overlay (detection only, no edits) — "Text? (density)" panel button';
})()
