# Browser OCR speed experiments

This records the earlier CPU sweeps and their historical package names. The
0.2 release packages all five tiers with `npm run bundle`; it defaults to no
document thumbnails and includes CPU/WebGPU inference. The old builder flags
below describe the frozen experiment source, not the current release builder.
The current matched comparison is in the repository README.

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
