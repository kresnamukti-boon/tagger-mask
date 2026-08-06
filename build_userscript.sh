#!/usr/bin/env bash
# Rebuild region-workbench.user.js from source modules after editing them.
set -euo pipefail
cd "$(dirname "$0")"

OUT=region-workbench.user.js

cat > "$OUT" <<'HEADER'
// ==UserScript==
// @name         Boon Tagger - Region Workbench
// @namespace    kresna.boon
// @version      1.1
// @description  Mask-based region extraction, curation, and polygon commit for Constructions Tagger
// @match        https://constructions-tagger-web.onrender.com/annotation-jobs/*/annotate/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Region Workbench — auto-loaded build (v1.1: DOM <script> injection so the
 * code runs in PAGE context under any Tampermonkey sandbox configuration).
 * Rebuild after editing sources: ./build_userscript.sh
 *
 * Boundaries: nothing auto-draws or auto-submits to the server. Committed
 * polygons are staged as pending edits through the app's own state/history
 * contract; Save is always manual.
 */

(function bootstrap(){
  'use strict';

  var SOURCE =
HEADER

for f in rw_install.js rw_masktools.js rw_stable.js rw_undo.js rw_commit.js wf_helpers.js; do
  # embed each module as a JS string chunk; join with newline separators (NOT '+'
  # string concatenation — adjacent IIFEs like })()("...") would be parsed as a call)
  python3 -c "import json; print(json.dumps(open('$f').read() + ';\n') + ' +')"
done >> "$OUT"

cat >> "$OUT" <<'FOOTER'
  "";

  function appReady(){
    try {
      return typeof annotationState !== 'undefined'
          && annotationState.annotations;
    } catch (e) { return false; }
  }

  function install(){
    var wrapped = '(function(){\n' + SOURCE + '\nreturn "[RW] modules installed";\n})()';
    var s = document.createElement('script');
    s.textContent = wrapped;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    console.log('[RW] injected into page context');
  }

  var tries = 0;
  var timer = setInterval(function(){
    tries++;
    var domReady = document.getElementById('pdf-canvas')
                && document.getElementById('annotation-canvas')
                && document.getElementById('right-rail-content');
    if (domReady || appReady()) {
      clearInterval(timer);
      setTimeout(install, 800);
    } else if (tries > 120) {
      clearInterval(timer);
      console.warn('[RW] page markers not found after 60s, giving up');
    }
  }, 500);
})();
FOOTER

echo "rebuilt $OUT ($(wc -c < "$OUT") bytes)"
