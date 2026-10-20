import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ocrModels, nativeModels, ocrTiers, DEFAULT_TIER } from './ocr-tiers.js';
import { runtimeAssetPaths } from './runtime-assets.js';

const root = import.meta.dirname;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function packageAssets(variant = 'full', native = false) {
  assert.ok(['full', 'cpu', 'lite'].includes(variant), 'Select full, cpu or lite');
  const gpuEnabled = variant === 'full';
  const selectedModels = variant === 'full' ? ['standard', 'light'] : [variant === 'lite' ? 'light' : 'standard'];
  const packs = native ? nativeModels : ocrModels;
  const modelKeys = new Set(Object.values(ocrModels).flatMap(Object.values));
  const selectedKeys = new Set(selectedModels.flatMap(name => [packs[name].cpu, packs[name].codec, ...(gpuEnabled ? [packs[name].gpu] : [])]));
  const omitted = new Set(gpuEnabled ? [] : ['gpuMjs', 'gpuWasm', 'layoutWorker', 'layoutCore', 'layoutWasm', 'preparationWorker']);
  const sources = { ortMjs: 'assets/indra-kernels/hswish/ort-wasm-simd-threaded.mjs',
    ortWasm: 'assets/indra-kernels/hswish/ort-wasm-simd-threaded.wasm',
    gpuMjs: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
    gpuWasm: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm' };
  const files = [...Object.entries(runtimeAssetPaths).filter(([key]) => !omitted.has(key) && !modelKeys.has(key)), ...[...selectedKeys].map(path => [path, path])]
    .map(([key, target]) => [key, sources[key] ?? target, target]);
  const assets = files.map(([key, source, target]) => ({ key, target, bytes: readFileSync(`${root}/${source}`) }));
  const notices = JSON.parse(readFileSync(`${root}/assets/upstream-notices.json`, 'utf8'));
  notices.pako = { url: 'https://github.com/nodeca/pako/blob/1.0.11/LICENSE',
    text: readFileSync(`${root}/node_modules/pako/LICENSE`, 'utf8') };
  const models = {};
  for (const name of selectedModels) {
    const paths = { ...packs[name] };
    if (!gpuEnabled) delete paths.gpu;
    const cpu = JSON.parse(readFileSync(`${root}/${paths.cpu.replace('model.onnx', 'source.json')}`, 'utf8'));
    const gpu = gpuEnabled && JSON.parse(readFileSync(`${root}/${nativeModels[name].gpu.replace('model.onnx', 'source.json')}`, 'utf8'));
    const capture = gpuEnabled && !native && JSON.parse(readFileSync(`${root}/${paths.gpu.replace('model.onnx', 'source.json')}`, 'utf8'));
    if (gpuEnabled) {
      assert.equal(gpu.fp16_gate_passed, true, `${name}: FP16 accuracy gate is required`);
      assert.deepEqual(JSON.parse(readFileSync(`${root}/${paths.codec}`, 'utf8')),
        JSON.parse(readFileSync(`${root}/${nativeModels[name].gpu.replace('model.onnx', 'codec.json')}`, 'utf8')), `${name}: CPU/GPU codecs differ`);
      if (capture) {
        assert.equal(capture.original_model_sha256, gpu.model_sha256);
        assert.equal(capture.checks.length, 3);
        assert.ok(capture.checks.every(check => check.logits_exact), `${name}: browser mask conversion changed logits`);
      }
    }
    for (const [kind, path] of Object.entries(paths)) {
      const metadata = kind === 'gpu' ? capture || gpu : cpu;
      assert.equal(sha256(readFileSync(`${root}/${path}`)), metadata[kind === 'codec' ? 'codec_sha256' : 'model_sha256'], `${name}: ${kind} asset changed`);
    }
    models[name] = Object.fromEntries(Object.entries(paths).map(([kind, path]) => [kind, { path, sha256: sha256(readFileSync(`${root}/${path}`)) }]));
  }
  const manifest = {
    version: JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version,
    recognizer: 'indra', input_height: 32, variant, backends: gpuEnabled ? ['wasm', 'webgpu'] : ['wasm'],
    default_tier: variant === 'lite' ? 'extreme' : DEFAULT_TIER,
    tiers: Object.fromEntries(Object.entries(ocrTiers).filter(([, tier]) => selectedModels.includes(tier.model))), models,
    detector: { path: 'assets/detectors/indra/model.onnx', sha256: sha256(assets.find(asset=>asset.key==='indraDetector').bytes) },
    model_source: { repository: 'datalab-to/indra-ocr', revision: 'ed345c7f158eddbc7dee0c6a7269afb75a94f7e8' },
    modifications: 'Indra weights fine-tuned on human legal-text transcripts with blank-margin crop augmentation, depth/channel pruned, and exported with compact CTC IDs; GPU export folds normalization, lowers HardSwish and uses FP16. Browser GPU graphs use an equivalent external mask for command replay. CPU ONNX Runtime 1.22.0 uses four-row matrix multiplication and fused HardSwish SIMD128 kernels.',
    cpu_runtime: { build: JSON.parse(readFileSync(`${root}/assets/indra-kernels/hswish/build-inputs.json`, 'utf8')) },
    assets: Object.fromEntries(assets.map(asset => [asset.target, { bytes: asset.bytes.length, sha256: sha256(asset.bytes) }])),
    notices,
  };
  assets.push({ key: 'packageNotice', target: 'assets/manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)+'\n') });
  return assets;
}
