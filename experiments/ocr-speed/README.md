# Browser OCR speed experiments

## Released defaults (v0.2.4)

The full runtime now uses the crop-robust eight-block/128-channel recognizer
for Quality through Turbo and the crop-robust ten-block/64-channel recognizer
for Extreme. Human transcripts are gold; the Kraken training boxes remain
automatic geometry. The standard continuation selected epoch 51 after 40
additional epochs; identical clean-continuation stopping rules retained the
original epoch 19. The crop augmentation preserves every nonwhite pixel.

GPU crop preparation, GPU ArgMax, static command replay, an eight-shape cache
with a 256 MiB owned-buffer limit, and guarded scan-image reuse are enabled by
default. Shared app/embedding worker budgets follow hardware concurrency. GPU
failure in automatic mode retries on CPU. Direct GPU buffer packing remains
experimental because paired measurements did not establish a consistent gain.

The released accurate/Extreme compact CPU editions use the improved weights
and remain 5.39/3.83 MB offline, or 3.71/2.54 MB gzip. Native model packages use
the same new weights with ordinary width inputs; browser GPU graphs use an
equivalent external mask. Current measured figures belong to the README and
release notes. The sections below preserve the experiments and their controls.

## Queued GPU batch experiment

The queued-recognition experiment submits another GPU batch while the previous
batch's class IDs download, retaining at most two or four batch inputs. It keeps
the released models, detection, rendering and CTC decoding. Build from an existing
v0.2.4 full HTML with `node experiments/ocr-speed/build-queued-recognition.mjs 2`
(or `4`). Outputs are `dist/runtime-speed-queued-2.html` and `-4.html`, with
hash-bound build receipts. These are experimental builds; released defaults
remain unchanged.

Eight fresh-browser trials per candidate and machine use the order
control/candidate/candidate/control/candidate/control/control/candidate, with
three warm 55-page passes per trial. Each candidate has two paired comparisons
in each order and twelve warm passes per configuration.

| Browser GPU | Queued batches | Control pages/s | Candidate pages/s | Paired change | CER |
| --- | ---: | ---: | ---: | ---: | ---: |
| Intel UHD laptop | 2 | 5.82 | 6.59 | +11.1% | 2.213% |
| Intel UHD laptop | 4 | 5.49 | 5.31 | -6.2% | 2.213% |
| RTX 3080 Ti desktop | 2 | 16.83 | 18.29 | +8.1% | 2.302% |
| RTX 3080 Ti desktop | 4 | 18.13 | 20.75 | +11.0% | 2.302% |

Rates pool twelve warm whole-document passes; paired changes use the geometric
mean of four neighboring candidate/control ratios. All four desktop pairs favor
each candidate. The laptop two-batch pairs range from -6.6% to +32.2%, with three
wins; the four-batch variant wins one of four. The smaller queue is the better
cross-device candidate, but a dependable laptop improvement remains uncertain.
Within each host, every trial retains exact text, positioned lines, exported PDF
bytes, 156 model batches and 49,020,928 recognition pixels. Startup and export
are excluded. These are browser WebGPU measurements, not native runtime speeds.
Both HTML variants add 1,432 bytes to the 22.84 MB full package. Source checks
include bounded retention, line order and cleanup after allocation/model failures.

## Smaller standalone editions

Current source packages gzip-compressed assets lazily, with native decompression
and an existing pako fallback. `node build-single-html.mjs full|cpu|lite` builds
the full CPU/GPU edition, a CPU edition with Quality through Turbo, or CPU
Extreme only. All retain Indra detection, PDF input and searchable-PDF export.
The small compact HTML editions ship in v0.2.4; runtime/native archives retain
their full asset inventory.

The owning Beaver workspace's OCR harness adds a model-specific minimal engine
and portable preoptimized ORT graphs. Its `prepare_compact_runtime.py` produces
the graphs/operator configuration; `build_frontier_runtime.sh ... minimal`
builds ORT 1.22 with one compiler job and the existing SIMD matrix kernel.
`build_compact_package.mjs cpu|lite` creates a separate HTML without modifying
the shared model assets. Actual browser output and PDF gates follow conversion
parity; the original-precision edition retains exact 55-page text/geometry.

`prepare_compact_runtime.py --precision fp16|bf16` optionally rounds stored
recognizer values, retaining FP32 computation. The operator/type set is checked
against the compiled engine. `build_compact_package.mjs cpu|lite fp16|bf16`
packages those separate variants. These do not need BF16 or FP16 CPU hardware.
Rounding is lossy; development human-transcript accuracy precedes page testing.

