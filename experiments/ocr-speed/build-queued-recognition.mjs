import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const owner = resolve(import.meta.dirname, '../..');
const { build } = createRequire(resolve(owner, 'package.json'))('esbuild');
const toggle = process.argv[2] === 'toggle';
const depth = toggle ? 'toggle' : Number(process.argv[2] || 2); assert.ok(toggle || [2, 4].includes(depth));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = readFileSync(resolve(owner, 'dist/legal-browser-ocr.html'), 'utf8');
const original = base.match(/globalThis\.LEGAL_OCR_ASSETS=(\{.*?\});globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=/s)[1];
const compression = base.match(/globalThis\.LEGAL_OCR_COMPRESSED_ASSETS=(\[[^;]*\]);/)[1];
const assets = JSON.parse(original), compressed = new Set(JSON.parse(compression));
const decode = key => { const bytes = Buffer.from(assets[key], 'base64'); return compressed.has(key) ? gunzipSync(bytes) : bytes; };
function replace(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Expected one source anchor: ' + before);
  return source.replace(before, () => after);
}
const built = await build({ entryPoints: [resolve(owner, 'recognition-worker.js')], bundle: true, format: 'iife', minify: true, legalComments: 'inline', write: false,
  plugins: [{name: 'queued-gpu-recognition', setup(build) {
    build.onLoad({filter: /[\\/]recognizer\.js$/}, ({path}) => {
      let contents = readFileSync(path, 'utf8');
      const anchor = '    const prepared = lines.map((line,index)=>({...line,index})), groups = new Map(), results = new Array(lines.length);';
      const condition = 'this.argmax && this.session.batch && !confidence && sortedBatches && !this.profile.gpuDirect && lines.length && lines.every(line => line.gpu)';
      const branch = toggle
        ? `    if (this.experimentalQueueDepth && ${condition}) {\n      const result = await recognizeQueued(this, lines, decodeClassIds, {batchSize, timing}, this.experimentalQueueDepth);\n      if (timing) { timing.experimental_queue_batches = timing.model_batches; timing.experimental_queue_depth_batches = timing.model_batches * this.experimentalQueueDepth; }\n      return result;\n    }`
        : `    if (${condition}) return recognizeQueued(this, lines, decodeClassIds, {batchSize, timing}, ${depth});`;
      contents = "import { recognizeQueued } from './experiments/ocr-speed/queued-recognition.js';\n" + replace(contents, anchor, `${branch}\n${anchor}`);
      return {contents, resolveDir: owner, loader: 'js'};
    });
    if (toggle) build.onLoad({filter: /[\\/]recognition-worker\.js$/}, ({path}) => {
      const contents = replace(readFileSync(path, 'utf8'), '    const timing=collectTiming?',
        '    lineRecognizer.experimentalQueueDepth = data.queueDepth || 0;\n    const timing=collectTiming?');
      return {contents: replace(contents, '{crop_pack_seconds:0,model_seconds:0,decode_seconds:0}',
        '{crop_pack_seconds:0,model_seconds:0,decode_seconds:0,experimental_queue_batches:0,experimental_queue_depth_batches:0}'), resolveDir: owner, loader: 'js'};
    });
  }}]});
const worker = Buffer.from(built.outputFiles[0].contents), notice = JSON.parse(decode('packageNotice').toString('utf8'));
notice.experimental_queued_recognition = {depth, source_sha256: hash(readFileSync(resolve(owner, 'experiments/ocr-speed/queued-recognition.js'))), worker_sha256: hash(worker)};
notice.assets['dist/recognition-worker.js'] = {bytes: worker.length, sha256: hash(worker)};
assets.recognitionWorker = gzipSync(worker, {level: 9}).toString('base64'); compressed.add('recognitionWorker');
assets.packageNotice = gzipSync(Buffer.from(JSON.stringify(notice, null, 2) + '\n'), {level: 9}).toString('base64'); compressed.add('packageNotice');
let html = base.replace('globalThis.LEGAL_OCR_ASSETS=' + original, () => 'globalThis.LEGAL_OCR_ASSETS=' + JSON.stringify(assets))
  .replace('globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + compression, () => 'globalThis.LEGAL_OCR_COMPRESSED_ASSETS=' + JSON.stringify([...compressed]));
if (toggle) {
  const app = await build({entryPoints: [resolve(owner, 'app.js')], bundle: true, format: 'esm', minify: true, legalComments: 'inline', write: false,
    plugins: [{name: 'queue-depth-per-message', setup(build) {
      build.onLoad({filter: /[\\/]recognition-pool\.js$/}, ({path}) => ({contents: replace(readFileSync(path, 'utf8'),
        "{ type: 'recognize', scale: tasks[0].scale, pages }", "{ type: 'recognize', scale: tasks[0].scale, pages, queueDepth: globalThis.legalOcrExperimentalQueueDepth || 0 }"), resolveDir: owner, loader: 'js'}));
    }}]});
  const moduleText = html.match(/const moduleUrl=URL.createObjectURL\(new Blob\(\[("(?:\\.|[^"\\])*")\],\{type:'text\/javascript'\}\)\);/)[1];
  html = replace(html, moduleText, JSON.stringify(Buffer.from(app.outputFiles[0].contents).toString('utf8').replaceAll('</script', '<\\/script')));
}
const output = resolve(owner, `dist/runtime-speed-queued-${depth}.html`);
writeFileSync(output, html);
const receipt = {origin: 'machine_test', run_id: randomUUID(), depth, base_html_sha256: hash(Buffer.from(base)),
  html_sha256: hash(Buffer.from(html)), html_bytes: Buffer.byteLength(html), implementation: notice.experimental_queued_recognition};
writeFileSync(output.replace('.html', '.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({output, bytes: receipt.html_bytes, sha256: receipt.html_sha256}));
