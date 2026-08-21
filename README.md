# Legal Browser OCR

Fast legal OCR that runs entirely in the browser.

Legal Browser OCR reads PNGs and PDFs locally with WebAssembly and ONNX
Runtime Web. Files, page images, and recognized text never need to leave the
device. It includes interactive crop selection, whole-document recognition,
four speed/accuracy profiles, and a self-contained HTML release. It is the
in-browser companion to [Legal PDF Parser](https://github.com/eliziff/legal-pdf-parser).

## Performance

Measured in Chromium on a Core i3-1315U laptop using the same 153-page legal
print benchmark as [Legal PDF Parser](https://github.com/eliziff/legal-pdf-parser).
Lower character error rate (CER) is better.

| Engine and profile | Throughput | CER |
| --- | ---: | ---: |
| Legal OCR — Quality | 1.55 pages/s | 2.58% |
| Legal OCR — Turbo | 1.79 pages/s | 3.16% |
| Tesseract.js — Fast, 4 workers | 1.01 pages/s | 4.11% |
| Tesseract.js — Quality, 4 workers | 0.73 pages/s | 4.16% |

Each row is a warmed, sustained pass over the same 153 pages. The figures
include line finding, recognition, and text assembly.

## Use

Download `legal-browser-ocr.html` from the latest release and open it in a
current Chromium-based browser. For multithreaded WebAssembly, serve it with
cross-origin isolation headers; it also runs single-threaded from a local file.

## Build

```powershell
npm ci
npm test
npm run build
```

The Git repository contains source only. Model, codec, layout-runtime, build,
and benchmark artifacts are intentionally untracked. To build the self-contained
HTML, place the licensed runtime assets under `assets/` and run `npm run bundle`.

## Credits

The recognition model is a legal-domain fine-tune of
[CATMuS Print Small](https://zenodo.org/records/10602357), trained with the
[Kraken](https://kraken.re/) OCR ecosystem and the work of the
[CATMuS project](https://huggingface.co/CATMuS). The browser runtime uses
[ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) and
[PDF.js](https://mozilla.github.io/pdf.js/).

## License

MIT. Third-party components and model assets retain their own licenses and
notices.