The BF16 accurate package is 5.39 MB offline / 3.71 MB gzip; Lite is 3.83 /
2.54 MB. Full remains available at 22.84 / 16.84 MB with all five tiers and GPU
support. The installed Tesseract.js 7.0.0 engine/English reference is 3.46 MB
gzip without its PDF application. The laptop's three-pass 55-page measurements
are 4.31 pages/s / 2.511% CER Balanced, 4.09 / 2.253% Quality and 6.48 / 4.788%
Extreme. They do not establish a packaging-only throughput gain. Source tests,
Chromium/Firefox compatibility and searchable-PDF gates pass; Windows WebKit's
missing worker OffscreenCanvas path and Safari hardware coverage remain open.

Raw package inventories, human development scores and full-page receipts stay in
the owning ignored benchmark store. Model terms and upstream notices remain in
every package. See the repository README for the current aggregate size table.

This records the earlier CPU sweeps and their historical package names. The
0.2 release packages all five tiers with `npm run bundle`; it defaults to no
document thumbnails and includes CPU/WebGPU inference. The old builder flags
below describe the frozen experiment source, not the current release builder.
The current matched comparison is in the repository README.

## Scan-PDF and static GPU prototypes

The latest crop-robust 64-channel recognizer retains the original inference
architecture and alphabet. Training varies blank margins while preserving
nonwhite ink and the human transcripts; Kraken boxes remain automatic geometry.
Its matched laptop 55-page page CER improves from 4.795% to 3.954%, with similar
inference work. The rounded Compact Extreme variant is still 3.83 MB offline /
2.54 MB gzip and measures 6.56 CPU pages/s / 3.966% CER. Original-precision
compact weights score 3.962%; rounding adds five edits in 145,475 characters.
With `scanPages=1`, this small CPU package reaches 8.11 pages/s between
6.81 / 6.11 controls, retaining exact text, raw boxes and exported PDF bytes.

A custom portable SIMD128 HardSwish kernel fuses the detector's expanded
activation into one pass. With crop-robust Extreme it measures 11.95 laptop
pages/s / 3.954% CER, between controls of 11.06 and 11.26. Text, line geometry
and exported PDF bytes match. Balanced CPU improves modestly to 5.01 against
4.52 / 4.84 controls; Balanced GPU shows no established gain. The kernel uses
the normal ORT thread scheduler, without relaxed SIMD or FMA. Its 38-case
arithmetic check covers tails, in-place use, special values and guard writes;
the complete real detector output tensor also matches the old engine exactly.

The JS detector decoder now accumulates component boxes during traversal,
preserving exact arithmetic order. Its isolated median falls from 14.08 ms to
0.945 ms; actual full-document postprocessing falls about ninefold. Whole-page
timing controls drift, so those component wins are not claimed as a 9–15 times
OCR speedup. Batch/padding and detector-worker sweeps likewise retain results
without changing defaults where differences overlap run variability.

These models/kernels were promoted in v0.2.4. The owning workspace's
`experiments/ocr-candidate-screen/RESULTS.md` records controls, exact package
identities and limits; its README owns reproduction commands. The full prototype
uses `runtime-speed-crop64-hswish.html` with
`gpuCapture=1&gpuPrep=1&scanPages=1&gpuCache=8`. The small CPU variant uses
`legal-browser-ocr-lite-compact-crop-bf16.html` with `scanPages=1` for eligible
scanned PDFs and requires no GPU flags. Chromium/Firefox checks pass for both
new compact variants and the fused full runtime; Apple Safari is untested.

The follow-up tries a guarded single-image PDF path, more CPU detector workers,
GPU crop/ink/resize preparation, and static-shape graph capture with persistent
GPU buffers. The successful combination is now the v0.2.4 default. The following
measurements record the earlier prototypes before crop-robust training.

On the same 55-page human-transcribed document, the combined stock-detector
prototype measured the following three-warm-pass medians:

| Configuration | Warm pages/s | Page CER | First document, excluding initialization |
| --- | ---: | ---: | ---: |
| Laptop Balanced | 8.65 | 2.498% | 10.40 s |
| Laptop Quality | 6.31 | 2.237% | 15.07 s |
| Desktop Balanced | 18.02 | 2.598% | 7.27 s |
| Desktop Quality | 15.41 | 2.251% | 7.47 s |

First use creates shape-specific sessions, so these warm page rates do not
describe a fresh load. Laptop Quality varied from 5.59 to 7.26 pages/s across
its three passes. The frozen v0.2.3 laptop control measured 5.81 pages/s; its
desktop four-detector control measured 15.88. The candidate's desktop first
document was slower than that control's 6.57 seconds.

