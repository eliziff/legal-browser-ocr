# Releases

## v0.2.5 — Optional GPU queue edition

The standard full and compact CPU editions retain v0.2.4's models, inference
code and default execution policy. This release adds a separate
`legal-browser-ocr-gpu-queued.html` that overlaps GPU inference with class-ID
download, retaining at most two prepared batches. Automatic CPU recovery remains
available. Use the standard edition when the queued build does not help.

Two browser sessions per machine run 48 timed 55-page passes in alternating
ABBA/BAAB blocks, with opposite starting orders:

| Balanced browser WebGPU | Control pages/s | Queued pages/s | Matched change | CER |
| --- | ---: | ---: | ---: | ---: |
| RTX 3080 Ti desktop | 18.11 | 19.08 | +5.2% | 2.302% |
| Intel UHD laptop | 6.93 | 7.06 | +1.9% | 2.213% |

The desktop sessions improve 6.31% and 4.17%; laptop sessions change -0.03%
and +3.93%. A portable speedup is unproven. Text, line positions, inference
work and exported PDFs remain identical within each host. Warm rates exclude
startup, input opening and export. These are browser GPU figures, not native
runtime measurements. See the [experiment guide](https://github.com/eliziff/legal-browser-ocr/blob/main/experiments/ocr-speed/README.md)
for all blocks, earlier screens and limitations.

Validation includes 56 source tests, the queue's eleven Chromium/Firefox
compatibility cases, Quality/Extreme full-document checks, and hash comparisons
of repackaged code and model assets against the tested builds. The repackaged
queue also passes four fresh Chromium cases: offline CPU, hosted WebGPU and
CPU recovery from injected GPU initialization and execution failures. The native
Windows executable/package and portable kernel build sources are unchanged from v0.2.4;
the shared model archive retains the same weights. Firefox automation currently
fails to create a blank page, so no new Firefox execution is claimed for this
repackaging. Safari hardware remains untested.

Classifier fusion, packed weights, scratch-buffer reuse, quantized detection
and the recognition cascade remain experiments. Their source and measured
tradeoffs are documented; none changes the standard runtime defaults.
