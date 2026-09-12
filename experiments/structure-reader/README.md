# Structure reader experiment

Recognize every page, choose Case, Legislation or Agreement, then select
**Detect document structure**. The app adds the searchable layer and opens a
PDF reader with a Contents sidebar. Section buttons jump to the OCR line on its
source page. Previous/next page controls also work when no sections are inferred.
Changing the source, crop or document profile clears the reader.

Detection runs locally in a worker using the shared `legal-structure` engine at
the revision pinned in Cargo.toml and Cargo.lock. No duplicate heading grammar or
server is introduced. OCR text is limited to 4 MB in this experiment; inferred
structure depends on recognition quality and the chosen document profile.

The reader uses PDF.js TextLayerBuilder and its stock stylesheet, including the
selection anchor and end-of-content stacking used in Beaver's September 11 fix
(`4d5734078`). Text remains selectable on the PDF. Navigation is currently one
page at a time; PDF bookmark export is not included.

Validation: 20 existing tests and two mapping/WASM tests passed. A two-page
synthetic scan passed real browser OCR, four detected sections, keyboard section
jumps, previous/next navigation, mobile reflow and crop invalidation. Two six-line
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
