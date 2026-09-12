# Browser structure reader

This is a separate experimental edition of legal-browser-ocr. Extract the whole
package, then run `Start.ps1` on Windows (Node.js required), or `node serve.mjs`.
Open http://127.0.0.1:8799/. The server only serves static files on loopback;
OCR, layout inference, PDF viewing and storage all run in your browser. No document
is uploaded. The bundled models work without external services.

The folder may also be served by a static HTTPS host. Send
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` to enable WASM threads; otherwise
layout inference uses one thread. Opening index.html directly is insufficient
for loading the layout model.

## Reading and detection

Recognize every page to open a searchable PDF. **Detect structure** adds a
collapsible Contents dock. General uses visual layout regions; Legislation and
Contract use the corresponding upstream text parsers. General is the default.

General offers two regioning models:

| Option | Model | Input | Weight size | Tradeoff |
| --- | --- | --- | --- | --- |
| Accurate (default) | PP-DocLayout_plus-L | 800 x 800 | about 124 MiB | Better overall heading coverage; slower |
| Fast | PP-DocLayout-S | 480 x 480 | about 4.7 MiB | Lower latency; can miss headings |

Both models are bundled and run in ONNX Runtime Web WASM in a disposable worker.
The selector is disabled for the text-only legal profiles. A smaller model can
occasionally find a heading the larger model misses; Accurate is not a guarantee.
The browser remembers each document's selection and caches its layout results.

**Page layout** is the separate OCR segmentation choice. Keep **Tesseract layout**
for columns and complex pages. Fast projection is useful for simple, single-column
pages; it can join unrelated text across columns. Regioning cannot repair OCR
that already joined or omitted words. Neither option changes the OCR runtime.

Read continuously, enter a page number, choose a zoom, or enter full screen.
PDF.js owns text selection and rendering, including its stock text-layer CSS.
The rendering queue bounds live page canvases, capped at eight million pixels each.
OCR preview and text collapse after processing or detection.

Recent PDFs appear as tabs. The tab's x asks before removing its saved PDF;
History lists saved documents. IndexedDB stores PDFs, OCR geometry and contents;
reloading restores the active PDF and last page without OCR. Storage belongs to
this browser and origin. Clearing browser data removes saved documents.

## Upstream boundary

The Rust WASM adapter pins legal-pdf-parser and the same legal-structure revision
used by that parser. Cargo.lock records the exact combination. The upstream parser
and optimized OCR runtime are unchanged. There is no new heading grammar.

The build compiles the pinned upstream cubic image preprocessing, detection
postprocessing and region-to-line assignment directly from its Cargo checkout.
Pure functions that currently share a file with native inference are selected
verbatim at build time. Upstream source changes fail the build if these boundaries
change; no second maintained copy is checked in.

Model manifests pin revisions, SHA-256, label order, dimensions and the published
0.5 output threshold. Original inference YAML files record preprocessing settings.
The Fast ONNX export is by stefanj0, from the official PaddlePaddle model; Accurate
uses PaddlePaddle's ONNX export. Runtime loading checks each model's SHA-256.

OCR crop geometry is transformed to PDF page coordinates. Unknown font size stays
unknown: ink-box height is not a font metric. Upstream only receives region
assignments when every nonblank OCR line matches a region. Otherwise the reader
reports partial coverage. General's ToC retains model heading regions separately:
the pinned parser can demote valid unnumbered titles and its structural sections
can include ordinary numbered list items. Legal profiles retain parser sections.

Detection processes one page at a time, uses up to four WASM threads where available,
and disposes its worker after completion. Compiled Rust WASM and per-document layout
results are reused. The input limit is 4 MB of OCR JSON. PDF bookmark export and
full native extraction parity are not included.

## Build and validation

From the repository root, with Node/npm, Rust, the wasm32-unknown-unknown target
and the existing licensed OCR assets described in the root README:

```sh
npm ci
npm run bundle
node experiments/structure-reader/fetch-models.mjs
node experiments/structure-reader/build.mjs
npm test
node --test experiments/structure-reader/mapping.test.mjs
```

The runnable package is `dist/legal-browser-ocr-structure/`. Keep all files together.
The standard release is separate. Playwright checks require Playwright, Chromium
and @napi-rs/canvas in the development environment:

```sh
node experiments/structure-reader/browser-smoke.mjs
node experiments/structure-reader/real-pdf-smoke.mjs
```

The first script exercises real OCR, both models, selection drags, ToC, fullscreen,
restoration, tab removal and bounded rendering on a 40-page fixture. The second
uses public source PDFs downloaded to `dist/structure-smoke/public-{name}.pdf`:

- guidelines: https://www.w3.org/WAI/GL/WD-WAI-PAGEAUTH-19990104/wai-pageauth.pdf (pages 4-5)
- contract: https://canadabuys.canada.ca/documents/pub/att/2021/12/13/014e3478bc1a7ebe416c30db5613273d/ncc_rfso_tender_al1824_eng.pdf (page 12)
- legislation: https://laws-lois.justice.gc.ca/PDF/C-46.pdf (page 71 in the tested July 2026 consolidation; recheck page selection if it changes)

Results, raw model evidence and screenshots go under `dist/structure-smoke/`.
These are integration checks over selected pages, not a corpus-wide accuracy claim.

## Measured limits

On this machine, the two-page synthetic scan took approximately 7-8 seconds with
Accurate and 0.5-0.7 seconds with Fast, including cold worker/model loading. Accurate
found four of four headings, Fast three. Reusing cached regions took about 60 ms.
Two six-line selection drags stayed monotonic without overshooting the section.
The 40-page reader retained three to four live canvases after a jump to page 40.

On the four real sample pages, Accurate found 10 of 11 independently listed
headings; Fast found 8 of 11. Accurate missed the contract's top title, while Fast
missed Priorities and both English legislation headings. Both models can also
label prose as a heading. These are disclosed model limitations, not a repaired
upstream parser or proof of native parity. The sample test reports every miss and
checks that the two choices collectively cover the expected headings; it does not
require either model to be perfect. The published source page numbers and test
labels are explicit so future model comparisons can use the same evidence.

For the browser checks, install Playwright in your development environment and
run `npx playwright install chromium` if Chromium is not already available.
