// RW v2.1-revised — unified Rect tool (supplants separate Block/Open).
// Extends live __RW v2. Paints into RW.wall, re-labels preserving groups.
// Now uses normalized coordinates for pan-stable previews and a single mode
// 'rect' with RW.maskAction ('block'|'open') toggled via Shift or the button.
// Depends on _toNorm/_toPx from v2.2 (rw_stable.js must be loaded first).
(function(){
  const RW = window.__RW;
  if (!RW || RW.v !== 2) return 'need RW v2 first';
  if (RW.v21r) return 'v2.1r already installed';
  RW.v21r = true;

  /* ---------- rect tool: unified block/open via maskAction ---------- */
  // NOTE: RW.maskAction is 'block' or 'open' (shared with v2.6). Default block.
  if (!('maskAction' in RW)) RW.maskAction = 'block';

  // coordinate helpers (mirror v2.2 — available before rw_stable loads)
  if (!RW._toNorm) RW._toNorm = function(cx,cy){
    const cr = document.getElementById('pdf-container').getBoundingClientRect();
    return [(cx-cr.x)/cr.width, (cy-cr.y)/cr.height];
  };
  if (!RW._toPx) RW._toPx = function(nx,ny){
    const cr = document.getElementById('pdf-container').getBoundingClientRect();
    return [nx*cr.width, ny*cr.height];
  };
  if (!RW._mkSvg) RW._mkSvg = function(id, z){
    const old=document.getElementById(id); if(old) old.remove();
    const container=document.getElementById('pdf-container');
    const cr=container.getBoundingClientRect();
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.id=id;
    svg.setAttribute('viewBox','0 0 '+cr.width+' '+cr.height);
    svg.setAttribute('preserveAspectRatio','none');
    svg.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:'+z+';';
    container.appendChild(svg);
    return svg;
  };
  if (!RW._strokeK) RW._strokeK = function(){
    const pc=document.getElementById('pdf-container');
    const sc=document.getElementById('canvas-scroll-container');
    return pc.getBoundingClientRect().width/sc.getBoundingClientRect().width;
  };

  RW._paintRect = function(x0,y0,x1,y1,val){
    const {W,H,wall} = RW;
    const xa=Math.max(0,Math.min(x0,x1)|0), xb=Math.min(W-1,Math.max(x0,x1)|0);
    const ya=Math.max(0,Math.min(y0,y1)|0), yb=Math.min(H-1,Math.max(y0,y1)|0);
    for (let y=ya;y<=yb;y++) for (let x=xa;x<=xb;x++) wall[y*W+x]=val;
  };
  RW._paintPoly = function(pts,val){
    const {W,H,wall} = RW;
    let minY=H,maxY=0;
    for (const [x,y] of pts){ if(y<minY)minY=y; if(y>maxY)maxY=y; }
    minY=Math.max(0,minY|0); maxY=Math.min(H-1,Math.ceil(maxY));
    for (let y=minY;y<=maxY;y++){
      const xs=[];
      for (let i=0,j=pts.length-1;i<pts.length;j=i++){
        const [xi,yi]=pts[i], [xj,yj]=pts[j];
        if ((yi>y)!==(yj>y)) xs.push(xi+(y-yi)/(yj-yi)*(xj-xi));
      }
      xs.sort((a,b)=>a-b);
      for (let k=0;k+1<xs.length;k+=2){
        const xa=Math.max(0,Math.round(xs[k])), xb=Math.min(W-1,Math.round(xs[k+1]));
        for (let x=xa;x<=xb;x++) wall[y*W+x]=val;
      }
    }
  };

  // Bresenham polyline — paints wall=1 only where pixels are currently wall=0
  // (seals gaps in existing linework without cutting through mask regions)
  RW._paintPolylineGap = function(pts){
    const {W,H,wall} = RW;
    function line(x0,y0,x1,y1){
      const dx=Math.abs(x1-x0), sx=x0<x1?1:-1;
      const dy=-Math.abs(y1-y0), sy=y0<y1?1:-1;
      let err=dx+dy;
      while(true){
        if (x0>=0&&x0<W&&y0>=0&&y0<H && wall[y0*W+x0]===0) wall[y0*W+x0]=1;
        if (x0===x1&&y0===y1) break;
        const e2=2*err;
        if (e2>=dy){ err+=dy; x0+=sx; }
        if (e2<=dx){ err+=dx; y0+=sy; }
      }
    }
    for (let i=0;i<pts.length;i++){
      const [x0,y0]=pts[i], [x1,y1]=pts[(i+1)%pts.length];
      line(Math.round(x0),Math.round(y0),Math.round(x1),Math.round(y1));
    }
  };

  /* ---------- relabel preserving groups by centroid ---------- */
  RW._relabel = function(){
    if (!RW.labels) RW.extract(); // auto-bootstrap if no mask exists yet
    const {W,H,wall} = RW;
    // snapshot old regions BEFORE flood — used to protect existing mask from border absorption
    const oldRegions = RW.regions;
    const oldLabels = RW.labels;
    const oldCent = {};
    for (let i=0;i<W*H;i++){
      const l=oldLabels[i]; if (l<0) continue;
      const g=oldRegions[l].group;
      const c=oldCent[g]=oldCent[g]||{sx:0,sy:0,n:0};
      c.sx+=i%W; c.sy+=(i/W)|0; c.n++;
    }
    for (const g in oldCent){ const c=oldCent[g]; c.x=c.sx/c.n; c.y=c.sy/c.n; }
    const seen=new Uint8Array(W*H); const q=[];
    for (let x=0;x<W;x++){ q.push(x,(H-1)*W+x); }
    for (let y=0;y<H;y++){ q.push(y*W,y*W+W-1); }
    while(q.length){
      const i=q.pop();
      if (seen[i]||wall[i]) continue;
      // protect pixels that were previously part of included mask regions
      const ol=oldLabels[i];
      if (ol>=0 && oldRegions[ol] && oldRegions[ol].included) continue;
      seen[i]=1; const x=i%W,y=(i/W)|0;
      if(x>0)q.push(i-1); if(x<W-1)q.push(i+1);
      if(y>0)q.push(i-W); if(y<H-1)q.push(i+W);
    }
    const labels = new Int32Array(W*H).fill(-1);
    let nComp=0; const sizes=[];
    for (let s=0;s<W*H;s++){
      if (seen[s]||wall[s]||labels[s]>=0) continue;
      const stack=[s]; labels[s]=nComp; let size=0,sx=0,sy=0;
      while(stack.length){
        const i=stack.pop(); size++;
        const x=i%W,y=(i/W)|0; sx+=x;sy+=y;
        if(x>0&&!seen[i-1]&&!wall[i-1]&&labels[i-1]<0){labels[i-1]=nComp;stack.push(i-1);}
        if(x<W-1&&!seen[i+1]&&!wall[i+1]&&labels[i+1]<0){labels[i+1]=nComp;stack.push(i+1);}
        if(y>0&&!seen[i-W]&&!wall[i-W]&&labels[i-W]<0){labels[i-W]=nComp;stack.push(i-W);}
        if(y<H-1&&!seen[i+W]&&!wall[i+W]&&labels[i+W]<0){labels[i+W]=nComp;stack.push(i+W);}
      }
      sizes.push({size, cx:sx/size, cy:sy/size}); nComp++;
    }
    const newGroupFor=new Array(nComp).fill(-1);
    for (let id=0;id<nComp;id++){
      const {cx,cy}=sizes[id]; let best=-1,bestD=40*40;
      for (const g in oldCent){ const c=oldCent[g]; const d=(c.x-cx)*(c.x-cx)+(c.y-cy)*(c.y-cy); if (d<bestD){bestD=d;best=+g;} }
      newGroupFor[id]=best;
    }
    RW.labels=labels; RW.nComp=nComp;
    const areaFloor = RW._areaFloor || 2500;
    RW.regions = sizes.map((s,id)=>{ const g=newGroupFor[id]>=0?newGroupFor[id]:id; return {id,size:s.size,included:s.size>=areaFloor,group:g,color:'hsl('+((g*67)%360)+',70%,55%)'}; });
  };

  /* ---------- rect tool: unified block/open via RW.maskAction ---------- */
  const ac = document.getElementById('annotation-canvas');

  // n.b.: v2.6's previewV=5 handles poly2/brush; this module only handles
  // maskMode==='rect'.  v2.6 keys (N/J) check maskMode2 to avoid conflict.
  // legacy keys B/O are removed here; unified rect uses B-only gated on
  // maskMode2 being null (so B does nothing while poly2/brush are armed).

  ac.addEventListener('mousedown', function(e){
    if (RW.maskMode!=='rect') return;
    e.stopPropagation(); e.preventDefault();
    RW.__rectStartN = RW._toNorm(e.clientX, e.clientY);
    RW.__rectCurN = RW.__rectStartN.slice();
  }, true);

  ac.addEventListener('mousemove', function(e){
    if (RW.maskMode!=='rect' || !RW.__rectStartN) return;
    e.stopPropagation();
    RW.__rectCurN = RW._toNorm(e.clientX, e.clientY);
    // render via the shared preview path from v2.2
    RW._renderPreview2({x:e.clientX,y:e.clientY});
  }, true);

  ac.addEventListener('mouseup', function(e){
    if (RW.maskMode!=='rect' || !RW.__rectStartN) return;
    e.stopPropagation(); e.preventDefault();
    const s=RW.__rectStartN; RW.__rectStartN=null; RW.__rectCurN=null;
    const rl=document.getElementById('rw-rectline'); if(rl) rl.remove();
    const en=RW._toNorm(e.clientX,e.clientY);
    const val = RW.maskAction==='block' ? 1 : 0;
    if (RW.maskAction==='open'){
      // open mode: only convert wall pixels to non-wall inside the rect.
      // never create new wall barriers (no perimeter seal — that cuts through mask)
      const rx0=s[0]*RW.W, ry0=s[1]*RW.H, rx1=en[0]*RW.W, ry1=en[1]*RW.H;
      const xa=Math.max(0,Math.min(rx0,rx1)|0), xb=Math.min(RW.W-1,Math.max(rx0,rx1)|0);
      const ya=Math.max(0,Math.min(ry0,ry1)|0), yb=Math.min(RW.H-1,Math.max(ry0,ry1)|0);
      for (let y=ya;y<=yb;y++) for (let x=xa;x<=xb;x++) {
        if (RW.wall[y*RW.W+x]===1) RW.wall[y*RW.W+x]=0;
      }
    } else {
      RW._paintRect(s[0]*RW.W, s[1]*RW.H, en[0]*RW.W, en[1]*RW.H, val);
    }
    RW._relabel(); RW.renderList(); RW.renderOverlay();
    RW._renderCommitPreview();
  }, true);

  ac.addEventListener('click', function(e){
    if (RW.maskMode==='rect'){ e.stopPropagation(); e.preventDefault(); }
  }, true);

  /* ---------- rect preview render (plugged into v2.2 renderer) ---------- */
  // v2.2 _renderPreview only checks maskMode==='poly' — we extend it here
  // by wrapping into a _renderPreview2 that the v2.2 mousemove calls instead.
  RW._renderPreview2 = function(cursorClient){
    // delegate to v2.2 renderer for poly/brush first
    RW._renderPreview(cursorClient);
    if (RW.maskMode!=='rect' || !RW.__rectStartN) return;
    const sw = 1.5;  // constant screen px — zoom-invariant
    const svg = RW._mkSvg ? RW._mkSvg('rw-rectline', 71) : null;
    if (!svg) return;
    let x0=RW.__rectStartN[0], y0=RW.__rectStartN[1];
    let x1=RW.__rectCurN ? RW.__rectCurN[0] : x0, y1=RW.__rectCurN ? RW.__rectCurN[1] : y0;
    const [ax,ay]=RW._toPx(Math.min(x0,x1),Math.min(y0,y1));
    const [bx,by]=RW._toPx(Math.max(x0,x1),Math.max(y0,y1));
    const col = RW.maskAction==='block' ? 'orange' : 'deepskyblue';
    svg.innerHTML='<rect x="'+ax+'" y="'+ay+'" width="'+(bx-ax)+'" height="'+(by-ay)+'" fill="rgba(255,160,60,0.10)" stroke="'+col+'" stroke-width="'+sw+'"/>';
  };

  /* ---------- keys: B = rect (Shift-B toggles action) ---------- */
  window.addEventListener('keydown', function(e){
    const t=e.target;
    if (t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (e.ctrlKey||e.metaKey||e.altKey) return;
    // never handle when v2.6 tools are armed — BUT disarm them first so the
    // user can switch directly between rect and poly2/brush in one keystroke
    if (e.key==='b'||e.key==='B'){
      if (RW.maskMode2){ RW.setMaskMode2(null); }
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.shiftKey){ RW.maskAction = RW.maskAction==='block' ? 'open' : 'block'; RW._syncRectBtn(); return; }
      RW.maskMode = RW.maskMode==='rect' ? null : 'rect';
      RW._syncRectBtn();
      const ac=document.getElementById('annotation-canvas');
      ac.style.cursor = RW.maskMode==='rect' ? 'crosshair' : '';
      if (RW.maskMode!=='rect'){ RW.__rectStartN=null; RW.__rectCurN=null; const rl=document.getElementById('rw-rectline'); if(rl) rl.remove(); }
    }
    if (e.key==='Escape' && RW.maskMode==='rect'){
      e.preventDefault(); e.stopImmediatePropagation();
      RW.maskMode=null; RW.__rectStartN=null; RW.__rectCurN=null;
      document.getElementById('annotation-canvas').style.cursor='';
      const rl=document.getElementById('rw-rectline'); if(rl) rl.remove();
      RW._syncRectBtn();
    }
  }, true);

  /* ---------- panel button ---------- */
  RW._syncRectBtn = function(){
    const b = document.getElementById('rw-rect');
    if (!b) return;
    const sym = RW.maskAction==='block' ? '-' : '+';
    b.innerText = 'Rect '+sym+' (B)';
    b.style.background = RW.maskMode==='rect' ? 'rgba(255,160,60,0.4)' : '';
  };
  const bar = (document.getElementById('rw-pick') || {}).parentNode;
  if (bar && !document.getElementById('rw-rect')){
    const b=document.createElement('button');
    b.id='rw-rect'; b.title='Unified rect mask. Shift+B toggles block/open.';
    b.style.cssText='font-size:11px;padding:2px 6px;';
    b.onclick=()=>{
      // cross-disarm: if any v2.6 tool is armed, kill it first
      if (RW.maskMode2) RW.setMaskMode2(null);
      if (RW.maskMode!=='rect'){ RW.maskMode='rect'; RW.__rectStartN=null; RW.__rectCurN=null; }
      else { RW.maskMode=null; }
      document.getElementById('annotation-canvas').style.cursor = RW.maskMode==='rect' ? 'crosshair' : '';
      RW._syncRectBtn();
    };
    bar.appendChild(b);
  }
  RW._syncRectBtn();

  return 'v2.1r unified rect up: B=rect (Shift+B toggles block/open), pan-stable';
})()