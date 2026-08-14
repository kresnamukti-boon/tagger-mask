// RW v2.6 — Poly (dual-action) + Brush mask tools.
// Load AFTER rw_undo.js (needs v2.3). Adds:
//   N  — Poly2 tool: freeform vertices, dbl-click closes. Shift+N toggles block/open.
//   J  — Brush tool: freehand stroke, Tab+scroll sizes radius. Shift+J toggles block/open.
//   A  — Cycle maskAction: block → open → add (creates new regions from drawn shapes).
(function(){
  const RW = window.__RW;
  if (!RW || !RW.v23) return 'need v2.3 first';
  if (RW.v26) return 'v2.6 already installed';
  if (window.__RWv26listeners) return 'v2.6 listeners already attached';
  window.__RWv26listeners = true;
  RW.v26 = true;
  RW._previewV = 5;

  const ac = document.getElementById('annotation-canvas');

  RW.maskAction = 'block';
  RW.brushR = 6;

  RW.setMaskMode2 = function(mode){
    if (RW.maskMode==='rect'){ RW.maskMode=null; RW.__rectStartN=null; RW.__rectCurN=null;
      document.getElementById('annotation-canvas').style.cursor='';
      const rl=document.getElementById('rw-rectline'); if(rl) rl.remove();
      if (RW._syncRectBtn) RW._syncRectBtn(); }
    RW.maskMode2 = mode || null;
    RW._polyPtsN = [];
    ['rw-polyline','rw-rectline','rw-brushline'].forEach(id=>{
      const el=document.getElementById(id); if(el) el.remove();
    });
    ac.style.cursor = RW.maskMode2 ? 'crosshair' : '';
    RW._syncToolButtons();
  };

  RW._actionLabel = function(){ return RW.maskAction==='block'?'−':RW.maskAction==='open'?'+':'⊕'; };
  RW._actionColor = function(){ return RW.maskAction==='block'?'orange':RW.maskAction==='open'?'deepskyblue':'limegreen'; };
  RW._actionBg = function(){ return RW.maskAction==='block'?'rgba(255,160,60,0.18)':RW.maskAction==='open'?'rgba(60,180,255,0.18)':'rgba(50,205,50,0.18)'; };
  RW.setMaskAction = function(a){ RW.maskAction = a; RW._syncToolButtons(); RW._syncRectBtn && RW._syncRectBtn(); };

  RW._syncToolButtons = function(){
    const label = RW._actionLabel();
    const pb = document.getElementById('rw-poly2');
    if (pb) pb.innerText = 'Poly2 ' + label + ' (N)';
    if (pb) pb.style.background = RW.maskMode2==='poly2' ? 'rgba(255,160,60,0.4)' : '';
    const bb = document.getElementById('rw-brush');
    if (bb) bb.innerText = 'Brush ' + label + ' (J)';
    if (bb) bb.style.background = RW.maskMode2==='brush' ? 'rgba(255,160,60,0.4)' : '';
    const ab = document.getElementById('rw-addmode');
    if (ab){
      ab.innerText = 'Add ' + label + ' (A)';
      ab.style.background = RW.maskAction==='add' ? 'rgba(50,205,50,0.45)' : '';
    }
  };

  RW._paintDisk = function(mx, my, r, val){
    const {W,H,wall} = RW;
    const x0=Math.max(0,Math.round(mx-r)), x1=Math.min(W-1,Math.round(mx+r));
    const y0=Math.max(0,Math.round(my-r)), y1=Math.min(H-1,Math.round(my+r));
    const r2=r*r;
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++){
      const dx=x-mx, dy=y-my;
      if (dx*dx+dy*dy<=r2) wall[y*W+x]=val;
    }
  };

  ac.addEventListener('mousedown', function(e){
    if (!RW.maskMode2) return;
    e.stopPropagation(); e.preventDefault();
    let [nx,ny]=RW._toNorm(e.clientX,e.clientY);
    if (RW.maskMode2==='poly2'){
      if (RW._trySnap && !e.shiftKey){ const s=RW._trySnap(nx,ny); nx=s[0]; ny=s[1]; }
      RW._polyPtsN = RW._polyPtsN || [];
      RW._polyPtsN.push([nx,ny]);
      return;
    }
    if (RW.maskMode2==='brush'){
      RW._brushDown = true;
      RW._brushStroke = [[nx,ny]];
      RW._snapshot('brush');
      const val = RW.maskAction==='add' ? 0 : (RW.maskAction==='block' ? 1 : 0);
      RW._paintDisk(nx*RW.W, ny*RW.H, RW.brushR, val);
    }
  }, true);

  ac.addEventListener('mousemove', function(e){
    if (!RW.maskMode2) return;
    e.stopPropagation();
    const [nx,ny]=RW._toNorm(e.clientX,e.clientY);
    if (RW.maskMode2==='poly2'){
      RW._renderPreview({x:e.clientX,y:e.clientY});
      // Show polygon area (current vertices + cursor position)
      if (RW._polyPtsN && RW._polyPtsN.length >= 2){
        const pts = RW._polyPtsN.concat([[nx,ny]]);
        RW._showAreaHint(RW._polyArea(pts));
      }
      return;
    }
    if (RW.maskMode2==='brush'){
      if (RW._brushDown){
        RW._brushStroke.push([nx,ny]);
        const val = RW.maskAction==='add' ? 0 : (RW.maskAction==='block' ? 1 : 0);
        RW._paintDisk(nx*RW.W, ny*RW.H, RW.brushR, val);
      }
      RW._renderBrushCursor(e.clientX, e.clientY);
      // Show approximate brush area: stroke length × diameter
      if (RW._brushDown && RW._brushStroke && RW._brushStroke.length > 1){
        const strokes = RW._brushStroke.length;
        const px = Math.round(strokes * RW.brushR * 2 * RW.brushR * 2);
        RW._showAreaHint(px);
      }
    }
  }, true);

  ac.addEventListener('mouseup', function(e){
    if (!RW.maskMode2) return;
    e.stopPropagation(); e.preventDefault();
    if (RW.maskMode2==='poly2') return;
    if (RW.maskMode2==='brush' && RW._brushDown){
      RW._brushDown = false;
      RW._showAreaHint(null);
      if (RW.maskAction==='add'){
        const {W,H,labels,regions,wall} = RW;
        const r = RW.brushR;
        // Compute bbox of the brush stroke, build skip mask for existing regions
        let bx0=W, by0=H, bx1=0, by1=0;
        for (const [snx,sny] of RW._brushStroke){
          const mx=Math.round(snx*W), my=Math.round(sny*H);
          if (mx-(r+3)<bx0) bx0=mx-(r+3);
          if (my-(r+3)<by0) by0=my-(r+3);
          if (mx+(r+3)>bx1) bx1=mx+(r+3);
          if (my+(r+3)>by1) by1=my+(r+3);
        }
        bx0=Math.max(0,bx0); by0=Math.max(0,by0);
        bx1=Math.min(W-1,bx1); by1=Math.min(H-1,by1);
        const skip = new Uint8Array(W*H);
        for (let y=by0;y<=by1;y++) for (let x=bx0;x<=bx1;x++){
          const l=labels[y*W+x];
          if (l>=0 && regions[l] && regions[l].included) skip[y*W+x]=1;
        }
        // Create perimeter ring around the cleared stroke (skip existing regions)
        for (const [snx,sny] of RW._brushStroke){
          const mx=Math.round(snx*W), my=Math.round(sny*H);
          const r0=Math.max(0,mx-(r+2)), r1=Math.min(W-1,mx+(r+2));
          const c0=Math.max(0,my-(r+2)), c1=Math.min(H-1,my+(r+2));
          for (let y=c0;y<=c1;y++) for (let x=r0;x<=r1;x++){
            if (skip[y*W+x]) continue;
            if ((x-mx)*(x-mx)+(y-my)*(y-my)<=(r+2)*(r+2)) wall[y*W+x]=1;
          }
        }
        for (const [snx,sny] of RW._brushStroke){
          const mx=Math.round(snx*W), my=Math.round(sny*H);
          const r0=Math.max(0,mx-(r-1)), r1=Math.min(W-1,mx+(r-1));
          const c0=Math.max(0,my-(r-1)), c1=Math.min(H-1,my+(r-1));
          for (let y=c0;y<=c1;y++) for (let x=r0;x<=r1;x++){
            if (skip[y*W+x]) continue;
            if ((x-mx)*(x-mx)+(y-my)*(y-my)<=(r-1)*(r-1)) wall[y*W+x]=0;
          }
        }
      }
      RW._relabel();
      if (RW.maskAction==='add' && RW._brushStroke && RW._brushStroke.length){
        // Force-include the region at the center of the brush stroke
        const sn = RW._brushStroke[Math.floor(RW._brushStroke.length/2)];
        const cx = Math.round(sn[0]*RW.W), cy = Math.round(sn[1]*RW.H);
        if (cx>=0 && cx<RW.W && cy>=0 && cy<RW.H){
          const l = RW.labels[cy*RW.W + cx];
          if (l>=0 && RW.regions[l]) RW.regions[l].included = true;
        }
      }
      RW.renderList(); RW.renderOverlay();
      RW._renderCommitPreview();
    }
  }, true);

  ac.addEventListener('dblclick', function(e){
    if (RW.maskMode2!=='poly2') return;
    e.stopPropagation(); e.preventDefault();
      if (RW._polyPtsN && RW._polyPtsN.length>=3){
      const mpts = RW._polyPtsN.map(([nx,ny])=>[nx*RW.W, ny*RW.H]);
      if (RW.maskAction==='add'){
        const {W,H,labels,regions,wall} = RW;
        // Compute bbox of the polygon, build skip mask for existing regions
        let bx0=W, by0=H, bx1=0, by1=0;
        for (const [x,y] of mpts){
          if (Math.round(x)-3<bx0) bx0=Math.round(x)-3;
          if (Math.round(y)-3<by0) by0=Math.round(y)-3;
          if (Math.round(x)+3>bx1) bx1=Math.round(x)+3;
          if (Math.round(y)+3>by1) by1=Math.round(y)+3;
        }
        bx0=Math.max(0,bx0); by0=Math.max(0,by0);
        bx1=Math.min(W-1,bx1); by1=Math.min(H-1,by1);
        const skip = new Uint8Array(W*H);
        for (let y=by0;y<=by1;y++) for (let x=bx0;x<=bx1;x++){
          const l=labels[y*W+x];
          if (l>=0 && regions[l] && regions[l].included) skip[y*W+x]=1;
        }
        // Fill-then-hollow with skip: paint wall over whitespace, clear interior
        for (let y=by0;y<=by1;y++) for (let x=bx0;x<=bx1;x++) wall[y*W+x]=1;
        // Shrink polygon inward by 2 mask px and clear the interior
        const cx=mpts.reduce((s,[x])=>s+x,0)/mpts.length, cy=mpts.reduce((s,[,y])=>s+y,0)/mpts.length;
        const inner = mpts.map(([x,y])=>{
          const dx=x-cx, dy=y-cy, d=Math.hypot(dx,dy)||1;
          return [x-(dx/d)*2, y-(dy/d)*2];
        });
        // Clear interior of the inner polygon, then restore skip pixels
        RW._paintPoly(inner, 0);
        for (let y=by0;y<=by1;y++) for (let x=bx0;x<=bx1;x++)
          if (skip[y*W+x]) wall[y*W+x]=1;  // restore existing region pixels as wall
      } else if (RW.maskAction==='open'){
        // open mode: seal perimeter gaps, then convert interior walls to non-wall
        RW._paintPolylineGap(mpts);
        const W=RW.W, H=RW.H, wall=RW.wall;
        let minY=H,maxY=0;
        for (const [x,y] of mpts){ if(y<minY)minY=y; if(y>maxY)maxY=y; }
        minY=Math.max(0,minY|0); maxY=Math.min(H-1,Math.ceil(maxY));
        for (let y=minY;y<=maxY;y++){
          const xs=[];
          for (let i=0,j=mpts.length-1;i<mpts.length;j=i++){
            const [xi,yi]=mpts[i], [xj,yj]=mpts[j];
            if ((yi>y)!==(yj>y)) xs.push(xi+(y-yi)/(yj-yi)*(xj-xi));
          }
          xs.sort((a,b)=>a-b);
          for (let k=0;k+1<xs.length;k+=2){
            const xa=Math.max(0,Math.round(xs[k])), xb=Math.min(W-1,Math.round(xs[k+1]));
            for (let x=xa;x<=xb;x++) if (wall[y*W+x]===1) wall[y*W+x]=0;
          }
        }
      } else {
        RW._paintPoly(mpts, RW.maskAction==='block' ? 1 : 0);
      }
      RW._relabel();
      if (RW.maskAction==='add' && RW._polyPtsN && RW._polyPtsN.length){
        // Force-include the region at the centroid of the drawn poly
        const cxN = RW._polyPtsN.reduce((s,[x])=>s+x,0)/RW._polyPtsN.length;
        const cyN = RW._polyPtsN.reduce((s,[,y])=>s+y,0)/RW._polyPtsN.length;
        const cx = Math.round(cxN*RW.W), cy = Math.round(cyN*RW.H);
        if (cx>=0 && cx<RW.W && cy>=0 && cy<RW.H){
          const l = RW.labels[cy*RW.W + cx];
          if (l>=0 && RW.regions[l]) RW.regions[l].included = true;
        }
      }
      RW.renderList(); RW.renderOverlay();
      RW._renderCommitPreview();
    }
    RW._polyPtsN=[];
    const pl=document.getElementById('rw-polyline'); if(pl) pl.remove();
    RW._showAreaHint(null);
  }, true);

  ac.addEventListener('click', function(e){
    if (RW.maskMode2){ e.stopPropagation(); e.preventDefault(); }
  }, true);

  ac.addEventListener('wheel', function(e){
    if (RW.maskMode2!=='brush' || !RW.__tabHeld) return;
    e.stopPropagation(); e.preventDefault();
    RW.brushR = Math.min(30, Math.max(2, RW.brushR + (e.deltaY<0?1:-1)));
    const bb = document.getElementById('rw-brush');
    if (bb) bb.title = 'Brush radius: '+RW.brushR+' mask px (Tab+scroll to resize)';
    RW._renderBrushCursor(e.clientX, e.clientY);
  }, {capture:true, passive:false});

  ac.addEventListener('wheel', function(e){
    if (!RW.maskMode2) return;
    if (RW.__tabHeld) return;
    requestAnimationFrame(() => {
      if (RW.maskMode2==='brush') RW._renderBrushCursor(e.clientX||0, e.clientY||0);
    });
  }, {passive:true});

  window.addEventListener('keydown', function(e){
    if (e.key==='Tab' && RW.maskMode2==='brush'){ RW.__tabHeld = true; e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('keyup', function(e){
    if (e.key==='Tab') RW.__tabHeld = false;
  }, true);

  RW._renderBrushCursor = function(cx, cy){
    const svg = RW._mkSvg('rw-brushline', 72);
    const [nx,ny]=RW._toNorm(cx,cy);
    const [px,py]=RW._toPx(nx,ny);
    const pr = RW._toPx(RW.brushR/RW.W, 0)[0];
    const col = RW._actionColor();
    const sw = 1.2;
    let inner = '<circle cx="'+px+'" cy="'+py+'" r="'+pr+'" fill="none" stroke="'+col+'" stroke-width="'+sw+'" stroke-dasharray="8"/>';
    if (RW._brushDown && RW._brushStroke && RW._brushStroke.length){
      const fill = RW.maskAction==='add' ? 'rgba(50,205,50,0.35)' : (RW.maskAction==='block' ? 'rgba(255,120,0,0.30)' : 'rgba(60,180,255,0.30)');
      // Render as a single thick polyline instead of N individual circles
      // (1 DOM node instead of potentially hundreds — huge perf win for long strokes)
      const ptsStr = RW._brushStroke.map(([snx,sny])=>{
        const [spx,spy]=RW._toPx(snx,sny);
        return spx+','+spy;
      }).join(' ');
      inner += '<polyline points="'+ptsStr+'" fill="none" stroke="'+fill+'" stroke-width="'+(pr*2)+'" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    svg.innerHTML = inner;
  };

  const sc = document.getElementById('canvas-scroll-container');
  sc.addEventListener('scroll', function(){
    if (!RW.maskMode2) return;
    if (RW.maskMode2==='poly2') RW._renderPreview(null);
  }, {passive:true});

  (function(){
    const orig = RW._renderPreview;
    RW._renderPreview = function(cursorClient){
      const ret = orig.call(RW, cursorClient);
      if (RW.maskMode2==='poly2'){
        const svg = document.getElementById('rw-polyline');
        if (svg){
          const col = RW._actionColor();
          svg.querySelectorAll('polyline,circle').forEach(el=>{
            el.setAttribute('stroke', col);
          });
        }
      }
      return ret;
    };
  })();

  window.addEventListener('keydown', function(e){
    const t=e.target;
    if (t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (e.ctrlKey||e.metaKey||e.altKey) return;
    const k = e.key.toLowerCase();
    if (k==='a'){
      e.preventDefault(); e.stopImmediatePropagation();
      RW.setMaskAction(RW.maskAction==='add' ? 'block' : 'add');
      return;
    }
    if (k==='n'){
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.shiftKey){ const next=RW.maskAction==='block'?'open':RW.maskAction==='open'?'add':'block'; RW.setMaskAction(next); return; }
      if (RW.maskMode==='rect'){ RW.maskMode=null; RW.__rectStartN=null; RW.__rectCurN=null;
        document.getElementById('annotation-canvas').style.cursor='';
        const rl=document.getElementById('rw-rectline'); if(rl) rl.remove();
        RW._syncRectBtn(); }
      RW.setMaskMode2(RW.maskMode2==='poly2' ? null : 'poly2');
    }
    if (k==='j'){
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.shiftKey){ const next=RW.maskAction==='block'?'open':RW.maskAction==='open'?'add':'block'; RW.setMaskAction(next); return; }
      if (RW.maskMode==='rect'){ RW.maskMode=null; RW.__rectStartN=null; RW.__rectCurN=null;
        document.getElementById('annotation-canvas').style.cursor='';
        const rl=document.getElementById('rw-rectline'); if(rl) rl.remove();
        RW._syncRectBtn(); }
      RW.setMaskMode2(RW.maskMode2==='brush' ? null : 'brush');
    }
    if (e.key==='Escape' && RW.maskMode2){
      e.preventDefault(); e.stopImmediatePropagation();
      if (RW.maskMode2==='poly2' && RW._polyPtsN && RW._polyPtsN.length){
        RW._polyPtsN=[];
        const pl=document.getElementById('rw-polyline'); if(pl) pl.remove();
      } else {
        RW.setMaskMode2(null);
      }
    }
    if (e.key==='Backspace' && RW.maskMode2==='poly2'){
      e.preventDefault(); e.stopImmediatePropagation();
      if (RW._polyPtsN && RW._polyPtsN.length){
        RW._polyPtsN.pop();
        RW._renderPreview(null);
      }
    }
  }, true);

  const bar = (document.getElementById('rw-pick') || {}).parentNode;
  const legacyPoly = document.getElementById('rw-poly');
  if (legacyPoly) legacyPoly.style.display = 'none';
  function addBtn(id, title){
    if (document.getElementById(id)) return null;
    const b=document.createElement('button');
    b.id=id; b.title=title;
    b.style.cssText='font-size:11px;padding:2px 6px;';
    bar.appendChild(b);
    return b;
  }
  const pb = addBtn('rw-poly2','Freeform mask: click vertices, double-click closes. Shift+N toggles mode.');
  if (pb) pb.onclick=()=>RW.setMaskMode2(RW.maskMode2==='poly2'?null:'poly2');
  const bb = addBtn('rw-brush','Freehand mask stroke. Tab+scroll resizes. Shift+J toggles mode.');
  if (bb) bb.onclick=()=>RW.setMaskMode2(RW.maskMode2==='brush'?null:'brush');
  const ab = document.createElement('button');
  ab.id='rw-addmode'; ab.title='Toggle Add Region mode. A key also toggles.';
  ab.style.cssText='font-size:11px;padding:2px 6px;';
  ab.onclick=()=>{
    RW.setMaskAction(RW.maskAction==='add' ? 'block' : 'add');
  };
  bar.appendChild(ab);
  RW._syncToolButtons();

  return 'v2.6 up: Poly2 (N) + Brush (J) + Add (A)';
})()
