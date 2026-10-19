import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ocrModels, ocrTiers } from './ocr-tiers.js';

const root = import.meta.dirname;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function packageAssets() {
  const files = [
    ['ortMjs', 'assets/indra-kernels/sgemm/ort-wasm-simd-threaded.mjs', 'dist/ort-wasm-simd-threaded.mjs'],
    ['ortWasm', 'assets/indra-kernels/sgemm/ort-wasm-simd-threaded.wasm', 'dist/ort-wasm-simd-threaded.wasm'],
    ['gpuMjs', 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', 'dist/ort-wasm-simd-threaded.jsep.mjs'],
    ['gpuWasm', 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', 'dist/ort-wasm-simd-threaded.jsep.wasm'],
    ['pdfWorker', 'dist/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs'],
    ['recognitionWorker', 'dist/recognition-worker.js', 'dist/recognition-worker.js'],
    ['detectorWorker', 'dist/detector-worker.js', 'dist/detector-worker.js'],
    ['layoutWorker', 'tesseract-layout-worker.js', 'tesseract-layout-worker.js'],
    ['layoutCore', 'assets/layout-core.mjs', 'assets/layout-core.mjs'],
    ['layoutWasm', 'assets/layout-core.wasm', 'assets/layout-core.wasm'],
    ['detectorConfig', 'assets/detectors/config.json', 'assets/detectors/config.json'],
    ['indraDetector', 'assets/detectors/indra/model.onnx', 'assets/detectors/indra/model.onnx'],
  ];
  for (const model of Object.values(ocrModels)) for (const path of Object.values(model)) files.push([path, path, path]);
  const assets = files.map(([key, source, target]) => ({ key, target, bytes: readFileSync(`${root}/${source}`) }));
  const notices = JSON.parse(readFileSync(`${root}/assets/upstream-notices.json`, 'utf8'));
  const models = {};
  for (const [name, paths] of Object.entries(ocrModels)) {
    const cpu = JSON.parse(readFileSync(`${root}/${paths.cpu.replace('model.onnx', 'source.json')}`, 'utf8'));
    const gpu = JSON.parse(readFileSync(`${root}/${paths.gpu.replace('model.onnx', 'source.json')}`, 'utf8'));
    assert.equal(gpu.fp16_gate_passed, true, `${name}: FP16 accuracy gate is required`);
    assert.deepEqual(JSON.parse(readFileSync(`${root}/${paths.codec}`, 'utf8')),
      JSON.parse(readFileSync(`${root}/${paths.gpu.replace('model.onnx', 'codec.json')}`, 'utf8')), `${name}: CPU/GPU codecs differ`);
    for (const [kind, path] of Object.entries(paths)) {
      const metadata = kind === 'gpu' ? gpu : cpu;
      assert.equal(sha256(readFileSync(`${root}/${path}`)), metadata[kind === 'codec' ? 'codec_sha256' : 'model_sha256'], `${name}: ${kind} asset changed`);
    }
    models[name] = Object.fromEntries(Object.entries(paths).map(([kind, path]) => [kind, { path, sha256: sha256(readFileSync(`${root}/${path}`)) }]));
  }
  const manifest = {
    version: JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version,
    recognizer: 'indra', input_height: 32, default_tier: 'balanced', tiers: ocrTiers, models,
    detector: { path: 'assets/detectors/indra/model.onnx', sha256: sha256(assets.find(asset=>asset.key==='indraDetector').bytes) },
    model_source: { repository: 'datalab-to/indra-ocr', revision: 'ed345c7f158eddbc7dee0c6a7269afb75a94f7e8' },
    modifications: 'Indra weights fine-tuned on legal text, depth/channel pruned, and exported with compact CTC IDs; GPU export folds normalization, lowers HardSwish and uses FP16. CPU ONNX Runtime 1.22.0 uses the custom four-row SIMD kernel.',
    assets: Object.fromEntries(assets.map(asset => [asset.target, { bytes: asset.bytes.length, sha256: sha256(asset.bytes) }])),
    notices,
  };
  assets.push({ key: 'packageNotice', target: 'assets/manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)+'\n') });
  return assets;
}
