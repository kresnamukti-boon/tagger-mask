// RW v2-sam3 — SAM3 via Replicate, accessed through local proxy on :5001.
// Shift+S — SAM Box: draw a rect, SAM3 segments that area with text prompt.
// Server must be running: python3 sam3_proxy.py on port 5001.
(function(){
  const RW = window.__RW;
  if (!RW || !RW.v26) return 'need v2.6 first';
  if (RW.v2sam) return 'v2-sam already installed';
  RW.v2sam = true;
  RW.samBoxMode = false;
  // default prompt — change via prompt() dialog or edit here
  RW.samPrompt = 'pavement edges, concrete, hardscape boundaries, curbs';

  const ac = document.getElementById('annotation-canvas');
  let samStartN = null, samEndN = null;

  function samPreview(svgId, x0, y0, x1, y1){
    const svg = RW._mkSvg(svgId, 74);
    const [ax,ay] = RW._toPx(Math.min(x0,x1), Math.min(y0,y1));
    const [bx,by] = RW._toPx(Math.max(x0,x1), Math.max(y0,y1));
    svg.innerHTML = '<rect x="'+ax+'" y="'+ay+'" width="'+(bx-ax)+'" height="'+(by-ay)
      +'" fill="rgba(100,255,100,0.12)" stroke="#0f0" stroke-width="1.5" stroke-dasharray="6,3"/>';
  }

  async function sam3Extract(s_n, e_n){
    console.log('[SAM3] analyzing box with prompt:', RW.samPrompt);
    const src = document.getElementById('pdf-canvas');
    
    // crop the canvas to the drawn rectangle
    const cap = document.createElement('canvas');
    cap.width = 1024;
    cap.height = Math.round(1024 * src.height / src.width);
    const ctx = cap.getContext('2d');
    ctx.drawImage(src, 0, 0, cap.width, cap.height);
    
    // clip to box region
    const bx = Math.round(s_n[0] * cap.width);
    const by = Math.round(s_n[1] * cap.height);
    const bw = Math.round((e_n[0] - s_n[0]) * cap.width);
    const bh = Math.round((e_n[1] - s_n[1]) * cap.height);
    
    const crop = document.createElement('canvas');
    crop.width = Math.max(64, Math.abs(bw));
    crop.height = Math.max(64, Math.abs(bh));
    const cctx = crop.getContext('2d');
    cctx.drawImage(cap, Math.min(bx, bx+bw), Math.min(by, by+bh), crop.width, crop.height, 0, 0, crop.width, crop.height);
    
    const imgB64 = crop.toDataURL('image/png').split(',')[1];

    try {
      const res = await fetch('http://localhost:5001/segment', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({image: imgB64, prompt: RW.samPrompt, threshold: 0.3})
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      console.log('[SAM3] returned ' + data.masks.length + ' masks');

      if (!data.masks.length) return;

      // decode each mask and paint into wall array
      const {W, H} = RW;
      for (let mi = 0; mi < data.masks.length; mi++){
        const img = new Image();
        await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail;
          img.src = 'data:image/png;base64,' + data.masks[mi]; });

        const mc = document.createElement('canvas');
        mc.width = img.width; mc.height = img.height;
        const mctx = mc.getContext('2d');
        mctx.drawImage(img, 0, 0);
        const md = mctx.getImageData(0, 0, mc.width, mc.height).data;

        const sx = mc.width / W, sy = mc.height / H;
        for (let y = 0; y < H; y++){
          for (let x = 0; x < W; x++){
            const mx = Math.floor(x * sx), my = Math.floor(y * sy);
            if (md[(my * mc.width + mx) * 4 + 3] > 127){
              if (RW.wall[y * W + x] === 1) RW.wall[y * W + x] = 0;
            }
          }
        }
      }

      RW._relabel();
      RW.renderOverlay();
      if (RW._renderCommitPreview) RW._renderCommitPreview();
      console.log('[SAM3] ' + RW.regions.filter(r => r.included).length + ' included regions');

    } catch (e){
      console.warn('[SAM3] failed:', e.message);
    }
  }

  ac.addEventListener('mousedown', function(e){
    if (!RW.samBoxMode) return;
    e.stopPropagation(); e.preventDefault();
    samStartN = RW._toNorm(e.clientX, e.clientY);
    samEndN = samStartN.slice();
  }, true);

  ac.addEventListener('mousemove', function(e){
    if (!RW.samBoxMode || !samStartN) return;
    e.stopPropagation();
    samEndN = RW._toNorm(e.clientX, e.clientY);
    samPreview('rw-sambox', samStartN[0], samStartN[1], samEndN[0], samEndN[1]);
  }, true);

  ac.addEventListener('mouseup', function(e){
    if (!RW.samBoxMode || !samStartN) return;
    e.stopPropagation(); e.preventDefault();
    samEndN = RW._toNorm(e.clientX, e.clientY);
    const s = samStartN, en = samEndN;
    samStartN = null; samEndN = null;
    const svg = document.getElementById('rw-sambox'); if (svg) svg.remove();
    RW.samBoxMode = false;
    ac.style.cursor = '';
    document.getElementById('rw-sam-btn').style.background = '';
    sam3Extract(s, en);
  }, true);

  window.addEventListener('keydown', function(e){
    const t = e.target;
    if (t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (e.ctrlKey||e.metaKey||e.altKey) return;
    if (e.key === 'S' && e.shiftKey){
      e.preventDefault(); e.stopImmediatePropagation();
      RW.samBoxMode = !RW.samBoxMode;
      ac.style.cursor = RW.samBoxMode ? 'crosshair' : '';
      const btn = document.getElementById('rw-sam-btn');
      if (btn) btn.style.background = RW.samBoxMode ? 'rgba(100,255,100,0.45)' : '';
      if (RW.maskMode) { RW.maskMode = null; document.getElementById('annotation-canvas').style.cursor=''; }
      if (RW.maskMode2) { RW.setMaskMode2(null); }
      samStartN = null; samEndN = null;
    }
  }, true);

  window.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && RW.samBoxMode){
      e.preventDefault(); e.stopImmediatePropagation();
      RW.samBoxMode = false; samStartN = null; samEndN = null;
      ac.style.cursor = '';
      const svg = document.getElementById('rw-sambox'); if (svg) svg.remove();
      const btn = document.getElementById('rw-sam-btn');
      if (btn) btn.style.background = '';
    }
  }, true);

  const bar = (document.getElementById('rw-pick') || {}).parentNode;
  if (bar && !document.getElementById('rw-sam-btn')){
    const b = document.createElement('button');
    b.id = 'rw-sam-btn';
    b.title = 'SAM3 Box: draw rect → SAM3 segments with text prompt. Shift+S.';
    b.style.cssText = 'font-size:11px;padding:2px 6px;';
    b.innerText = 'SAM3 Box (S)';
    b.onclick = () => {
      RW.samBoxMode = !RW.samBoxMode;
      ac.style.cursor = RW.samBoxMode ? 'crosshair' : '';
      b.style.background = RW.samBoxMode ? 'rgba(100,255,100,0.45)' : '';
      if (RW.maskMode2) RW.setMaskMode2(null);
      samStartN = null; samEndN = null;
    };
    bar.appendChild(b);
  }

  return 'v2-sam3 up: Shift+S draws box → SAM3 segments via Replicate proxy :5001';
})()