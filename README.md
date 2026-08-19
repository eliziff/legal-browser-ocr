# Legal OCR Browser

Fast legal OCR that runs entirely in the browser.

Legal OCR Browser reads PNGs and PDFs locally with WebAssembly and ONNX
Runtime Web. Files, page images, and recognized text never need to leave the
device. It includes interactive crop selection, whole-document recognition,
four speed/accuracy profiles, and a self-contained HTML release.

## Performance

Measured in Chromium on a Core i3-1315U laptop using the same 153-page legal
print benchmark as Legal PDF Parser. Lower character error rate (CER) is
better.

| Engine and profile | Browser throughput | CER | Gate |
| --- | ---: | ---: | ---: |
| Legal OCR — Quality | 1.55 pages/s | 2.58% | 153 pages |
| Legal OCR — Turbo | 1.79 pages/s | 3.16% | 153 pages |
| Tesseract.js Fast — 4 workers | 0.79 pages/s | 9.41% | 12 pages |

These figures measure warmed in-browser OCR after the model is loaded. They
include line finding, recognition, and text assembly. They are not presented as
server or native-runtime figures. The shorter warmed gates reached 1.96 pages/s
in Quality and 2.44 pages/s in the fastest profile; the Legal OCR rows above use
the more conservative sustained run. The Tesseract.js result uses four persistent
workers and is not extrapolated from a single-worker measurement.

## Use

Download `legal-ocr-browser.html` from the latest release and open it in a
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
