# Upstream port validation

The browser pins legal-pdf-parser `f0f9383f7642233a97aab1e472b140592b8f9d0f`,
including current main's native-fidelity fixes and the OCR source-role correction
in [upstream PR 7](https://github.com/eliziff/legal-pdf-parser/pull/7).
That PR also forwards bare dotted PDF heading markers to the existing upstream
ladder, retaining their actual bold-font evidence. The public standing-offer
source independently specifies the five previously missing subheadings.
The build requires Inspector and legal-structure to match that revision's lockfile.

The upstream candidate passed 113 focused tests, all 13 frozen PDF products
(711 pages), and seven independent source-gold checks. The frozen products were
compared without regenerating their baseline. Checks include heading identity,
paragraph boundaries, source footnotes and annotation appearance text.

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
