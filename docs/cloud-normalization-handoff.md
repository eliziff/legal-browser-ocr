# Cloud normalization source preservation

This review branch preserves the retained `text-layer.js` and
`text-layer.test.mjs` changes from base commit
`edcd860be5066ba4dbdf7f9e25f3008494ea9a83`. The implementation/test bytes are
unchanged from the selected cloud work. This is a preservation handoff, not a
release or a claim of integration readiness. Zero tests, model calls, or corpus
evaluations were run for this branch delivery.

Related paragraph/passage changes and the retained shared evaluator source are
on `integration/cloud-normalization` in `eliziff/legal-pinpointer`, under
`tools/normalization-harness`. That source is not yet portable: original workspace
layout, manifest, fixture, and receipt assumptions remain. Its README documents
the required integrator cleanup; no portability fixes or fresh validation are
claimed here.

Only retained implementation, synthetic unit-test source, and this note are
included. No original/private documents, corpus/extraction fixtures, gold/sealed
data, raw logs, credentials, signed URLs, binaries, caches, or superseded
candidates are included. No Authorities/ALR work is included.

A lowercase word-final NOT sign remains ambiguous with a discretionary OCR
marker without provenance. No lost-content recovery is claimed. Earlier cloud
diagnostics recorded a small absolute cleanup timing cost, not an overall
speedup. Those diagnostics were not rerun for this handoff.
