# Structure reader experiment

Recognize every page to open and remember a searchable PDF automatically.
Choose Case, Legislation or Agreement and select **Detect structure** to add a
Contents sidebar. Section buttons jump to the OCR line on its source page.
The reader scrolls continuously; use the page field for a direct jump and the
zoom menu for fit-width, fit-page or a fixed zoom.

Recent PDFs appear as navigation tabs. The browser stores PDF Blobs, OCR geometry
and detected contents in IndexedDB, with the active document and last page in
small synchronous localStorage entries. Reloading restores the active PDF without
OCR. **Remove from recents** deletes the selected saved PDF. Storage is specific
to this browser/origin; clearing browser data removes it. Storage failures are
reported while reading and downloading remain available for the session.

The OCR preview and side-by-side text live in a disclosure that closes when a
processed PDF opens or detection finishes. Expand **OCR preview and text** to
inspect results or change the crop. Input changes do not alter already saved PDFs.

Detection runs locally in a worker using the shared `legal-structure` engine at
the revision pinned in Cargo.toml and Cargo.lock. No duplicate heading grammar or
server is introduced. OCR text is limited to 4 MB in this experiment; inferred
structure depends on recognition quality and the chosen document profile.

The reader uses PDF.js PDFViewer, TextLayerBuilder and their stock stylesheet, including the
selection anchor and end-of-content stacking used in Beaver's September 11 fix
(`4d5734078`). Text remains selectable on the PDF. PDF bookmark export is not included.
The standard PDF.js rendering queue bounds rendered pages and caps each canvas at
8 million pixels. Only the active PDF Blob is read into an ArrayBuffer; switching
documents destroys the previous PDF.js loading task. The OCR runtime is unchanged.

Validation: 20 existing tests and two mapping/WASM tests passed. A two-page
synthetic scan passed real browser OCR, four detected sections, keyboard section
jumps, continuous scrolling, recent-document switching, reload restoration,
mobile reflow and removal from storage. A 40-page fixture retained four live
canvases after jumping to page 40. Two six-line
drags selected 231 characters with no backward jumps or next-section overshoot.
This verifies integration, not new corpus-wide detection accuracy.

Build from the repository root (Node/npm, Rust and the
`wasm32-unknown-unknown` target required):

```sh
npm ci
npm run bundle
node experiments/structure-reader/build.mjs
node --test experiments/structure-reader/mapping.test.mjs
```

The existing licensed `assets/` are required by `npm run bundle`, as described in
the root README. Open `dist/legal-browser-ocr-structure.html` locally. This is a
separate self-contained experimental package; the standard release is unchanged.

With Playwright and Chromium available in your development environment, run
`node experiments/structure-reader/browser-smoke.mjs` to repeat the full browser
check. Its generated fixture and screenshots go under `dist/structure-smoke/`.
