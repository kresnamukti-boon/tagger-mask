Region Workbench — Console Loader
==================================

What it does
------------
A browser-based tool that reads the drawing's linework and proposes blank areas as
commit-ready polygon regions. Designed for pavement area segmentation jobs on the
Constructions Tagger platform. Every polygon goes through the annotator for review
before saving — nothing auto-submits.

How to use
----------
1. Open your annotation job page on Constructions Tagger (the page where you see
   the drawing canvas and the annotation toolbar).

2. Press F12 to open Chrome DevTools.

3. Click the "Console" tab at the top of the DevTools panel.

4. Copy the ENTIRE contents of console_loader.js (Ctrl+A, Ctrl+C).

5. Paste into the console (Ctrl+V) and press Enter.

6. Wait ~1-2 seconds. You'll see "[RW] workbench ready: N regions" appear in the
   console, and a "Region Workbench" panel will appear in the right sidebar.

7. Use the panel and keyboard shortcuts to select, curate, and commit regions.

8. To move to the next page: press ] (or [ for previous page), paste the script
   again in the new page's console.

Key shortcuts
-------------
P          — Pick mode (click regions on the canvas to select)
B          — Rect mask (Shift+B toggles block/open)
N          — Poly2 mask (Shift+N toggles block/open)
J          — Brush mask (Shift+J toggles block/open)
K          — Cut (split a region)
`          — Undo last mask edit
Delete/Backspace — Delete selected regions (pick mode)
H          — Coverage heatmap
/          — Focus tag search
[ / ]      — Previous/Next page

Important
---------
- Paste the script ONCE per page. It doesn't persist across page navigation.
- Nothing is saved to the server until you click the app's "Save" button.
- The tool runs entirely in your browser. No data leaves the page until Save.
- The "RW: ON/OFF" toggle in the panel header disarms all workbench shortcuts
  and returns the app to normal behavior.
