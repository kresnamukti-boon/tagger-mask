#!/usr/bin/env bash
# Rebuild console_loader_ocr.js — the OCR-enabled variant — after editing
# rw_ocr.js or any of the base modules. Does not touch console_loader.js.
set -euo pipefail
cd "$(dirname "$0")"

OUT=console_loader_ocr.js

cat > "$OUT" <<'HEADER'
/* Boon Region Workbench — console loader (OCR variant).
 * Usage: F12 -> Console -> paste this entire block -> Enter.
 * Installs the full workbench (regions, mask tools, undo, commit, helpers)
 * plus OCR-assisted reference naming. Loads Tesseract.js from a CDN on
 * first OCR-button click only — everything else stays fully offline.
 * Paste again after each page navigation. Nothing persists server-side until you Save. */
(async function(){
  function ready(){
    return typeof annotationState !== 'undefined'
        && annotationState.annotations
        && document.getElementById('pdf-canvas')
        && document.getElementById('annotation-canvas')
        && document.getElementById('right-rail-content');
  }
  // wait for app (up to 30s) — safe to paste immediately on page load
  for (let i=0; i<60 && !ready(); i++) await new Promise(r=>setTimeout(r,500));
  if (!ready()){ console.warn('[RW] app not ready after 30s — try pasting again once the page renders'); return; }
  await new Promise(r=>setTimeout(r,600)); // let the canvas settle

HEADER

FIRST=1
# Same order as build_loader.sh, with rw_ocr.js appended last — it only
# needs RW to exist as a namespace, not any specific module's internals.
for f in rw_panelux.js rw_install.js rw_masktools.js rw_stable.js rw_undo.js rw_commit.js rw_brushpoly.js rw_healinterior.js rw_snap.js rw_textdetect.js rw_wallspan.js rw_panelsections.js rw_elbow.js rw_ocr.js; do
  if [ $FIRST -eq 0 ]; then printf ';\n' >> "$OUT"; fi
  FIRST=0
  echo "// ===== $f =====" >> "$OUT"
  cat "$f" >> "$OUT"
  printf '\n' >> "$OUT"
done

cat >> "$OUT" <<'FOOTER'

  console.log('[RW] workbench ready (OCR variant): ' + __RW.regions.filter(r=>r.included).length + ' regions. P=Pick K=Cut B=Rect N=Poly2 J=Brush A=Add O=Walls C=Pipe L=Elbow; ` undo, Escape cancel. In reference mode, an OCR button appears in the naming dialog.');
})()
FOOTER

node --check "$OUT" && echo "rebuilt $OUT ($(wc -c < "$OUT") bytes) — syntax OK"
