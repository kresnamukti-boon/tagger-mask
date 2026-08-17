// Region Workbench v2 — single-shot installer.
// Paste-injected via OpenCLI eval. All listeners named/registered once.
(function(){
  if (window.__RW && window.__RW.v === 2) return 'RW v2 already installed';

  const RW = window.__RW = { v: 2, W: 2592, H: 1728, selected: new Set(), hovered: null, pickMode: false };

  /* ---------- segmentation ---------- */
  RW.extract = function(){
    const src = document.getElementById('pdf-canvas');
    // scale extraction resolution to native canvas size
    let {W,H} = RW;
    const nw = src.width, nh = src.height;
    if (nw && nh && (nw > W*1.3 || nh > H*1.3)){
      W = RW.W = Math.min(nw, 3888);
      H = RW.H = Math.round(W * (nh/nw));
      RW._areaFloor = Math.round(2500 * (W*H) / (2592*1728));
    }
    const areaFloor = RW._areaFloor != null ? RW._areaFloor : 2500;
    const cv = document.createElement('canvas'); cv.width=W; cv.height=H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(src, 0, 0, W, H);
    const d = ctx.getImageData(0,0,W,H).data;
    let wall = new Uint8Array(W*H);
    for (let i=0;i<W*H;i++){
      // min RGB channel: catches colored (yellow/green/blue) lines too
      const minChan = Math.min(d[i*4], d[i*4+1], d[i*4+2]);
      if (minChan < 200) wall[i]=1;
    }
    // no morphological pass
    // knock out existing annotations
    const c2 = document.createElement('canvas'); c2.width=W; c2.height=H;
    const x2 = c2.getContext('2d');
    for (const a of annotationState.annotations){
      if (a._hidden || a.is_void) continue;
      // Array.isArray guard: bbox-type annotations store {x,y,width,height}, not a point array
      const pts = a.coordinates; if (!Array.isArray(pts) || !pts.length) continue;
      x2.fillStyle='#000';
      x2.beginPath();
      pts.forEach((p,i)=>{ const X=p.x*W, Y=p.y*H; i?x2.lineTo(X,Y):x2.moveTo(X,Y); });
      x2.closePath(); x2.fill();
    }
    const dd = x2.getImageData(0,0,W,H).data;
    for (let i=0;i<W*H;i++) if (dd[i*4+3]>127) wall[i]=1;
    // background flood from border
    const seen = new Uint8Array(W*H);
    const q=[];
    for (let x=0;x<W;x++){ q.push(x,(H-1)*W+x); }
    for (let y=0;y<H;y++){ q.push(y*W,y*W+W-1); }
    while(q.length){
      const i=q.pop();
      if (seen[i]||wall[i]) continue;
      seen[i]=1;
      const x=i%W, y=(i/W)|0;
      if(x>0)q.push(i-1); if(x<W-1)q.push(i+1);
      if(y>0)q.push(i-W); if(y<H-1)q.push(i+W);
    }
    // label enclosed components
    const labels = new Int32Array(W*H).fill(-1);
    let nComp=0; const sizes=[];
    for (let s=0;s<W*H;s++){
      if (seen[s]||wall[s]||labels[s]>=0) continue;
      const stack=[s]; labels[s]=nComp; let size=0;
      while(stack.length){
        const i=stack.pop(); size++;
        const x=i%W, y=(i/W)|0;
        if(x>0&&!seen[i-1]&&!wall[i-1]&&labels[i-1]<0){labels[i-1]=nComp;stack.push(i-1);}
        if(x<W-1&&!seen[i+1]&&!wall[i+1]&&labels[i+1]<0){labels[i+1]=nComp;stack.push(i+1);}
        if(y>0&&!seen[i-W]&&!wall[i-W]&&labels[i-W]<0){labels[i-W]=nComp;stack.push(i-W);}
        if(y<H-1&&!seen[i+W]&&!wall[i+W]&&labels[i+W]<0){labels[i+W]=nComp;stack.push(i+W);}
      }
      sizes.push(size); nComp++;
    }
    RW.labels=labels; RW.nComp=nComp; RW.wall=wall;
    RW.regions = sizes.map((size,id)=>({id, size, included: size>=areaFloor, group: id, color:'hsl('+((id*67)%360)+',70%,55%)'}));
    return {components:nComp, kept: RW.regions.filter(r=>r.included).length, W, H};
  };

  /* ---------- overlay ---------- */
  RW.renderOverlay = function(){
    const {W,H,labels,regions,selected,hovered} = RW;
    const old = document.getElementById('rw-overlay'); if(old) old.remove();
    const cv = document.createElement('canvas'); cv.width=W; cv.height=H;
    cv.id='rw-overlay';
    cv.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:45;opacity:0.55;image-rendering:auto;';
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(W,H);
    const tmp = document.createElement('canvas').getContext('2d');
    const groupColor = {};
    for (const r of regions){
      if (!r.included || (r.group in groupColor)) continue;
      tmp.fillStyle = r.color;
      groupColor[r.group] = tmp.fillStyle.match(/\d+/g).map(Number);
    }
    for (let i=0;i<W*H;i++){
      const l = labels[i];
      if (l<0) continue;
      const r = regions[l];
      if (!r || !r.included) continue;
      const c = groupColor[r.group] || [200,200,200];
      let a = 110;
      if (selected.has(r.group)) a = 255;
      else if (hovered === r.group) a = 220;
      img.data[i*4]=c[0]; img.data[i*4+1]=c[1]; img.data[i*4+2]=c[2]; img.data[i*4+3]=a;
    }
    if (selected.size){
      for (let y=1;y<H-1;y++) for (let x=1;x<W-1;x++){
        const i=y*W+x; const l=labels[i];
        if (l<0) continue;
        const r=regions[l]; if(!r||!selected.has(r.group)) continue;
        const g = (ll)=> ll>=0 && regions[ll] && selected.has(regions[ll].group);
        if (!g(labels[i-1])||!g(labels[i+1])||!g(labels[i-W])||!g(labels[i+W])){
          img.data[i*4]=255; img.data[i*4+1]=255; img.data[i*4+2]=255; img.data[i*4+3]=255;
        }
      }
    }
    ctx.putImageData(img,0,0);
    document.getElementById('pdf-container').appendChild(cv);
    if (RW.overlayHidden) cv.style.display = 'none';
  };

  /* ---------- panel ---------- */
  RW.buildPanel = function(){
    const old = document.getElementById('rw-panel'); if(old) old.remove();
    const rail = document.getElementById('right-rail-content');
    const panel = document.createElement('div');
    panel.id='rw-panel';
    panel.style.cssText='border-top:1px solid #999;margin-top:8px;padding:8px;font-size:12px;max-height:45%;overflow-y:auto;';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><b>Region Workbench</b><span id="rw-count" style="opacity:0.7"></span></div>' +
      '<div style="margin-bottom:6px;display:flex;gap:4px;flex-wrap:wrap;">' +
      '<button id="rw-pick" style="font-size:11px;padding:2px 6px;">Pick</button>' +
      '<button id="rw-merge" style="font-size:11px;padding:2px 6px;">Merge</button>' +
      '<button id="rw-cut" style="font-size:11px;padding:2px 6px;">Cut</button>' +
      '<button id="rw-commit" style="font-size:11px;padding:2px 6px;">Commit</button>' +
      '<button id="rw-refresh" style="font-size:11px;padding:2px 6px;">Re-extract</button>' +
      '<button id="rw-hide" style="font-size:11px;padding:2px 6px;">Hide</button>' +
      '</div><div id="rw-list"></div>';
    rail.insertBefore(panel, rail.firstChild);
    document.getElementById('rw-pick').onclick = ()=>RW.setPick(!RW.pickMode);
    document.getElementById('rw-merge').onclick = ()=>RW.mergeSelected();
    document.getElementById('rw-cut').onclick = ()=>RW.setCut(true);
    document.getElementById('rw-refresh').onclick = ()=>{ RW.extract(); RW.renderList(); RW.renderOverlay(); };
    document.getElementById('rw-hide').onclick = ()=>{
      const o = document.getElementById('rw-overlay');
      if (o) { o.style.display = o.style.display==='none'?'':'none'; RW.overlayHidden = o.style.display==='none'; }
      const p = document.getElementById('rw-commitpreview');
      if (p) p.style.display = RW.overlayHidden ? 'none' : '';
    };
    document.getElementById('rw-commit').onclick = ()=>RW.commitSelected && RW.commitSelected();
    RW.renderList();
  };

  RW.renderList = function(){
    const list = document.getElementById('rw-list');
    if (!list) return;
    const kept = RW.regions.filter(r=>r.included);
    const groups = {};
    for (const r of kept){ (groups[r.group]=groups[r.group]||[]).push(r); }
    document.getElementById('rw-count').innerText = Object.keys(groups).length + ' groups';
    list.innerHTML='';
    Object.entries(groups)
      .sort((a,b)=>{
        const sa=a[1].reduce((s,m)=>s+m.size,0), sb=b[1].reduce((s,m)=>s+m.size,0);
        return sb-sa;
      })
      .forEach(([gid, members])=>{
        const total = members.reduce((s,m)=>s+m.size,0);
        const row = document.createElement('div');
        row.dataset.group = gid;
        row.style.cssText='display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:3px;cursor:pointer;user-select:none;';
        if (RW.selected.has(+gid)) row.classList.add('rw-sel'), row.style.background='rgba(80,120,255,0.25)';
        const sw = document.createElement('span');
        sw.style.cssText='width:12px;height:12px;background:'+members[0].color+';display:inline-block;border-radius:2px;flex:none;';
        const label = document.createElement('span');
        const pct = (100*total/(RW.W*RW.H)).toFixed(1);
        label.innerText = 'G'+gid+' · '+members.length+'p · '+pct+'%';
        label.style.cssText='flex:1;opacity:0.85;';
        row.appendChild(sw); row.appendChild(label);
        row.onclick = ()=>RW.toggleGroup(+gid);
        row.onmouseenter = ()=>{ if(!RW.pickMode){ RW.hovered=+gid; RW.renderOverlay(); } };
        row.onmouseleave = ()=>{ if(!RW.pickMode){ RW.hovered=null; RW.renderOverlay(); } };
        list.appendChild(row);
      });
  };

  RW.toggleGroup = function(gid){
    if (RW.selected.has(gid)) RW.selected.delete(gid); else RW.selected.add(gid);
    document.querySelectorAll('#rw-list > div').forEach(row=>{
      const g = +row.dataset.group;
      const on = RW.selected.has(g);
      row.classList.toggle('rw-sel', on);
      row.style.background = on ? 'rgba(80,120,255,0.25)' : '';
    });
    RW.renderOverlay();
    RW._renderCommitPreview();
  };

  /* ---------- merge ---------- */
  RW.mergeSelected = function(){
    if (RW.selected.size < 2) return;
    const ids = Array.from(RW.selected).sort((a,b)=>a-b);
    const target = ids[0];
    for (const r of RW.regions){ if (RW.selected.has(r.group)) r.group = target; }
    RW.selected = new Set([target]);
    RW.renderList(); RW.renderOverlay();
  };

  /* ---------- cut ---------- */
  RW.cutMode = false; RW.cutStart = null;
  RW.setCut = function(on){
    RW.cutMode = on; RW.cutStart = null;
    document.getElementById('annotation-canvas').style.cursor = on ? 'crosshair' : '';
    if (!on){ const g=document.getElementById('rw-cutline'); if(g) g.remove(); }
  };
  RW.applyCut = function(p1, p2){
    const {W,H,labels,regions} = RW;
    const cr = document.getElementById('pdf-container').getBoundingClientRect();
    const x1=(p1.x-cr.x)/cr.width*W, y1=(p1.y-cr.y)/cr.height*H;
    const x2=(p2.x-cr.x)/cr.width*W, y2=(p2.y-cr.y)/cr.height*H;
    const dx=x2-x1, dy=y2-y1;
    const mx=Math.round((x1+x2)/2), my=Math.round((y1+y2)/2);
    const hitLabel=(mx>=0&&mx<W&&my>=0&&my<H)?labels[my*W+mx]:-1;
    if (hitLabel<0) return;
    const hitGroup = regions[hitLabel].group;
    const newId = RW.nComp++;
    let moved=0;
    for (let y=0;y<H;y++) for (let x=0;x<W;x++){
      const i=y*W+x; const l=labels[i];
      if (l<0 || regions[l].group!==hitGroup) continue;
      const side = dy*x - dx*y + (x2*y1 - y2*x1);
      if (side>0){ labels[i]=newId; moved++; }
    }
    regions.push({id:newId, size:moved, included:true, group:newId, color:'hsl('+Math.floor(Math.random()*360)+',85%,50%)'});
    const sizes={};
    for (let i=0;i<W*H;i++){ const l=labels[i]; if(l>=0) sizes[l]=(sizes[l]||0)+1; }
    for (const r of regions){ if (r.id in sizes) r.size=sizes[r.id]; }
    RW.renderList(); RW.renderOverlay();
  };

  /* ---------- commit preview ---------- */
  RW._rawContour = function(gid){
    const {W,H,labels,regions} = RW;
    const memberIds = new Set(regions.filter(r=>r.group===gid).map(r=>r.id));
    if (!memberIds.size) return null;
    const uni = new Int8Array(W*H);
    for (let i=0;i<W*H;i++){
      const l = labels[i];
      uni[i] = (l>=0 && memberIds.has(l)) ? 1 : 0;
    }
    const on = (x,y)=> x>=0&&x<W&&y>=0&&y<H&&uni[y*W+x]===1;
    let sx=-1, sy=-1;
    outer: for (let y=0;y<H;y++) for (let x=0;x<W;x++){ if(on(x,y)){sx=x;sy=y;break outer;} }
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
    return path.map(([x,y])=>({x:+(x/W).toFixed(6), y:+(y/H).toFixed(6)}));
  };

  RW._renderCommitPreview = function(){
      const old = document.getElementById('rw-commitpreview'); if(old) old.remove();
      if (!RW.selected.size) return;
      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.id = 'rw-commitpreview';
      svg.setAttribute('viewBox','0 0 '+RW.W+' '+RW.H);
      svg.setAttribute('preserveAspectRatio','none');
      svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:75;';
      // zoom-invariant stroke: 2.5 screen px → SVG units at current zoom
      const container = document.getElementById('pdf-container');
      const sw = container ? 2.5 * RW.W / container.clientWidth : 2.5;
      const dash = sw * 2.4;
      let inner = '';
      for (const gid of RW.selected){
        const path = RW._rawContour(gid);
        if (!path || path.length<3) continue;
        const pts = path.map(p=>(p.x*RW.W)+','+(p.y*RW.H)).join(' ');
        const col = RW.regions.filter(r=>r.group===gid)[0]?.color || '#ccc';
        inner += '<polyline points="'+pts+'" fill="none" stroke="'+col+'" stroke-width="'+sw.toFixed(2)+'" stroke-dasharray="'+dash.toFixed(1)+','+(dash*0.5).toFixed(1)+'"/>';
      }
    svg.innerHTML = inner;
    document.getElementById('pdf-container').appendChild(svg);
  };
  RW.setPick = function(on){
    RW.pickMode = on;
    document.getElementById('rw-pick').style.background = on ? 'rgba(80,120,255,0.35)' : '';
    document.getElementById('annotation-canvas').style.cursor = on ? 'pointer' : '';
    if (on){
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      const popup=document.getElementById('selection-popup');
      if (popup) popup.style.display='none';
    }
    if (!on && RW.hovered!==null){ RW.hovered=null; RW.renderOverlay(); }
  };

  RW.groupAt = function(clientX, clientY){
    const cr = document.getElementById('pdf-container').getBoundingClientRect();
    const x = Math.round((clientX-cr.x)/cr.width*RW.W);
    const y = Math.round((clientY-cr.y)/cr.height*RW.H);
    if (x<0||x>=RW.W||y<0||y>=RW.H) return null;
    const l = RW.labels[y*RW.W+x];
    if (l<0) return null;
    const r = RW.regions[l];
    return (r && r.included) ? r.group : null;
  };

  /* ---------- global event wiring (once) ---------- */
  const ac = document.getElementById('annotation-canvas');

  ac.addEventListener('mousedown', function(e){
    if (RW.pickMode){
      e.stopPropagation(); e.preventDefault();
      RW.__downPos = {x:e.clientX, y:e.clientY};
      return;
    }
    if (RW.cutMode){
      e.stopPropagation(); e.preventDefault();
      RW.cutStart = {x:e.clientX, y:e.clientY};
    }
  }, true);

  ac.addEventListener('mousemove', function(e){
    if (RW.pickMode){
      e.stopPropagation();
      if (RW.__raf) return;
      RW.__raf = true;
      const cx=e.clientX, cy=e.clientY;
      requestAnimationFrame(()=>{
        RW.__raf=false;
        const g = RW.groupAt(cx,cy);
        if (g !== RW.hovered){ RW.hovered=g; RW.renderOverlay(); }
      });
      return;
    }
    if (RW.cutMode && RW.cutStart){
      e.stopPropagation();
      const container=document.getElementById('pdf-container');
      let svg=document.getElementById('rw-cutline');
      if (!svg){
        svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.id='rw-cutline';
        svg.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:70;';
        const ln=document.createElementNS('http://www.w3.org/2000/svg','line');
        ln.setAttribute('stroke','red');
        ln.setAttribute('stroke-width','2');
        svg.appendChild(ln);
        svg.__rwCutLine = ln;
        container.appendChild(svg);
      }
      const cr=container.getBoundingClientRect();
      const pc=(v,off,len)=>((v-off)/len*100)+'%';
      const ln=svg.__rwCutLine;
      if (ln){
        ln.setAttribute('x1',pc(RW.cutStart.x,cr.x,cr.width));
        ln.setAttribute('y1',pc(RW.cutStart.y,cr.y,cr.height));
        ln.setAttribute('x2',pc(e.clientX,cr.x,cr.width));
        ln.setAttribute('y2',pc(e.clientY,cr.y,cr.height));
      }
    }
  }, true);

  ac.addEventListener('mouseup', function(e){
    if (RW.pickMode){
      e.stopPropagation(); e.preventDefault();
      const d=RW.__downPos; RW.__downPos=null;
      if (d && Math.hypot(e.clientX-d.x,e.clientY-d.y)<=5){
        const g=RW.groupAt(e.clientX,e.clientY);
        if (g!==null) RW.toggleGroup(g);
      }
      return;
    }
    if (RW.cutMode && RW.cutStart){
      e.stopPropagation(); e.preventDefault();
      const s=RW.cutStart;
      RW.setCut(false);
      RW.applyCut(s,{x:e.clientX,y:e.clientY});
    }
  }, true);

  ac.addEventListener('click', function(e){
    if (RW.pickMode || RW.cutMode){ e.stopPropagation(); e.preventDefault(); }
  }, true);

  document.addEventListener('keydown', function(e){
    const t=e.target;
    if (t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (e.ctrlKey||e.metaKey||e.altKey) return;
    if ((e.key==='Delete'||e.key==='Backspace') && RW.pickMode && RW.selected.size){
      e.preventDefault(); e.stopImmediatePropagation();
      for (const sv of RW.selected){
        for (let i=0;i<RW.W*RW.H;i++){
          if (RW.labels[i]>=0 && RW.regions[RW.labels[i]] && RW.regions[RW.labels[i]].group===sv){
            RW.wall[i]=1;
          }
        }
      }
      RW.selected = new Set();
      RW._relabel(); RW.renderList(); RW.renderOverlay();
      RW._renderCommitPreview();
    }
  }, true);

  /* ---------- boot ---------- */
  RW.extract();
  RW.buildPanel();
  RW.renderOverlay();
  return 'RW v2 up: '+RW.regions.filter(r=>r.included).length+' regions';
})()
