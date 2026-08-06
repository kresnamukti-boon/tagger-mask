// RW v2.2 — pan/zoom-stable previews. Stores in-progress geometry in normalized
// page coords (0-1 of page), converts to pixels at render time. Supersedes v3 preview handlers.
(function(){
  const RW = window.__RW;
  if (!RW || (!RW.v21 && !RW.v21r)) return 'need v2.1 first';
  if (RW.v22) return 'v2.2 already installed';
  RW.v22 = true;
  RW._previewV = 4;

  // client (screen) -> normalized page coords
  RW._toNorm = function(cx, cy){
    const cr = document.getElementById('pdf-container').getBoundingClientRect();
    return [(cx - cr.x)/cr.width, (cy - cr.y)/cr.height];
  };
  // normalized -> client px offset within container's box
  RW._toPx = function(nx, ny){
    const cr = document.getElementById('pdf-container').getBoundingClientRect();
    return [nx*cr.width, ny*cr.height];
  };

  RW._strokeK = function(){
    const pc = document.getElementById('pdf-container');
    const sc = document.getElementById('canvas-scroll-container');
    return pc.getBoundingClientRect().width / sc.getBoundingClientRect().width;
  };

  RW._mkSvg = function(id, z){
    const old = document.getElementById(id); if(old) old.remove();
    const container = document.getElementById('pdf-container');
    const cr = container.getBoundingClientRect();
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.id = id;
    svg.setAttribute('viewBox', '0 0 ' + cr.width + ' ' + cr.height);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:'+z+';';
    container.appendChild(svg);
    return svg;
  };

  // re-render previews from normalized state (call on mousemove AND on pan/zoom)
  RW._renderPreview = function(cursorClient){
    const sw = 1.5;   // constant screen px — zoom-invariant
    const dotR = 2.5;  // constant screen px

    // poly (legacy 'poly' via maskMode, v2.6 'poly2' via maskMode2)
    const polyActive = (RW.maskMode==='poly') || (RW.maskMode2==='poly2');
    if (polyActive && RW._polyPtsN && RW._polyPtsN.length){
      const svg = RW._mkSvg('rw-polyline', 71);
      const pts = RW._polyPtsN.map(([nx,ny])=>{
        const [px,py]=RW._toPx(nx,ny); return px+','+py;
      });
      if (cursorClient){
        const [cnx,cny]=RW._toNorm(cursorClient.x,cursorClient.y);
        const [px,py]=RW._toPx(cnx,cny);
        pts.push(px+','+py);
      }
      let inner = '<polyline points="'+pts.join(' ')+'" fill="rgba(255,160,60,0.18)" stroke="orange" stroke-width="'+sw+'"/>';
      for (const [nx,ny] of RW._polyPtsN){
        const [px,py]=RW._toPx(nx,ny);
        inner += '<circle cx="'+px+'" cy="'+py+'" r="'+dotR+'" fill="orange" stroke="white" stroke-width="1.0"/>';
      }
      svg.innerHTML = inner;
    }
    // rect preview (used by v2.1r _renderPreview2 wrapper)
    if ((RW.maskMode==='block' || RW.maskMode==='open' || RW.maskMode==='rect') && RW.__rectStartN){
      const svg = RW._mkSvg('rw-rectline', 71);
      let x0=RW.__rectStartN[0], y0=RW.__rectStartN[1];
      let x1=RW.__rectCurN ? RW.__rectCurN[0] : x0, y1=RW.__rectCurN ? RW.__rectCurN[1] : y0;
      const [ax,ay]=RW._toPx(Math.min(x0,x1),Math.min(y0,y1));
      const [bx,by]=RW._toPx(Math.max(x0,x1),Math.max(y0,y1));
      const col = RW.maskMode==='block' ? 'orange' : 'deepskyblue';
      svg.innerHTML='<rect x="'+ax+'" y="'+ay+'" width="'+(bx-ax)+'" height="'+(by-ay)+'" fill="rgba(255,160,60,0.10)" stroke="'+col+'" stroke-width="'+sw+'"/>';
    }
  };

  const ac = document.getElementById('annotation-canvas');

  // v4 listeners (guarded by _previewV so older handlers no-op)
  ac.addEventListener('mousedown', function(e){
    if (RW._previewV!==4 || !RW.maskMode) return;
    e.stopPropagation(); e.preventDefault();
    const [nx,ny]=RW._toNorm(e.clientX,e.clientY);
    if (RW.maskMode==='poly'){
      RW._polyPtsN = RW._polyPtsN || [];
      RW._polyPtsN.push([nx,ny]);
    } else {
      RW.__rectStartN = [nx,ny];
      RW.__rectCurN = [nx,ny];
    }
  }, true);

  ac.addEventListener('mousemove', function(e){
    if (RW._previewV!==4 || !RW.maskMode) return;
    e.stopPropagation();
    if (RW.maskMode==='block'||RW.maskMode==='open'){
      if (RW.__rectStartN) RW.__rectCurN = RW._toNorm(e.clientX,e.clientY);
    }
    RW._renderPreview({x:e.clientX,y:e.clientY});
  }, true);

  ac.addEventListener('mouseup', function(e){
    if (RW._previewV!==4 || !RW.maskMode) return;
    e.stopPropagation(); e.preventDefault();
    if (RW.maskMode==='poly') return; // commits on dblclick
    if (!RW.__rectStartN) return;
    const s=RW.__rectStartN; RW.__rectStartN=null; RW.__rectCurN=null;
    const rl=document.getElementById('rw-rectline'); if(rl) rl.remove();
    const e_n = RW._toNorm(e.clientX,e.clientY);
    const W=RW.W, H=RW.H;
    const val = RW.maskMode==='block' ? 1 : 0;
    if (RW.maskMode==='open'){
      // open mode: only convert wall pixels to non-wall. no perimeter seal.
      const xa=Math.max(0,Math.min(s[0]*W, e_n[0]*W)|0), xb=Math.min(W-1,Math.max(s[0]*W, e_n[0]*W)|0);
      const ya=Math.max(0,Math.min(s[1]*H, e_n[1]*H)|0), yb=Math.min(H-1,Math.max(s[1]*H, e_n[1]*H)|0);
      for (let y=ya;y<=yb;y++) for (let x=xa;x<=xb;x++) {
        if (RW.wall[y*W+x]===1) RW.wall[y*W+x]=0;
      }
    } else {
      RW._paintRect(s[0]*W, s[1]*H, e_n[0]*W, e_n[1]*H, val);
    }
    RW._relabel(); RW.renderList(); RW.renderOverlay();
    RW._renderCommitPreview();
  }, true);

  ac.addEventListener('dblclick', function(e){
    if (RW._previewV!==4 || RW.maskMode!=='poly') return;
    e.stopPropagation(); e.preventDefault();
    if (RW._polyPtsN && RW._polyPtsN.length>=3){
      const mpts = RW._polyPtsN.map(([nx,ny])=>[nx*RW.W, ny*RW.H]);
      RW._paintPoly(mpts, 1);
      RW._relabel(); RW.renderList(); RW.renderOverlay();
      RW._renderCommitPreview();
    }
    RW._polyPtsN=[];
    const pl=document.getElementById('rw-polyline'); if(pl) pl.remove();
  }, true);

  // keep preview glued during pan/zoom: re-render on scroll + wheel
  const sc = document.getElementById('canvas-scroll-container');
  sc.addEventListener('scroll', function(){
    if (RW._previewV!==4) return;
    if (!RW.maskMode && !RW.maskMode2) return;
    RW._renderPreview(null);
    if (RW._renderPreview2) RW._renderPreview2(null);
  }, {passive:true});
  // wheel = zoom (Ctrl+scroll) — re-render so stroke stays zoom-invariant
  ac.addEventListener('wheel', function(e){
    if (RW._previewV!==4) return;
    if (!RW.maskMode && !RW.maskMode2) return;
    // let the app handle the zoom, then re-render after a microtask
    requestAnimationFrame(() => {
      RW._renderPreview(null);
      if (RW._renderPreview2) RW._renderPreview2(null);
    });
  }, {passive:true});
  document.addEventListener('mouseup', function(){
    // after any pan gesture ends, re-render so preview re-anchors
    if (RW._previewV!==4 || !RW.maskMode) return;
    setTimeout(()=>RW._renderPreview(null), 30);
  }, true);

  // Escape clears normalized state too
  document.addEventListener('keydown', function(e){
    if (e.key==='Escape' && RW.maskMode){
      RW._polyPtsN=[]; RW.__rectStartN=null; RW.__rectCurN=null;
    }
  }, true);

  return 'v2.2 up: pan/zoom-stable previews (normalized coords)';
})()