Use `dist/runtime-speed-gpu-capture.html` with
`?scanPages=1&gpuCapture=1&gpuPrep=1`; the desktop tests additionally used
`layoutWorkers=4`. This alternate HTML has an external-mask GPU graph and is
assembled by the Beaver workspace's `build_gpu_argmax.mjs capture` harness.
The v0.2.3 release HTML did not accept the alternate graph's inputs.
`gpuCapture=0` retains static buffers without command capture; `gpuPrep=0`
uses CPU crop preparation. The original prototype cache retained four shapes and
256 MiB of owned buffers, in addition to ORT resources and page textures.

The scan path falls back to PDF.js for overlays, annotations, clipping, multiple
images and unsupported transforms. Independent pixel comparisons cover page
rotations, odd image sizes, UserUnit and downscaling. GPU fractional resize is
numerically different from Canvas; human-transcript page CER remains the
accuracy gate. All completed cases passed offline recognition, stable output,
all-page exported text and original first-page pixel preservation.

A 45 KB detector student lost too much accuracy with the accurate recognizer
(about 5.2% page CER). A larger, refined and pruned 76 KB detector retains more
deep features and pairs with the accurate recognizer. At 736px it measured
**21.7-22.2 desktop pages/s / 4.521% CER**, versus Extreme's 20.79 / 4.806%.
On the laptop it measured 11.64 / 4.595%, versus Extreme's 12.48 / 4.795%.
The desktop result supports retaining it on the experimental Pareto curve.
A mirrored laptop repeat measured 9.71 pages/s / 4.595% CER versus Extreme's
10.22 / 4.795%; their speed ranges overlap. Stock 704px detection with the
accurate recognizer measured 10.29 / 3.767% in that repeat and is the stronger
laptop candidate. Neither detector is promoted from a single machine's result.
Geometry targets are
stock detector predictions on the existing train/dev pages, not corrected gold
boxes. Full results and reproduction belong to the owning
`experiments/ocr-candidate-screen` harness in the Beaver workspace.

The final alternate HTML is `dist/runtime-speed-detector-middle-fast.html` with
`?tier=turbo&detectorSide=736&gpuCapture=1&gpuPrep=1&scanPages=1&gpuCache=8`.
Add `layoutWorkers=4` for the desktop comparison. Its eight-shape cache retains
the same 256 MiB owned-buffer limit, reducing repeated GPU-session creation.
The accurate recognizer is intentional; selecting `tier=extreme` would substitute
the smaller recognizer and would be a different unvalidated combination.

The current shared source permits up to four CPU detectors using the reported
core budget: two on an eight-thread browser and four on a 12-thread browser.
This policy also reaches the embedding API. The released v0.2.3 figures below
describe its historical two-detector GPU limit.

The original speed measurements cover Chromium on the Intel UHD laptop and
RTX 3080 Ti desktop. Later same-build copy/direct/direct/copy repeats measured
about 6.24/6.34 laptop and 16.26/16.12 desktop pages/s; differences are within
the overlapping ranges. Direct GPU input remains opt-in. A newer laptop build
measured 6.59 pages/s / 2.498% CER, so the earlier 8.65 is an observed peak,
not a sustained headline for current builds.

The current source passes 14 real Chromium/Firefox compatibility cases,
including offline export, automatic CPU fallback after GPU initialization/run
failure, embedding, low core counts and JavaScript decompression. Full-page
accuracy still uses human transcripts. Windows WebKit lacks the required
worker OffscreenCanvas path; Safari hardware remains untested.

## Browser pipeline follow-up (v0.2.3)

The released browser defaults use a real PDF.js module worker, fixed ordered
four-page GPU batches and two bounded batches of document work. One GPU
recognizer overlaps a CPU crop worker and up to two CPU detectors; detector
count decreases on browsers reporting fewer cores. CPU recognition retains
its core-based worker limits. Crop sampling, recognition width and weights
are unchanged.

The full 55-page, three-warm-pass test measured 6.05 pages/s on the i3-1315U /
Intel UHD laptop and 12.73 on the Ryzen 5 2600X / RTX 3080 Ti desktop, at 2.512%
and 2.606% CER. Frozen v0.2.2 controls measured 5.46 and 8.56, with identical
recognized text on each machine. Initial model loading and PDF export are
excluded. The README records first-document latency separately.

For ablations, `prepareWorker=0`, `fixedBatch=0` and `pdfPort=0` disable their
respective stages, and `layoutBackend=webgpu&layoutWorkers=1` restores GPU
detection. These switches are measurement controls. They are unnecessary for
normal use. Turning off the crop worker measured 5.89 pages/s on the laptop
(three passes) and 10.24 on the desktop (one pass).

