# Legal Browser OCR

Local PNG/PDF recognition using WebAssembly and ONNX Runtime Web, with crop
selection, whole-document recognition and searchable PDF export. It is the browser
companion to [Legal PDF Parser](https://github.com/eliziff/legal-pdf-parser). Input files and recognized text are processed on
the device.

## Use

Open the [hosted application](https://eliziff.github.io/legal-browser-ocr/) or use
an application package from [Releases](https://github.com/eliziff/legal-browser-ocr/releases):

| Package | Use |
| --- | --- |
| `legal-browser-ocr-runtime.tar.gz` | Serve with cross-origin isolation headers for multithreaded WebAssembly |
| `legal-browser-ocr.html` | Self-contained application; single-threaded when opened directly from disk |

Load a file, optionally select a crop, then choose **Recognize document**. When
all pages succeed, **Download searchable PDF** adds an invisible text layer to the
original PDF pages. PNG input is embedded on a new PDF page. Export does not replace
PDF pages with screenshots or require an external service.

Crops limit recognition, not exported page content. The export retains rotation
and crop-box offsets. Text is fitted to detected line bounds with estimated
character spacing; it is not word-accurate alignment or an OCR correction tool.
Changing the file or crop invalidates the previous result. Each export starts
from the original input, so repeat recognition does not accumulate new layers.
Existing PDF text is preserved: already-searchable inputs can produce duplicate
extracted text. Review recognition before relying on it.

## Develop and package

From this repository's root, with Node.js/npm installed:

```sh
npm ci
npm test
npm run build
```

`build` compiles JavaScript and copies the required dependency workers/WASM into
`dist/`; it does not supply the recognition models or a complete runnable release.
The source repository intentionally excludes licensed model, codec and layout
assets. Supply those under `assets/` and have `tar` available before packaging:

```sh
npm run runtime  # complete runtime directory and .tar.gz under dist/
npm run bundle   # runtime plus self-contained HTML under dist/
```

[package.json](package.json), [build-runtime.mjs](build-runtime.mjs) and
[build-single-html.mjs](build-single-html.mjs) define the build. Tests cover layout,
preprocessing, text geometry and PDF export; they do not certify OCR accuracy on
a new corpus.

An optional [structure reader experiment](experiments/structure-reader/README.md)
adds local section detection and a Contents sidebar to the searchable PDF.
It builds a separate HTML package.

## Recorded performance

The existing Chromium/Core i3-1315U measurement used the same 153 scanned legal
pages as the [native parser benchmark](https://github.com/eliziff/legal-pdf-parser/tree/main/experiments/kraken-lite/cpu-benchmark).
These are warmed sustained passes, including line finding, recognition and text
assembly—not cold-load or export timings. Lower character error rate is better.

| Profile | Pages/second | Character error rate |
| --- | ---: | ---: |
| Legal OCR Quality | 1.55 | 2.58% |
| Legal OCR Turbo | 1.79 | 3.16% |
| Tesseract.js Fast, four workers | 1.01 | 4.11% |
| Tesseract.js Quality, four workers | 0.73 | 4.16% |

## Credits and license

Recognition uses a legal-domain fine-tune of
[CATMuS Print Small](https://zenodo.org/records/10602357), trained with
[Kraken](https://kraken.re/) and the [CATMuS project](https://huggingface.co/CATMuS).
The runtime uses ONNX Runtime Web and PDF.js; pdf-lib writes the searchable PDF
with glyphless Type 3 fonts and Unicode maps, without an extra font download.

[MIT](LICENSE). Third-party components and model assets retain their own licenses
and notices.
