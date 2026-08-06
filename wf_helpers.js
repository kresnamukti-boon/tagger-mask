// Workflow helpers — page nav keys + coverage heatmap.
// Independent of Region Workbench. Safe to load alongside it.
(function(){
  if (window.__wfHelpers) return 'already installed';
  window.__wfHelpers = true;

  /* ---- [ ] page nav + / tag search ---- */
  document.addEventListener('keydown', function(e){
    const t = e.target;
    const typing = t && (t.tagName==='INPUT' || t.tagName==='TEXTAREA' || t.isContentEditable);
    if (!typing && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const s = document.getElementById('tag-search-input');
      if (s) { e.preventDefault(); s.focus(); s.select(); return; }
    }
    if (typing) return;
    if ((e.key === '[' || e.key === ']') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (typeof annotationState === 'undefined') return;
      const links = Array.from(document.querySelectorAll('a[href*="/annotate/"]'))
        .filter(a => a.href.includes(annotationState.jobId) && !a.href.includes(annotationState.jobPageId));
      if (!links.length) return;
      e.preventDefault();
      const idx = e.key === ']' ? links.length - 1 : 0;
      window.location.href = links[idx].href;
    }
  }, true);

  /* ---- H coverage heatmap ---- */
  window.__toggleHeatmap = function(){
    const existing = document.getElementById('wf-coverage-overlay');
    if (existing) { existing.remove(); return 'heatmap off'; }
    const container = document.getElementById('pdf-container');
    if (!container || typeof annotationState === 'undefined') return 'no page';
    const w = container.clientWidth, h = container.clientHeight;
    const cv = document.createElement('canvas');
    cv.id = 'wf-coverage-overlay';
    cv.width = Math.max(1, Math.round(w/4)); cv.height = Math.max(1, Math.round(h/4));
    cv.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:50;opacity:0.45;image-rendering:pixelated;';
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(255,80,80,0.55)';
    ctx.fillRect(0,0,cv.width,cv.height);
    ctx.globalCompositeOperation = 'destination-out';
    for (const a of annotationState.annotations) {
      if (a._hidden || a.is_void) continue;
      const pts = a.coordinates;
      if (!pts || !pts.length) continue;
      ctx.beginPath();
      pts.forEach((p,i)=>{ const X=p.x*cv.width, Y=p.y*cv.height; i?ctx.lineTo(X,Y):ctx.moveTo(X,Y); });
      ctx.closePath(); ctx.fill();
    }
    container.appendChild(cv);
    return 'heatmap on: red = uncovered ('+annotationState.annotations.length+' shapes)';
  };

  document.addEventListener('keydown', function(e){
    const t = e.target;
    if (t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if ((e.key==='h'||e.key==='H') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      window.__toggleHeatmap();
    }
  }, true);

  return 'wf helpers installed: [ ] nav, / tag search, H heatmap';
})()
