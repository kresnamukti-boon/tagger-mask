// RW vsec — panel reorganization: labelled sections instead of one long
// wrapping row.
//
// Post-load reflow: modules keep appending to the original anonymous
// button-bar; this module moves controls BY ID into labelled sections
// afterward. The `(document.getElementById('rw-pick')||{}).parentNode`
// idiom every module uses keeps working — that element still exists, just
// gets emptied after everyone else has appended to it.
//
// Timing: rw_panelux.js's retrofit() (wraps everything into #rw-body) is
// deferred via setTimeout(...,100). This module runs synchronously near the
// end of the same concatenated script, before that timer fires. Anchored
// off #rw-list's OWN parent, not #rw-panel by name.
//
// Load AFTER every tool module and BEFORE rw_elbow.js.
(function(){
  const RW = window.__RW;
  if (!RW || !RW.v31) return 'need v3.1 (rw_wallspan.js) first';
  if (RW.vsec) return 'panel sections already installed';
  RW.vsec = true;

  // Shared style constants for new code to reuse; existing modules keep
  // their own inline copies untouched.
  RW.ui = {
    BTN: 'font-size:11px;padding:2px 6px;',
    NUM: 'font-size:11px;padding:1px 4px;width:44px;text-align:right;',
    LBL: 'font-size:10px;opacity:0.7;margin-left:4px;',
    ACCENT: 'background:rgba(255,140,0,0.25);',
  };

  const list = document.getElementById('rw-list');
  const host = list && list.parentNode; // #rw-panel now, or #rw-body if retrofit already ran
  if (!host){ return 'panel sections: #rw-list not found, skipping'; }

  // Capture the legacy bar BEFORE the sweep, same lookup every module uses.
  const legacyBar = (document.getElementById('rw-pick') || {}).parentNode;

  const sections = document.createElement('div');
  sections.id = 'rw-sections';
  const anchor = document.getElementById('rw-commit-status') || list;
  host.insertBefore(sections, anchor);

  const sectionEls = {};
  let firstSection = true;
  RW.panelSection = function(key, label){
    const existingId = 'rw-sec-' + key;
    let row = document.getElementById(existingId);
    if (row) return row;
    const wrap = document.createElement('div');
    wrap.className = 'rw-sec';
    wrap.dataset.sec = key;
    wrap.style.cssText = 'margin-bottom:6px;' + (firstSection ? '' : 'border-top:1px solid rgba(128,128,128,0.22);padding-top:5px;');
    firstSection = false;
    const lbl = document.createElement('div');
    lbl.id = 'rw-sec-label-' + key;
    lbl.innerText = label;
    lbl.style.cssText = 'font-size:9px;letter-spacing:0.09em;text-transform:uppercase;opacity:0.55;margin-bottom:3px;user-select:none;';
    wrap.appendChild(lbl);
    row = document.createElement('div');
    row.id = existingId;
    row.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;align-items:center;';
    wrap.appendChild(row);
    sections.appendChild(wrap);
    sectionEls[key] = row;
    return row;
  };

  // Pre-create every section in display order.
  const REGIONS  = RW.panelSection('regions',  'REGIONS');
  const MASK     = RW.panelSection('mask',     'MASK TOOLS');
  const HEAL     = RW.panelSection('heal',     'HEAL');
  const PIPE     = RW.panelSection('pipe',     'PIPE');
  const FITTINGS = RW.panelSection('fittings', 'FITTINGS');
  const VIEW     = RW.panelSection('view',     'VIEW');

  // id -> destination section, in intended visual order. A missing id is
  // skipped.
  const moves = [
    [REGIONS, ['rw-pick','rw-merge','rw-cut','rw-commit','rw-refresh','rw-undo']],
    [MASK,    ['rw-rect','rw-poly2','rw-brush','rw-snap','rw-relabel-inp','rw-relabel-btn','rw-addmode']],
    [HEAL,    ['rw-heal-group','rw-healbrush-btn']],
    [PIPE,    ['rw-pipe-group']],
    [VIEW,    ['rw-walls','rw-hide','rw-textdetect-group']],
  ];

  // Label for the area-floor input.
  const relabelInp = document.getElementById('rw-relabel-inp');
  if (relabelInp && !document.getElementById('rw-relabel-label')){
    const l = document.createElement('span');
    l.id = 'rw-relabel-label';
    l.innerText = 'min area'; l.style.cssText = RW.ui.LBL;
    relabelInp.parentNode.insertBefore(l, relabelInp);
  }

  const movedIds = [];
  moves.forEach(([sectionEl, ids]) => {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (id === 'rw-relabel-inp'){
        const l = document.getElementById('rw-relabel-label');
        if (l) { sectionEl.appendChild(l); }
      }
      sectionEl.appendChild(el);
      movedIds.push(id);
    });
  });

  // Restore flex/gap on group-wrapper spans (#rw-pipe-group/#rw-textdetect-group
  // predate this reorg and need it set explicitly; #rw-heal-group already sets
  // its own).
  //
  // Real bug found live: `cssText += 'display:inline-flex;...'` appends a
  // second `display` declaration rather than replacing it — for
  // #rw-textdetect-group the existing one is `display:none` (rw_textdetect.js's
  // deliberate hide), and the LATER declaration wins, silently un-hiding it.
  // Fixed by setting individual style properties and preserving `display:none`
  // on anything already hidden.
  ['rw-pipe-group','rw-textdetect-group'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const alreadyHidden = el.style.display === 'none';
    el.style.display = alreadyHidden ? 'none' : 'inline-flex';
    el.style.gap = '4px';
    el.style.alignItems = 'center';
  });

  // Safety net: an unanticipated leftover control stays visible (unsectioned)
  // with a console warning, rather than silently disappearing.
  if (legacyBar){
    if (legacyBar.children.length){
      console.warn('[RW] unmapped panel controls left in the legacy bar:',
        Array.from(legacyBar.children).map(c => c.id || c.tagName));
    } else {
      legacyBar.remove();
    }
  }

  // Hide a section that ended up with zero children — build-time only, not a
  // live re-evaluation. Deferred via setTimeout(0): checked synchronously,
  // FITTINGS would always look empty here since rw_elbow.js (loaded right
  // after this module) hasn't run yet, and would get hidden permanently.
  // Deferring to the next tick runs this after the whole loader has finished.
  setTimeout(function(){
    Object.keys(sectionEls).forEach(key => {
      const row = sectionEls[key];
      if (row && !row.children.length) row.parentNode.style.display = 'none';
    });
  }, 0);

  return 'panel sections up: ' + Object.keys(sectionEls).length + ' sections, ' + movedIds.length + ' controls relocated';
})()
