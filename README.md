# Legal Browser OCR

Local PNG/PDF recognition with Indra, ONNX Runtime Web and PDF.js. Files and
recognized text stay on the device. The application is the browser companion to
[Legal PDF Parser](https://github.com/eliziff/legal-pdf-parser).

## Use

Open the [hosted application](https://eliziff.github.io/legal-browser-ocr/) or
download a package from [Releases](https://github.com/eliziff/legal-browser-ocr/releases):

| Package | Use |
| --- | --- |
| `legal-browser-ocr-runtime.tar.gz` | Serve the application and its local assets |
| `legal-browser-ocr.html` | Open the self-contained CPU/WebGPU application, including offline |
| `legal-browser-ocr-cpu-compact.html` | Smaller CPU application with Quality, Balanced, Fast and Turbo |
| `legal-browser-ocr-extreme-compact.html` | Smallest CPU application, Extreme only |
| `legal-ocr-models.tar.gz` | Shared models, tier manifest, checksums and model terms for native readers |
| `legal-ocr-runtime-windows-x64.zip` | Native PDF/image OCR with automatic CPU/DirectML selection and all five tiers |

Load a PNG or PDF, optionally select a crop, choose a quality tier, then select
**Recognize document**. Balanced is the default. Quality, Fast and Turbo adjust
line detection resolution; Extreme also uses a smaller recognizer and produces
more errors. All five retain full recognition width. Detailed tier measurements
belong to the release notes.

Supported browsers automatically use WebGPU with FP16 when available. Add
`?backend=cpu` to use CPU inference or `?backend=webgpu` to require GPU inference.
Measured worker overrides belong to individual benchmark configurations; the
CPU defaults follow the browser's reported hardware concurrency.
Automatic mode retries on CPU if GPU initialization or the GPU device fails.
GPU recognition overlaps CPU line detection with GPU crop preparation and uses
static command replay. Its shape cache retains at most eight shapes and 256 MiB
of owned buffers, in addition to runtime resources and page textures. PDF parsing
uses a dedicated worker, with two bounded page batches feeding the recognizer.
Ordinary single-image scan pages reuse the decoded image; other pages use the
normal PDF.js renderer.

Embedding hosts call `createBrowserOcr(assets)` from `browser-runtime.js`, supplying
asynchronous `assets.bytes(name)` and `assets.url(name)` functions. The returned
runtime provides `prepare(signal)`, `recognizePage(bitmap, signal)` and `dispose()`;
recognition consumes the bitmap and returns positioned text lines. Its default
tier, DPI and asset inventory live in `ocr-tiers.js` and `runtime-assets.js`.
`worker-policy.js` and `recognition-pool.js` share the browser app's backend choice,
worker limits, preparation and recognition. Hosts do not maintain OCR profiles.
Idle embedding workers are released after 30 seconds; a disposed runtime must be
created again. Cancellation returns promptly while already submitted work settles.

The native package runs without a browser, Node.js or Python. Extract it and run
`legalocr input.pdf --output recognized.json`; supported GPU providers use CPU
fallback, with core-based worker limits.
See [Legal PDF Parser](https://github.com/eliziff/legal-pdf-parser)
for native measurements and embedding configuration.

**Download searchable PDF** adds an invisible text layer to the original PDF
pages. PNG input is embedded on a new PDF page. Crops limit recognition, not
exported page content. Rotation and crop-box offsets are retained. Each export
starts from the original input, so repeat recognition does not accumulate layers.
Existing PDF text is preserved and can therefore be duplicated on an already
searchable input.

Text is fitted to detected line bounds with estimated character spacing; the
export does not provide word-accurate alignment. Review recognition before relying
on it. Document thumbnails are omitted; the initial input/crop view remains.

## Recorded performance

The comparison below uses a **Ryzen 5 2600X desktop**, full Chromium 151 and CPU
WebAssembly. Our rows are v0.2.4; stock Indra and Tesseract retain their earlier
matched baseline measurements. Every row uses the same **55-page PDF**, rendered by PDF.js at
144 dpi, and the same human gold transcripts: 145,475 normalized characters.
Figures are medians of three warm whole-document passes, including rendering,
line detection, recognition and text assembly. Startup, the initial input view
and PDF export are excluded; document thumbnails are disabled.

| Configuration | Pages/s | Character error rate |
| --- | ---: | ---: |
| **Our Indra Balanced** | **9.48** | **2.296%** |
| **Our Indra Quality** | **8.86** | **2.015%** |
| Stock Indra recognizer | 6.87 | 3.368% |
| Tesseract.js Fast | 2.27 | 2.281% |

Quality is about **3.9 times faster than the recorded Tesseract.js Fast baseline**
on these pages, with a lower character error rate. Balanced is about **4.2 times
faster**, with a slightly higher error rate. The CPU baseline runs predate the
new detector decoder and kernel; they have not been rerun with those changes.

Our profiles use the eight-block fine-tuned recognizer: 896px line detection for
Balanced and 1024px for Quality. The stock row uses the untouched pretrained
Indra recognizer in the same browser pipeline at 896px; it measures the pretrained
weights, not the upstream Python application's complete pipeline. Indra uses six
recognition workers and four detector workers. Tesseract.js 7.0.0 uses six persistent
workers, the official Fast English data, SIMD LSTM, automatic page segmentation,
and text/line output.

These are full-page results on an already examined legal-document partition,
not a fresh holdout or a guarantee for other documents or computers. The small
CER difference between Balanced and Tesseract is 22 character edits. Human gold
transcripts determine CER; the existing training line boxes came from automatic
segmentation and are not hand-corrected geometry gold.

The benchmark harness and retained aggregate findings are described in the
[speed experiment guide](experiments/ocr-speed/README.md). GPU component timings
are separate from this CPU table.

The **v0.2.4 browser runtime** adds crop-robust recognizers, GPU crop preparation,
command replay, guarded scan-image reuse, faster detection decoding and a fused
SIMD128 detector activation. GPU execution settings are shared by the application
and embedding runtime; no experimental URL flags are needed.

On the same 55-page PDF, the laptop's full CPU/WebGPU package measured:

| Tier, i3-1315U / Intel UHD, Chromium 149 | CPU pages/s | CPU CER | WebGPU pages/s | WebGPU CER |
| --- | ---: | ---: | ---: | ---: |
| Balanced | 3.70 | 2.211% | **7.03** | **2.213%** |
| Quality | 3.94 | 2.018% | **6.68** | **2.022%** |

Desktop Chromium 151 measured **18.25 WebGPU pages/s / 2.302% CER** in Balanced
and **14.81 / 2.011%** in Quality on the Ryzen 5 2600X / RTX 3080 Ti. These are
three-warm-pass medians. Shape-specific session compilation affects the first
document; warm throughput excludes initialization, input opening and PDF export.
CPU and WebGPU use their respective model exports and crop preparation paths.

Training changes blank margins while preserving nonwhite ink and human labels.
It reduces laptop Balanced page CER from 2.498% to 2.213%, Quality from 2.237%
to 2.022%, and Extreme from 4.795% to 3.954%, with unchanged architectures and
recognition width. Clean continuation without crop augmentation did not improve
the selected checkpoint. These pages have been examined during development;
they remain a regression benchmark, not a fresh holdout.

Chromium and Firefox pass offline PDF/export and embedding checks, including
CPU recovery after GPU initialization or device failure. Apple Safari hardware
remains untested. Timing varies with hardware, document layout and machine load;
CPU tier measurements can overlap. All 55 exported text pages and unchanged
original first-page pixels are checked by the full-document harness.

## Develop and package

With Node.js/npm installed:

```sh
npm ci
npm test
npm run build
npm run bundle
```

`build` compiles JavaScript. Packaging additionally needs the selected licensed
models, codecs, detector, layout assets and CPU runtime under `assets/`; those
binary assets are excluded from the source repository. The builders write the
runtime archive and standalone HTML into `dist/`.

[ocr-tiers.js](ocr-tiers.js) owns tier and model selection.
[build-runtime.mjs](build-runtime.mjs) and
[build-single-html.mjs](build-single-html.mjs) package the same assets.
Tests cover preprocessing, layout ordering, text geometry and PDF export; they
do not certify accuracy on a new corpus.

The release includes smaller standalone CPU editions. Sizes use decimal MB and
include PDF input and searchable-PDF export:

| Standalone edition | Offline HTML | Gzip transfer | Included tiers |
| --- | ---: | ---: | --- |
| Full CPU/WebGPU | 22.84 MB | 16.84 MB | All five |
| Accurate compact CPU | **5.39 MB** | **3.71 MB** | Quality through Turbo |
| Compact CPU Extreme | **3.83 MB** | **2.54 MB** | Extreme |

For scale, the installed Tesseract.js 7.0.0 SIMD-LSTM engine, worker/API and
Fast English data total **3.46 MB gzip**, excluding its PDF application.
The compact engine retains the required operators and portable preoptimized ORT
models. Recognizer weights are rounded to BF16 precision stored in FP32 tensors;
inference uses FP32 math and requires no BF16 hardware support. The full edition
retains the original exported precision and automatic WebGPU support.

On the laptop, the compact CPU edition measured **5.40 pages/s / 2.209% CER**
in Balanced and **4.98 / 2.022%** in Quality. Compact Extreme measured **8.30 /
3.966%**. These are three-warm-pass measurements on the same 55-page PDF;
machine timing drift prevents attributing the difference from the full package
to compaction alone.

Build the ordinary CPU editions with `node build-single-html.mjs cpu` or
`node build-single-html.mjs lite` after `npm run build`. The compact engine and
precision variants use the owning workspace's OCR experiment harness; see the
[experiment guide](experiments/ocr-speed/README.md). Native model archives retain
the normal width-input GPU graphs required by CUDA/DirectML readers; browser GPU
graphs use an equivalent external mask for command replay.

## Credits and license

Recognition and line detection derive from
[Indra](https://github.com/datalab-to/indra), with pretrained assets from
[datalab-to/indra-ocr](https://huggingface.co/datalab-to/indra-ocr).
Our recognizers were fine-tuned on legal-text line transcripts, then pruned and
exported for this runtime. ONNX Runtime Web runs inference; PDF.js renders input;
pdf-lib writes searchable PDFs with glyphless Type 3 fonts and Unicode maps.

Application code is [MIT](LICENSE). **Indra model weights have separate terms**:
the upstream [modified AI PUBS Open RAIL-M license](https://huggingface.co/datalab-to/indra-ocr/blob/ed345c7f158eddbc7dee0c6a7269afb75a94f7e8/LICENSE)
includes use restrictions, commercial restrictions and share-alike provisions.
The application code's MIT license does not replace the model license.
Third-party components retain their own licenses and notices.
