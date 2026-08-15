// RW v2.3 — undo system for mask tools. Load AFTER rw_stable.js (needs v2.2).
(function(){
  const RW = window.__RW;
  if (!RW || !RW.v22) return 'need v2.2 first';
  if (RW.v23) return 'v2.3 already installed';
  RW.v23 = true;
  const ac = document.getElementById('annotation-canvas');

  RW._undoStack = [];
  RW._snapshot = function(label){
    RW._undoStack.push({
      label,
      wall: RW.wall.slice(),
      labels: RW.labels.slice(),
      nComp: RW.nComp,
      regions: JSON.parse(JSON.stringify(RW.regions.map(r=>({id:r.id,size:r.size,included:r.included,group:r.group,color:r.color})))),
    });
    if (RW._undoStack.length > 30) RW._undoStack.shift();
    RW._updateUndoBtn();
  };
  RW.undo = function(){
    const s = RW._undoStack.pop();
    if (!s) return 'nothing to undo';
    RW.wall = s.wall;
    RW.labels = s.labels;
    RW.nComp = s.nComp;
    RW.regions = s.regions;
    const live = new Set(RW.regions.map(r=>r.group));
    RW.selected = new Set(Array.from(RW.selected).filter(g=>live.has(g)));
    RW.renderList(); RW.renderOverlay();
    RW._updateUndoBtn();
    return 'undid: ' + s.label;
  };
  RW._updateUndoBtn = function(){
    const b = document.getElementById('rw-undo');
    if (b) b.innerText = 'Undo (`)' + (RW._undoStack.length ? ' '+RW._undoStack.length : '');
  };

  // mousedown capture (window-level)
  window.addEventListener('mousedown', function(e){
    if (RW._previewV!==4 || !RW.maskMode) return;
    if (e.target !== ac && !ac.contains(e.target)) return;
    if (RW.maskMode==='block' || RW.maskMode==='open' || RW.maskMode==='rect') RW._snapshot(RW.maskMode);
  }, true);

  // _paintPoly wrapper: snapshots once per commit
  const origPaintPoly = RW._paintPoly;
  let polySnapArmed = false;
  RW._paintPoly = function(pts, val){
    if (!polySnapArmed){
      polySnapArmed = true;
      RW._snapshot('poly');
      const r = origPaintPoly.apply(RW, arguments);
      polySnapArmed = false;
      return r;
    }
    return origPaintPoly.apply(RW, arguments);
  };

  const origApplyCut = RW.applyCut;
  RW.applyCut = function(){
    RW._snapshot('cut');
    return origApplyCut.apply(RW, arguments);
  };
  const origMerge = RW.mergeSelected;
  RW.mergeSelected = function(){
    if (RW.selected.size >= 2) RW._snapshot('merge');
    return origMerge.apply(RW, arguments);
  };

  // keydown capture (window-level)
  window.addEventListener('keydown', function(e){
    const t = e.target;
    if (t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (RW.maskMode !== 'poly') return;
    if (e.key === 'Backspace'){
      e.preventDefault(); e.stopImmediatePropagation();
      if (RW._polyPtsN && RW._polyPtsN.length){
        RW._polyPtsN.pop();
        RW._renderPreview(null);
      }
      return;
    }
    if (e.key === 'Escape'){
      e.preventDefault(); e.stopImmediatePropagation();
      if (RW._polyPtsN && RW._polyPtsN.length){
        RW._polyPtsN = [];
        const pl = document.getElementById('rw-polyline'); if (pl) pl.remove();
      } else {
        RW.setMaskMode(null);
      }
    }
  }, true);

  window.addEventListener('keydown', function(e){
    const t = e.target;
    if (t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    if (e.ctrlKey||e.metaKey||e.altKey) return;
    if (e.key === '`'){
      e.preventDefault(); e.stopImmediatePropagation();
      RW.undo();
    }
  }, true);

  const bar = (document.getElementById('rw-pick') || {}).parentNode;
  if (bar && !document.getElementById('rw-undo')){
    const b = document.createElement('button');
    b.id = 'rw-undo';
    b.title = 'Undo last mask edit (block/open/poly/cut/merge)';
    b.style.cssText = 'font-size:11px;padding:2px 6px;';
    b.onclick = ()=>RW.undo();
    bar.appendChild(b);
  }
  RW._updateUndoBtn();

  return 'v2.3 undo up: Backspace=poly point, Esc=clear points then close, `=undo mask edit';
})()
