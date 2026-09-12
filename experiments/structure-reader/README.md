# Structure reader experiment

Recognize every page to open and remember a searchable PDF automatically.
Choose General, Legislation or Contract and select **Detect structure** to add a
Contents sidebar. Section buttons jump to the OCR line on its source page.
The reader scrolls continuously; use the page field for a direct jump and the
zoom menu for fit-width, fit-page or a fixed zoom.

Recent PDFs appear as navigation tabs. The browser stores PDF Blobs, OCR geometry
and detected contents in IndexedDB, with the active document and last page in
small synchronous localStorage entries. Reloading restores the active PDF without
OCR. The **×** on each tab asks for confirmation before deleting its saved PDF.
**History** lists saved PDFs; **Contents** collapses the dock and **Full screen**
uses browser fullscreen. Storage is specific
to this browser/origin; clearing browser data removes it. Storage failures are
reported while reading and downloading remain available for the session.

The OCR preview and side-by-side text live in a disclosure that closes when a
processed PDF opens or detection finishes. Expand **OCR preview and text** to
inspect results or change the crop. Input changes do not alter already saved PDFs.

Detection runs locally in a disposable worker. General uses upstream
`legal-pdf-structure::derive`; Legislation and Contract use `legal-structure`.
The direct structure dependency matches the PDF parser's pinned revision, so
the WASM contains one version of the engine. Cargo.lock records the combination.
The compiled WebAssembly.Module is reused between detections; terminating each
worker releases the document's WASM memory. OCR data is limited to 4 MB.

The browser passes OCR text, page dimensions and line boxes. General nodes map
back through upstream line IDs, because the parser's normalized text offsets
are not offsets into raw OCR text. The adapter has no heading grammar.

**Current limitation:** this package does not run the upstream PPDoc layout
model. Its native OpenVINO/ONNX path is not a browser WASM implementation.
OCR supplies neither reliable font names/bold flags nor semantic region labels.
The current bridge labels lines as body and uses ink height as a size estimate.
Consequently this is structure inference over OCR lines, not the complete native
PDF-analysis pipeline. Unnumbered title-case headings can be missed even when
visually obvious. Do not manufacture heading labels from size thresholds.
Full layout parity requires the actual layout provider's browser-compatible
model/runtime and its real region output; it must be validated independently
before claiming parity. Keep upstream parser source unchanged.

The WASM build now includes the exact `ppdoc_postprocess.rs` from the
Cargo-resolved upstream checkout, without a copied fork. `build.mjs --check`
checks this boundary; `build.mjs` builds it. The source path is resolved through
Cargo metadata, and upstream private-API changes intentionally fail compilation.
Optional per-page layout detections pass through that postprocessor and its
line-assignment function, retaining the upstream all-lines-covered requirement.
The original region assignments are returned alongside the graph: this pinned
parser can discard equal-size, unnumbered paragraph titles during classification.
Do not change sizes to force a desired classification.

`assets/layout-model.json` pins the official Apache-2.0 PaddlePaddle ONNX model
and its verified SHA-256. The downloaded `assets/layout.onnx` is excluded from
Git. Loading and inference have been exercised with ONNX Runtime Web WASM,
but model preprocessing, browser worker integration and real-PDF quality gates
remain pending. The region fixture test validates the adapter contract only.

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