`gpuArgMax=128` is experimental and requires an alternate GPU graph. Its WGSL
parallel reduction passed independent numeric and tie checks and reduced a
prepared-tensor component from 7.6 to 4.1 ms on the laptop. It did not improve
the ordinary full-document configuration, so the released defaults retain
the existing compact-ID graph. ONNX Runtime Web 1.30's new C++/JSPI backend
also remained experimental: 4.71 pages/s versus the frozen 1.22 control's
5.46 on the laptop. CPU runtime and model assets remain unchanged.

The owning experiment harnesses and aggregate findings are in
`experiments/ocr-candidate-screen` in the Beaver workspace. Private receipts
include source, artifact and input hashes. Earlier builder commands below
describe historical experiments rather than the current five-tier builder.

These options exercise the normal file, recognition and searchable-PDF flow.
They preserve the packaged recognizer and original OCR image resolution.

`?preview=thumbnail` creates a display preview at up to 640 pixels wide and
encodes it asynchronously after page recognition. The default preview path
remains available for paired measurement. Timings separate PDF rasterization
from preview preparation/encoding; total document time includes both.

`?preview=none` skips the generated document-preview images and JPEG encoding.
All pages still render for OCR; the initial input/crop view stays available.
The package builders accept `no-previews` to make this the package default,
with a distinct `-no-previews` HTML/archive suffix. An explicit
`preview=thumbnail` restores the 640px images for a paired control. For example:

```sh
node build-runtime.mjs indra detectors pack=student8ids kernels=sgemm no-previews
node build-single-html.mjs indra detectors pack=student8ids kernels=sgemm no-previews
```

Use the same detector/worker query as the eight-block package below, omitting
`preview=thumbnail` to measure the no-preview default. The full-document gate
checks that generated previews are absent, OCR text and geometry match, and
the original pages and recognized text survive PDF export.

After staging the official detector assets in `assets/detectors/`, package with:

```sh
npm run build
node build-runtime.mjs indra detectors
node build-single-html.mjs indra detectors
```

Open `dist/legal-browser-ocr-indra-detectors.html` with `?detector=indra` or
`?detector=paddle`. The line-detection label identifies the selected model.
Each detector uses one CPU WASM thread per layout worker, the existing worker
queue, and the selected fine-tuned line recognizer. Geometry-based XY-cut and
the existing paired-column footnote ordering determine reading order. All
detected headers and footers remain eligible for recognition.

Indra uses the official 1024-pixel long side, inverted grayscale, white padding
to multiples of 32 and its four-connected core/distance decoder. Paddle uses
the official 736-pixel minimum short side, 4000-pixel maximum long side, BGR
ImageNet normalization, DB thresholds 0.2/0.4 and unclip ratio 1.4. Its browser
DB adapter uses connected components and convex-hull minimum rectangles;
the independent native reference checks coordinate differences from OpenCV
contours and polygon unclipping. `detectorSide` overrides the corresponding
size for resolution experiments; `detectorLimit=max` caps Paddle's long side
instead of preserving its default minimum-short-side policy.

The operator-reduced runtime is built from ONNX Runtime 1.22.0 with SIMD,
thread support and the union of both recognizers' and both detectors' required
operators. It retains ONNX loading and graph optimization. Stage its matching
loader/WASM and build metadata in `assets/reduced/`, then add `reduced`:

```sh
node build-runtime.mjs indra reduced
node build-single-html.mjs indra reduced
node build-runtime.mjs crnn reduced
node build-single-html.mjs crnn reduced
node build-runtime.mjs indra reduced detectors
node build-single-html.mjs indra reduced detectors
```

The resulting suffixes are `-reduced` and `-reduced-detectors`. The standard
full-runtime packages remain the controls. All model files, compiled runtimes
and packages are ignored assets; upstream model terms continue to apply.
No public deployment or model-default change is part of these experiments.

The measured speed candidate is `dist/legal-browser-ocr-indra-reduced-detectors.html`
with this query appended to its file URL:

```text
?detector=indra&detectorSide=768&preview=thumbnail&pool=6&layoutWorkers=4
```

It reached 8.02 pages/s at 2.527% page CER on the 12-page Ryzen 5 2600X trial,
with full recognition width. Omitting `detectorSide=768` uses the official
1024px setting: 6.73 pages/s at 2.160% CER. The equivalent tuned-Tesseract CRNN
experiment uses `dist/legal-browser-ocr-crnn-reduced.html` with:

```text
?preview=thumbnail&pool=6&layoutWorkers=4&layoutScale=.75&layoutTrim=1
```

