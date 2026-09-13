# Browser structure reader

This is a separate experimental edition of legal-browser-ocr. Open `index.html`
directly in current Chrome or Edge. It is a self-contained local file: OCR,
both regioning models, structure WASM, PDF.js and its support files are embedded.
No server, Node.js installation, or network connection is needed to use it.
`Start.ps1` is an optional Windows shortcut that opens the same HTML file.

The HTML is about 208 MiB because it includes the Accurate model as well as Fast.
Only the selected model is decoded for inference. Direct file use runs layout
inference in one worker thread; OCR keeps its existing optimized runtime.
Recent PDFs stay in browser storage. Keep the HTML at a stable location and use
the same browser profile to retain access to that history; HTTP and file history
are separate browser storage contexts.

## Reading and detection

Digital PDFs open with their original text and skip OCR. Mixed PDFs retain native
pages and recognize only the pages upstream extraction flags for OCR.
For scanned PDFs, recognize every page to open a searchable PDF. **Detect structure** adds a
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
fix preserves validated layout roles when OCR has no font metrics; the shared
heading grammar and prose demotion still decide the final graph. The optimized
OCR runtime is unchanged. There is no browser heading grammar.

Region postprocessing and assignment use the upstream public Rust API on both
native and WASM. Cubic image preprocessing and model-output decoding functions
that currently share a file with native inference are selected
verbatim at build time. Upstream source changes fail the build if these boundaries
change; no second maintained copy is checked in.

Model manifests pin revisions, SHA-256, label order, dimensions and the published
0.5 output threshold. Original inference YAML files record preprocessing settings.
The Fast ONNX export is by stefanj0, from the official PaddlePaddle model; Accurate
uses PaddlePaddle's ONNX export. Runtime loading checks each model's SHA-256.

OCR crop geometry is transformed to PDF page coordinates. Unknown font size stays
unknown: ink-box height is not a font metric. Upstream only receives region
assignments when every nonblank OCR line matches a region. Otherwise the reader
reports that model regions were discarded. General's ToC uses only final upstream
heading nodes and their graph hierarchy. Raw model labels never create ToC entries.
Legal profiles retain parser sections.

Detection processes one page at a time, uses up to four WASM threads where available,
and disposes its worker after completion. Compiled Rust WASM and per-document layout
results are reused. The input limit is 4 MB of extraction JSON. PDF bookmark export
is not included. Extraction runs the pinned upstream PDF Inspector and extraction
crates in WASM, retaining native fonts, spans, geometry and OCR routing. A native
reference executable checks extraction records and final graphs against WASM.

## Build and validation

From the repository root, with Node/npm, Rust, the wasm32-unknown-unknown target
and the existing licensed OCR assets described in the root README. Install the
wasm-bindgen CLI version matching Cargo.lock (currently 0.2.127), available on PATH
or through the WASM_BINDGEN environment variable. The build uses generated upstream
JavaScript bindings for WASM imports:

```sh
npm ci
npm run bundle
node experiments/structure-reader/fetch-models.mjs
node experiments/structure-reader/build.mjs
npm test
node --test experiments/structure-reader/mapping.test.mjs
cargo build --manifest-path experiments/structure-reader/Cargo.toml --bin upstream-parity --locked
node --test experiments/structure-reader/pipeline.test.mjs
node experiments/structure-reader/native-browser.test.mjs
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

## Selection and heading hierarchy update

PDF.js is pinned to 6.3.289, including upstream's removal of its obsolete selection
workaround on Chromium 148 and later:
https://github.com/mozilla/pdf.js/commit/ea43bb43fba60cfc69024df91d98d319a787d038
The viewer, PDF worker, styles, fonts, CMaps and image decoders are packaged together.
The PDF loader uses the current loading-task cleanup API. OCR computation is unchanged.

General uses the final upstream graph's heading nodes and parent relationships.
The adapter does not run a separate heading ladder or infer numbering levels.
Titles retain their own numbering, but the
ToC no longer adds page labels. Clicking a title still navigates to its source.
Select Detect structure again to calculate levels for a previously saved result.

The mapping check covers graph hierarchy and section wrappers. The upstream suite
covers Roman/letter/numeric heading grammar. `node experiments/structure-reader/selection-smoke.mjs`
checks forward/reverse drags, margins, gaps and direction changes, including the
painted highlight. Set SELECTION_BROWSER to chrome or msedge to test the installed
browser rather than Playwright's bundled Chromium. These checks did not reproduce
the intermittent inverted selection reported on the original document; the update
removes a confirmed upstream incompatibility and the tested selections paint correctly.

The reader disables PDF.js's optional selection compositor (enableSelectionRendering: false), using the browser's native text-layer highlight without generated selection overlays.

Export preserves existing PDF text and omits OCR lines where native text already
covers the same line. Matching is spatial, so a native page stamp does not suppress
the scanned body. Reopening a saved document rebuilds only our text layer from its
saved OCR once per session, correcting previously overlapping copies without OCR
inference. Tests verify unchanged page pixels, mixed scanned/native pages, and
selection paint during movement. Set SELECTION_EXISTING_TEXT=1 for the overlapping
text regression fixture. Both browser smoke scripts open the HTML through file://.
