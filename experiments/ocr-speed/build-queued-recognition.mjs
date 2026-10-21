import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const owner = resolve(import.meta.dirname, '../..');
const { build } = createRequire(resolve(owner, 'package.json'))('esbuild');
const depth = Number(process.argv[2] || 2); assert.ok([2, 4].includes(depth));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = readFileSync(resolve(owner, 'dist/legal-browser-ocr.html'), 'utf8');
const original = base.match(/globalThis\.LEGAL_OCR_ASSETS=(\{.*?\});globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=/s)[1];
const compression = base.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)[1];
const assets = JSON.parse(original), compressed = new Set(JSON.parse(compression));
const decode = key => { const bytes = Buffer.from(assets[key], 'base64'); return compressed.has(key) ? gunzipSync(bytes) : bytes; };
const built = await build({ entryPoints: [resolve(owner, 'recognition-worker.js')], bundle: true, format: 'iife', minify: true, legalComments: 'inline', write: false,
  plugins: [{name: 'queued-gpu-recognition', setup(build) {
    build.onLoad({filter: /[\\/]recognizer\.js$/}, ({path}) => {
      let contents = readFileSync(path, 'utf8');
      const anchor = '    const prepared = lines.map((line,index)=>({...line,index})), groups = new Map(), results = new Array(lines.length);';
      assert.equal(contents.split(anchor).length, 2);
      contents = "import { recognizeQueued } from './experiments/ocr-speed/queued-recognition.js';\n" + contents.replace(anchor,
        () => `    if (this.argmax && this.session.batch && !confidence && sortedBatches && !this.profile.gpuDirect && lines.length && lines.every(line => line.gpu)) return recognizeQueued(this, lines, decodeClassIds, {batchSize, timing}, ${depth});\n${anchor}`);
      return {contents, resolveDir: owner, loader: 'js'};
    });
  }}]});
const worker = Buffer.from(built.outputFiles[0].contents), notice = JSON.parse(decode('packageNotice').toString('utf8'));
notice.experimental_queued_recognition = {depth, source_sha256: hash(readFileSync(resolve(owner, 'experiments/ocr-speed/queued-recognition.js'))), worker_sha256: hash(worker)};
notice.assets['dist/recognition-worker.js'] = {bytes: worker.length, sha256: hash(worker)};
assets.recognitionWorker = gzipSync(worker, {level: 9}).toString('base64'); compressed.add('recognitionWorker');
assets.packageNotice = gzipSync(Buffer.from(JSON.stringify(notice, null, 2) + '\n'), {level: 9}).toString('base64'); compressed.add('packageNotice');
const html = base.replace('globalThis.LEGAL_OCR_ASSETS=' + original, () => 'globalThis.LEGAL_OCR_ASSETS=' + JSON.stringify(assets))
  .replace('globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + compression, () => 'globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + JSON.stringify([...compressed]));
const output = resolve(owner, `dist/runtime-speed-queued-${depth}.html`);
writeFileSync(output, html);
const receipt = {origin: 'machine_test', run_id: randomUUID(), depth, base_html_sha256: hash(Buffer.from(base)),
  html_sha256: hash(Buffer.from(html)), html_bytes: Buffer.byteLength(html), implementation: notice.experimental_queued_recognition};
writeFileSync(output.replace('.html', '.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({output, bytes: receipt.html_bytes, sha256: receipt.html_sha256}));
