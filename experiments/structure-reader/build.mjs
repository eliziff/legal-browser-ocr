import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const result = spawnSync('cargo', ['build', '--manifest-path', 'experiments/structure-reader/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release', '--locked'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status) process.exit(result.status);
const worker = await build({ entryPoints: [fileURLToPath(new URL('worker.js', import.meta.url))], bundle: true, format: 'iife', write: false, minify: true });
await build({ absWorkingDir: fileURLToPath(root), entryPoints: ['experiments/structure-reader/reader.js'], bundle: true, format: 'esm', minify: true, loader: { '.css': 'text' }, outfile: 'dist/structure-reader.js' });
const assets = { worker: worker.outputFiles[0].text, wasm: readFileSync(new URL('target/wasm32-unknown-unknown/release/browser_structure.wasm', import.meta.url)).toString('base64') };
const source = readFileSync(new URL('dist/legal-browser-ocr.html', root), 'utf8');
const app = readFileSync(new URL('dist/structure-reader.js', root), 'utf8').replaceAll('</script', '<\\/script');
const html = source.replace(/<script type="module">[\s\S]*?<\/script>/, () => `<script>globalThis.LEGAL_STRUCTURE_ASSETS=${JSON.stringify(assets)}</script><script type="module">${app}</script>`);
writeFileSync(new URL('dist/legal-browser-ocr-structure.html', root), html);
console.log('dist/legal-browser-ocr-structure.html');
