import { ocrModels, ocrTier } from './ocr-tiers.js';

/** Canonical packaged paths, shared by the app's release and embedding hosts. */
export const runtimeAssetPaths = Object.freeze({
  ortMjs: 'dist/ort-wasm-simd-threaded.mjs', ortWasm: 'dist/ort-wasm-simd-threaded.wasm',
  gpuMjs: 'dist/ort-wasm-simd-threaded.jsep.mjs', gpuWasm: 'dist/ort-wasm-simd-threaded.jsep.wasm',
  pdfWorker: 'dist/pdf.worker.min.mjs', recognitionWorker: 'dist/recognition-worker.js',
  preparationWorker: 'dist/preparation-worker.js', detectorWorker: 'dist/detector-worker.js',
  layoutWorker: 'tesseract-layout-worker.js', layoutCore: 'assets/layout-core.mjs', layoutWasm: 'assets/layout-core.wasm',
  detectorConfig: 'assets/detectors/config.json', indraDetector: 'assets/detectors/indra/model.onnx',
  ...Object.fromEntries(Object.values(ocrModels).flatMap(model => Object.values(model).map(path => [path, path]))),
});

/** Assets required by the embedding API's default recognition path. */
export const embeddingAssetPaths = Object.freeze(Object.fromEntries([
  'ortMjs', 'ortWasm', 'gpuMjs', 'gpuWasm', 'recognitionWorker', 'preparationWorker',
  'detectorWorker', 'detectorConfig', 'indraDetector', ...Object.values(ocrModels[ocrTier().model]),
].map(name => [name, runtimeAssetPaths[name]])));
