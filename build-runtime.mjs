import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = import.meta.dirname;
const output = `${root}/dist/legal-browser-ocr-runtime`;
const archive = `${root}/dist/legal-browser-ocr-runtime.tar.gz`;

rmSync(output, { recursive: true, force: true });
rmSync(archive, { force: true });
mkdirSync(`${output}/dist`, { recursive: true });
for (const name of ['index.html', 'tesseract-layout-worker.js']) {
  cpSync(`${root}/${name}`, `${output}/${name}`);
}
cpSync(`${root}/assets`, `${output}/assets`, { recursive: true });
for (const name of [
  'app.js',
  'recognition-worker.js',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'pdf.worker.min.mjs',
]) {
  cpSync(`${root}/dist/${name}`, `${output}/dist/${name}`);
}
const result = spawnSync('tar', [
  '-czf', archive, '-C', output, '.',
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status) process.exit(result.status);
process.stdout.write(`${archive}\n`);
