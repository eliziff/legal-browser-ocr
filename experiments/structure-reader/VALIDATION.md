# Candidate validation ? September 13, 2026

Upstream pin: `0e1196c9ccda26982010561ebd7ee5837f9770be`.
The shared fix retains source headings, forwards OCR markers with missing spaces
to the existing ladder, and preserves source heading groups when rebuilding regions from OCR lines. Native marker spacing stays unchanged.

Upstream checks passed: 65 structure tests, 25 support tests with native layout
features, and three OCR tests. All 13 frozen native products (711 pages) remained
byte-identical; all seven independent source-gold checks passed. Baselines were
not regenerated. No OCR inference/runtime changes were made.

The reported 24-page Chamberlain PDF reproduced one heading after 211.9 seconds
in the previous browser package. Native extraction without visual layout yielded
21 heading nodes in about five seconds. A local rasterized copy was recognized in
20.4 seconds; its captured OCR/layout inputs produced the exact same 23-node
heading graph in native upstream and WASM before this fix. That graph exposed
missing hierarchy and split wrapped titles. Private diagnostic inputs stay local
and are not packaged or checked in.

Final local checks: 12 native/WASM mapping, extraction, graph, profile and raster
checks passed, plus both actual JS-worker parity cases from offline `file://`.
The 22 base OCR/export tests passed. Native/mixed-PDF browser checks passed,
including saved-ToC reload and engine-version invalidation.

Chamberlain's final native detection returned 21 heading nodes in 1.16 seconds.
Replaying the scanned copy with its captured Accurate layout returned 19 entries
in 1.20 seconds: the three wrapped titles now stay grouped, and A/B/C headings
retain their upstream parents. Complete pages, graph and diagnostics match native
upstream exactly. This replay timing excludes model inference. The uncached
24-page Accurate layout run took 260 seconds during validation; it remains slow
in single-threaded file mode. One author byline remains a false-positive heading,
and recognized text still contains OCR errors. These are not claimed fixed.

`build.mjs` now runs the native reference and complete extraction/graph parity
checks and the actual offline JS-worker transport before creating the package. It also checks both model image preparations
and the shared raster separator ABI. `--gate-only` runs without downloaded OCR or
layout models. The same command runs in CI; Cargo.lock and the upstream lockfile
check prevent silently mixing Inspector or legal-structure revisions.

`pipeline.test.mjs` independently calls native upstream extraction, annotation and
structure APIs and compares their full records with WASM. Fixtures cover native,
scanned, mixed and rotated PDFs, plus captured Accurate/Fast model output. The
captured OCR fixture has four independently specified headings and an unwanted
OCR fragment; raw model labels cannot bypass the final graph.

Fast leaves eight fixture lines uncovered, so upstream discards its layout.
That refusal is tested explicitly. Accurate covers all four intended headings.
This does not claim perfect heading detection on arbitrary documents.

Browser checks use offline `file://` HTML. They cover original-byte preservation
for native PDFs, mixed-page OCR routing, reader selection, ToC navigation,
fullscreen, history, reload and bounded page rendering. The separate selection
check exercises highlight paint while dragging across lines, margins and gaps,
including saved PDFs with overlapping old OCR text.