It reached 4.00 pages/s at 2.776% CER. These are warm document timings,
including PDF rendering and finished previews, with startup and PDF export
reported separately. The reduced runtime saves 42.1% of WASM bytes; its
processing-speed gains alone were only 1–3%. Larger independent page and
hardware coverage is required before promoting these settings.

A separate recognizer was fine-tuned at Turbo's 76% width using the human gold
transcripts. Stage its verified pack under `assets/indra-speed/`, then package:

```sh
node build-runtime.mjs indra reduced detectors speed
node build-single-html.mjs indra reduced detectors speed
```

Open `dist/legal-browser-ocr-indra-reduced-detectors-speed.html`, append the
768px Indra query above, and select **Turbo**. The 12-page desktop follow-up
measured 8.98 pages/s at 3.623% CER, versus 9.26/4.849% for the earlier weights
in Turbo and 7.86–7.91/2.527% in Quality. Training improves Turbo accuracy;
Quality retains lower error. These trained weights remain separate from the
earlier `assets/indra/` pack. All four scenarios retain identical raw detector
geometry: the detector was not trained from the uncorrected Kraken boxes.

The subsequent full-document check uses all 55 existing test pages. Its later
desktop repeats measure the following lower-error choices, at full recognition
width with six recognition and four layout workers:

| Recognizer | Detector long side | Page CER | Warm pages/s |
| --- | ---: | ---: | ---: |
| Quality | 768px | 2.916% | 5.49 |
| Eight-block student | 768px | 3.110% | 5.90 |
| Eight-block student | 896px | 2.601% | 5.58 |
| Eight-block student | 1024px | 2.246% | 5.36 |

These use the experimental four-row SIMD kernel. It improves prepared
recognition throughput by 12–17%, but this pass does not establish a meaningful
whole-document gain from that kernel alone. The Turbo controls range from
6.13 to 6.67 pages/s as background load changes, so small speed differences
are uncertain. The 64-channel model reaches 8.50 pages/s at 4.784% CER and is
kept as an experiment rather than the lower-error replacement. The earlier
12-page timings and the 55-page workload are separate comparisons.

The tested eight-block package is
`dist/legal-browser-ocr-indra-detectors-student8ids-sgemm.html`. Select
**Quality**, then append:

```text
?detector=indra&detectorSide=896&preview=thumbnail&pool=6&layoutWorkers=4
```

Use `detectorSide=1024` for its lower-error tier. These settings change
detection resolution while keeping the full recognition width and alphabet.
Build the separate package after staging its local assets with
`node build-runtime.mjs indra detectors pack=student8ids kernels=sgemm` and
`node build-single-html.mjs indra detectors pack=student8ids kernels=sgemm`.
Additional six-row, FMA and direct depthwise kernels have separate
`kernels=tiles|fma|depthwise|fmadw` artifacts and remain under evaluation.

The no-preview variant is
`dist/legal-browser-ocr-indra-detectors-student8ids-sgemm-no-previews.html`.
Select **Quality** and use:

```text
?detector=indra&detectorSide=896&pool=6&layoutWorkers=4
```

On the same 55 pages, seven warm passes measured 6.45 pages/s at 2.601% CER,
with no generated document images. Thumbnail controls measured 6.18 and 6.37
pages/s with identical OCR text and geometry. This is about 1–4% faster, with
3.2% control drift, rather than a large established gain. All three passed
offline recognition and PDF character/pixel preservation. The input/crop view
remains; pages still render for OCR. Add `preview=thumbnail` to restore previews.

The follow-up `kernels=sgemm4dw` variant keeps the four-row matrix kernel and
adds direct nine-tap depthwise convolution. It improves prepared recognition
throughput by about 5%, with identical greedy IDs. On the full 55-page
no-preview document, however, its eight-block package measures 6.59 pages/s
at 2.601% CER versus four-row controls of 6.39 and 6.59. This does not establish
an additional document-speed gain. Text, geometry and exported PDF bytes match
the control. Its separate HTML/archive suffix is `-sgemm4dw-no-previews`;
the simpler four-row no-preview package above remains the practical choice.
The six-row and six-row/FMA variants were slower in prepared recognition and
are not selected.

Primary implementations:
[Indra detection and ordering](https://github.com/datalab-to/indra),
[Paddle DB decoding](https://github.com/PaddlePaddle/PaddleOCR/blob/main/ppocr/postprocess/db_postprocess.py),
[Paddle resize processing](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/inference/models/text_detection/processors.py),
[ORT operator reduction](https://onnxruntime.ai/docs/build/custom.html).
