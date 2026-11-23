# Legal Browser OCR

Local PNG/PDF recognition in the browser with Indra, ONNX Runtime Web, and PDF.js. Files
and recognized text stay on the device. Companion to
[Legal PDF Parser](https://github.com/eliziff/legal-pdf-parser).

## Use

Open the [hosted app](https://eliziff.github.io/legal-browser-ocr/) or download a build
from [Releases](https://github.com/eliziff/legal-browser-ocr/releases):

| Package | Use |
| --- | --- |
| `legal-browser-ocr-runtime.tar.gz` | Runtime assets for self-hosting |
| `legal-browser-ocr.html` | Self-contained CPU/WebGPU single-file HTML (works offline) |
| `legal-browser-ocr-gpu-queued.html` | Optional two-batch queued WebGPU edition |
| `legal-browser-ocr-cpu-compact.html` | Compact CPU edition (`Quality` through `Turbo`) |
| `legal-browser-ocr-extreme-compact.html` | Smallest CPU edition (`Extreme` only) |
| `legal-ocr-models.tar.gz` | Shared models, tier manifest, and checksums for native readers |
| `legal-ocr-runtime-windows-x64.zip` | Native `legalocr` binary with CPU/DirectML runtimes |

Select a PNG or PDF, choose a tier (`Balanced` default; `Quality`, `Fast`, and `Turbo`
vary detector resolution; `Extreme` swaps in a smaller recognizer with higher error), and
click **Recognize document**.

Browsers auto-select WebGPU (FP16) when available and fall back to CPU WebAssembly; force
either via `?backend=cpu` or `?backend=webgpu`. **Download searchable PDF** overlays an
invisible text stream fitted to detected line bounds onto the original pages.

Embedding hosts import `createBrowserOcr(assets)` from `browser-runtime.js` (providing
`assets.bytes(name)` and `assets.url(name)`), which exposes `prepare(signal)`,
`recognizePage(bitmap, signal)`, and `dispose()`.

Browser builds currently run inference through ONNX Runtime Web (`ort-wasm` / WebGPU);
the companion `wasm32 +simd128` `IndraNative` engine compiles cleanly in `legal-pdf-ocr`
and is ready to wire into the browser worker path.

## Recorded performance

Dev recognition accuracy (`wise_a075`, WiSE-FT α=0.75 blend over stock Indra with the
full 1,732-token charset): **2.69% CER**, **5.49% WER** (**1.39×** faster on CPU via
native `IndraNative` at `8.24` vs `11.42 ms/line` ORT, `width=320`).

Scanned PDF throughput baseline (55-page image-only legal PDF, 145,475 normalized
characters, 144 dpi PDF.js render, warm three-pass medians excluding startup and PDF
export; see [experiments/ocr-speed/README.md](experiments/ocr-speed/README.md)):

| Desktop Chrome 151 (Ryzen 5 2600X / RTX 3080 Ti) | Pages/s | Character error rate |
| --- | ---: | ---: |
| Balanced, WebGPU | **18.25** | **2.302%** |
| Quality, WebGPU | **14.81** | **2.011%** |
| Balanced, CPU (`ort-wasm`) | **9.48** | **2.296%** |
| Quality, CPU (`ort-wasm`) | **8.86** | **2.015%** |
| Stock Indra recognizer (CPU, 896px) | 6.87 | 3.368% |
| Tesseract.js 7.0.0 Fast (CPU, 6 workers) | 2.27 | 2.281% |

| Laptop Chrome 149 (i3-1315U / Intel UHD) | CPU p/s (CER) | Compact CPU p/s (CER) | WebGPU p/s (CER) |
| --- | --- | --- | --- |
| Balanced | 3.70 (2.211%) | 5.40 (2.209%) | **7.03** (2.213%) |
| Quality | 3.94 (2.018%) | 4.98 (2.022%) | **6.68** (2.022%) |

## Develop and package

```sh
npm ci
npm test
npm run build
npm run bundle
```

Packaging reads local licensed model/detector assets from `assets/` and outputs to
`dist/`. Build compact CPU editions with `node build-single-html.mjs cpu` or
`node build-single-html.mjs lite` after `npm run build`.

| Standalone edition | Offline HTML | Gzip transfer | Included tiers |
| --- | ---: | ---: | --- |
| Full CPU/WebGPU | 22.84 MB | 16.84 MB | All five |
| Compact CPU | **5.39 MB** | **3.71 MB** | Quality through Turbo |
| Compact CPU Extreme | **3.83 MB** | **2.54 MB** | Extreme |

For comparison, Tesseract.js 7.0.0 SIMD-LSTM + Fast English data is 3.46 MB gzip
without PDF UI.

## Credits and license

Recognition and line detection derive from [Indra](https://github.com/datalab-to/indra)
and [datalab-to/indra-ocr](https://huggingface.co/datalab-to/indra-ocr), using
fine-tuned/pruned weights. ONNX Runtime Web runs inference; PDF.js renders input;
pdf-lib writes searchable PDFs.

Application code is [MIT](LICENSE). **Indra model weights are subject to the upstream
[modified AI PUBS Open RAIL-M license](https://huggingface.co/datalab-to/indra-ocr/blob/ed345c7f158eddbc7dee0c6a7269afb75a94f7e8/LICENSE)**
(including use, commercial, and share-alike restrictions). Third-party components retain
their own licenses and notices.
