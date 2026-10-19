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
| `legal-browser-ocr.html` | Open the self-contained application, including offline |
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

The v0.2.0 comparison below was measured on a **Ryzen 5 2600X desktop**,
using full Chromium 151 and CPU
WebAssembly. Every row uses the same **55-page PDF**, rendered by PDF.js at
144 dpi, and the same human gold transcripts: 145,475 normalized characters.
Figures are medians of three warm whole-document passes, including rendering,
line detection, recognition and text assembly. Startup, the initial input view
and PDF export are excluded; document thumbnails are disabled.

| Configuration | Pages/s | Character error rate |
| --- | ---: | ---: |
| **Our Indra Balanced** | **7.40** | **2.601%** |
| **Our Indra Quality** | **7.00** | **2.246%** |
| Stock Indra recognizer | 6.87 | 3.368% |
| Tesseract.js Fast | 2.27 | 2.281% |

Quality is about **3.1 times faster than Tesseract.js Fast** on these pages, with
a slightly lower character error rate. Balanced is about **3.3 times faster**,
with a higher error rate.

Our profiles use the eight-block fine-tuned recognizer: 896px line detection for
Balanced and 1024px for Quality. The stock row uses the untouched pretrained
Indra recognizer in the same browser pipeline at 896px; it measures the pretrained
weights, not the upstream Python application's complete pipeline. Indra uses six
recognition workers and four detector workers. Tesseract.js 7.0.0 uses six persistent
workers, the official Fast English data, SIMD LSTM, automatic page segmentation,
and text/line output.

These are full-page results on an already examined legal-document partition,
not a fresh holdout or a guarantee for other documents or computers. The small
CER difference between Quality and Tesseract is 52 character edits. Human gold
transcripts determine CER; the existing training line boxes came from automatic
segmentation and are not hand-corrected geometry gold.

The benchmark harness and retained aggregate findings are described in the
[speed experiment guide](experiments/ocr-speed/README.md). GPU component timings
are separate from this CPU table.

On an **i3-1315U laptop with Intel UHD Graphics**, the updated Balanced runtime
measured **3.89 pages/s on CPU** and **5.04 pages/s with automatic WebGPU**, at
**2.513%** and **2.512% CER**. These use the same 55-page PDF and three warm
whole-document passes. The original recognition worker measured 1.28 pages/s
in a separate quiet CPU control. The first GPU document recognition took
13.67 seconds, with 2.66 seconds of model initialization measured separately;
input opening and PDF export are excluded. All 55 exported text pages and the
original first-page pixels passed verification.

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
