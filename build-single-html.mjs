import { readFileSync, writeFileSync } from 'node:fs';

const root = import.meta.dirname;
const base64 = path => readFileSync(`${root}/${path}`).toString('base64');
const assets = {
  codec: base64('assets/codec.json'),
  model: base64('assets/model.ort'),
  ortMjs: base64('assets/ort.mjs'),
  ortWasm: base64('assets/ort.wasm'),
  ortThreadedMjs: base64('assets/ort.mjs'),
  ortThreadedWasm: base64('assets/ort.wasm'),
  pdfWorker: base64('dist/pdf.worker.min.mjs'),
  recognitionWorker: base64('dist/recognition-worker.js'),
  layoutWorker: base64('tesseract-layout-worker.js'),
  layoutCore: base64('assets/layout-core.mjs'),
  layoutWasm: base64('assets/layout-core.wasm'),
};

const app = readFileSync(`${root}/dist/app.js`, 'utf8').replaceAll('</script', '<\\/script');
const bootstrap = `<script>globalThis.LEGAL_OCR_ASSETS=${JSON.stringify(assets)}</script><script type="module">${app}</script>`;
const html = readFileSync(`${root}/index.html`, 'utf8').replace('<script type="module" src="./dist/app.js"></script>', () => bootstrap);
const output = `${root}/dist/legal-browser-ocr.html`;
writeFileSync(output, html);
process.stdout.write(`${output}\n`);
