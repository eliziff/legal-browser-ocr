import { readFileSync, writeFileSync } from 'node:fs';
import { packageAssets } from './package-assets.mjs';
import { gzipSync } from 'node:zlib';

const root = import.meta.dirname;
const variant = process.argv[2] || 'full';
if (process.argv.length > 3) throw new Error('Select full, cpu or lite');
const entries = packageAssets(variant);
const manifest = JSON.parse(entries.find(asset => asset.key === 'packageNotice').bytes);
const compressed = [];
const assets = Object.fromEntries(entries.map(asset => {
  const gzip = gzipSync(asset.bytes, { level: 9 }), useGzip = gzip.length < asset.bytes.length;
  if (useGzip) compressed.push(asset.key);
  return [asset.key, (useGzip ? gzip : asset.bytes).toString('base64')];
}));
for (const name of ['Mjs', 'Wasm']) if (compressed.includes('ort' + name)) compressed.push('ortThreaded' + name);
const app = readFileSync(`${root}/dist/app.js`, 'utf8').replaceAll('</script', '<\\/script');
// A blob module also avoids ORT 1.22's invalid file-origin URL base in Firefox.
const bootstrap = `<script>globalThis.LEGAL_OCR_ASSETS=${JSON.stringify(assets)};globalThis.LEGAL_OCR_COMPRESSED_ASSETS=${JSON.stringify(compressed)};globalThis.LEGAL_OCR_PACKAGE=${JSON.stringify({defaultTier: manifest.default_tier, backends: manifest.backends, models: Object.keys(manifest.models)})};globalThis.LEGAL_OCR_ASSETS.ortThreadedMjs=globalThis.LEGAL_OCR_ASSETS.ortMjs;globalThis.LEGAL_OCR_ASSETS.ortThreadedWasm=globalThis.LEGAL_OCR_ASSETS.ortWasm</script><script type="module">const moduleUrl=URL.createObjectURL(new Blob([${JSON.stringify(app)}],{type:'text/javascript'}));addEventListener('pagehide',event=>{if(!event.persisted)URL.revokeObjectURL(moduleUrl)});try{await import(moduleUrl)}catch(error){document.getElementById('status').textContent='Model failed to load: '+error.message}</script>`;
const html = readFileSync(`${root}/index.html`, 'utf8').replace('<script type="module" src="./dist/app.js"></script>', ()=>bootstrap);
const output = `${root}/dist/legal-browser-ocr${variant === 'full' ? '' : '-' + variant}.html`;
writeFileSync(output, html);
process.stdout.write(output+'\n');
