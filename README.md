# Legal Browser OCR

Local PNG and PDF OCR in the browser via ONNX Runtime Web and PDF.js — files never leave your device. Use the [hosted app](https://eliziff.github.io/legal-browser-ocr/) or download offline single-file builds from [Releases](https://github.com/eliziff/legal-browser-ocr/releases). Companion to [Legal PDF Parser](https://github.com/eliziff/legal-pdf-parser).

## Performance

Measured on a 55-page scanned legal PDF (warm three-pass medians; see [experiments/ocr-speed/README.md](experiments/ocr-speed/README.md)). On our broader scanned legal dev set, the default model averages **2.7% CER**.

**Desktop Chrome** (Ryzen 5 2600X / RTX 3080 Ti):

| Configuration | Pages/s | CER |
| --- | ---: | ---: |
| Balanced, WebGPU | **18.25** | **2.30%** |
| Quality, WebGPU | **14.81** | **2.01%** |
| Balanced, CPU (`ort-wasm`) | **9.48** | **2.30%** |
| Quality, CPU (`ort-wasm`) | **8.86** | **2.02%** |
| Stock Indra CPU (896px) | 6.87 | 3.37% |
| Tesseract.js 7.0.0 Fast CPU (6 workers) | 2.27 | 2.28% |

**Laptop Chrome** (i3-1315U / Intel UHD):

| Preset | CPU p/s (CER) | Compact CPU p/s (CER) | WebGPU p/s (CER) |
| --- | --- | --- | --- |
| Balanced | 3.70 (2.21%) | 5.40 (2.21%) | **7.03** (2.21%) |
| Quality | 3.94 (2.02%) | 4.98 (2.02%) | **6.68** (2.02%) |

## Packages & build

Releases include offline single-file builds (`legal-browser-ocr.html` at 22.8 MB / 16.8 MB gzip for all tiers; compact CPU at 5.39 MB / 3.71 MB gzip; compact Extreme at 3.83 MB / 2.54 MB gzip vs Tesseract.js 3.46 MB gzip), self-hosting assets (`legal-browser-ocr-runtime.tar.gz`), shared models (`legal-ocr-models.tar.gz`), and native Windows CLI (`legal-ocr-runtime-windows-x64.zip`). Embeddings can import `createBrowserOcr(assets)` from `browser-runtime.js`.

```sh
npm ci && npm test && npm run build && npm run bundle
```

Compact standalone builds: `node build-single-html.mjs cpu` or `node build-single-html.mjs lite` after `npm run build`.

## License

Application code is [MIT](LICENSE). Recognition and detection weights derive from [Indra](https://github.com/datalab-to/indra) under the [modified AI PUBS Open RAIL-M license](https://huggingface.co/datalab-to/indra-ocr/blob/ed345c7f158eddbc7dee0c6a7269afb75a94f7e8/LICENSE).
