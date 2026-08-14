#!/bin/bash
# build SAM-enabled console loader
cd "$(dirname "$0")"
echo '/* Boon Region Workbench + SAM 2.1 — console loader.
 * Requires SAM server: python3 sam_server.py on port 5000.
 * Falls back to pixel extraction if server unavailable. */
(async function(){
  function ready(){
    return typeof annotationState !== "undefined"
        && annotationState.annotations
        && document.getElementById("pdf-canvas")
        && document.getElementById("annotation-canvas")
        && document.getElementById("right-rail-content");
  }
  for (let i=0; i<60 && !ready(); i++) await new Promise(r=>setTimeout(r,500));
  if (!ready()){ console.warn("[RW] app not ready"); return; }
  await new Promise(r=>setTimeout(r,600));
' > console_loader_sam.js

# modules in load order — rw_sam replaces the boot
for f in rw_panelux.js rw_install.js rw_masktools.js rw_stable.js rw_undo.js rw_commit.js rw_brushpoly.js rw_snap.js rw_sam.js wf_helpers.js; do
  echo -e "\n// ===== $f =====\n" >> console_loader_sam.js
  cat "$f" >> console_loader_sam.js
  echo ";" >> console_loader_sam.js
done

echo '
  console.log("[RW+SAM] workbench ready. SAM server: " + (window.__RW.useSAM ? "active" : "fallback") + ". Keys: P pick, K cut, B rect, N poly, J brush, ` undo");
})()' >> console_loader_sam.js

ls -lh console_loader_sam.js
wc -c console_loader_sam.js
