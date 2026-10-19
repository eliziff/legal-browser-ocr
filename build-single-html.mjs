import { readFileSync, writeFileSync } from 'node:fs';
import { packageAssets } from './package-assets.mjs';

const root = import.meta.dirname;
if (process.argv.length > 2) throw new Error('The release packages all five Indra tiers; no model flags are required.');
const assets = Object.fromEntries(packageAssets().map(asset=>[asset.key, asset.bytes.toString('base64')]));
const app = readFileSync(`${root}/dist/app.js`, 'utf8').replaceAll('</script', '<\\/script');
const bootstrap = `<script>globalThis.LEGAL_OCR_ASSETS=${JSON.stringify(assets)};globalThis.LEGAL_OCR_ASSETS.ortThreadedMjs=globalThis.LEGAL_OCR_ASSETS.ortMjs;globalThis.LEGAL_OCR_ASSETS.ortThreadedWasm=globalThis.LEGAL_OCR_ASSETS.ortWasm</script><script type="module">${app}</script>`;
const html = readFileSync(`${root}/index.html`, 'utf8').replace('<script type="module" src="./dist/app.js"></script>', ()=>bootstrap);
const output = `${root}/dist/legal-browser-ocr.html`;
writeFileSync(output, html);
process.stdout.write(output+'\n');
