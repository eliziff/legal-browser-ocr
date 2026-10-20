import { createLayoutPool, createRecognitionPool } from './recognition-pool.js';
import { lineRegions } from './layout-order.js';
import { positionedLines } from './text-layer.js';
import { ocrModels, ocrTier, DEFAULT_TIER } from './ocr-tiers.js';
import { runtimeDefaults, processingBackend } from './worker-policy.js';

/** Headless embedding API. Hosts supply packaged bytes/URLs; recognition choices belong here. */
export function createBrowserOcr(assets) {
  let configuration, disposed = false, idleTimer, initializationTimer, failure, layout, recognition, rejectDisposal;
  const jobs = new Set();
  const ended = new Promise((_, reject) => { rejectDisposal = reject; });
  ended.catch(() => {});
  const cancelled = () => new DOMException('Recognition cancelled', 'AbortError');
  const quiet = () => {
    clearTimeout(idleTimer);
    if (!disposed && !jobs.size) idleTimer = setTimeout(() => dispose(), 30_000);
  };
  function dispose(error = cancelled()) {
    if (disposed) return;
    disposed = true; failure = error;
    clearTimeout(idleTimer); clearTimeout(initializationTimer);
    rejectDisposal(error); layout?.dispose(error); recognition?.dispose(error);
  }
  const ready = (async () => {
    const backend = await processingBackend();
    configuration = { backend, tier: DEFAULT_TIER, ...runtimeDefaults(backend) };
    const tier = ocrTier(), pack = ocrModels[tier.model];
    const cpu = { mjs: 'ortMjs', wasm: 'ortWasm' }, gpu = { mjs: 'gpuMjs', wasm: 'gpuWasm' };
    const paths = backend === 'webgpu' ? gpu : cpu;
    const loadRuntime = async paths => ({ mjs: await assets.url(paths.mjs), wasm: await assets.url(paths.wasm) });
    const [model, codec, workerUrl, detectorUrl, detectorModel, detectorConfig, runtime, layoutRuntime, preparationUrl] = await Promise.all([
      assets.bytes(backend === 'webgpu' ? pack.gpu : pack.cpu), assets.bytes(pack.codec),
      assets.url('recognitionWorker'), assets.url('detectorWorker'), assets.url('indraDetector'), assets.url('detectorConfig'),
      loadRuntime(paths), loadRuntime(configuration.layoutBackend === 'webgpu' ? gpu : cpu),
      configuration.prepareWorker ? assets.url('preparationWorker') : undefined,
    ]);
    if (disposed) throw failure;
    layout = createLayoutPool({ workerPath: detectorUrl, modelOptions: {
      backend: 'indra', executionProvider: configuration.layoutBackend, longSide: tier.detectorSide,
      modelPath: detectorModel, configPath: detectorConfig, runtimeMjs: layoutRuntime.mjs,
      runtimeWasm: layoutRuntime.wasm, sessionOptions: configuration.sessionOptions,
    } }, configuration.layoutWorkerCount);
    const settings = { workerUrl, preparationUrl, runtime, model,
      codec: JSON.parse(new TextDecoder().decode(codec)), options: { ...configuration, recognizer: 'indra' } };
    recognition = createRecognitionPool({ ...settings, ...(backend === 'webgpu' && { fallback: async () => {
      const model = await assets.bytes(pack.cpu);
      configuration = { backend: 'wasm', tier: DEFAULT_TIER, ...runtimeDefaults('wasm') };
      return { ...settings, model, runtime: layoutRuntime, preparationUrl: undefined,
        options: { ...configuration, recognizer: 'indra' } };
    } }) });
    await recognition.ready; quiet();
  })();
  initializationTimer = setTimeout(() => dispose(new Error('The local OCR runtime did not initialize.')), 60_000);
  ready.then(() => clearTimeout(initializationTimer), error => { clearTimeout(initializationTimer); dispose(error); });

  async function wait(value, signal) {
    signal?.throwIfAborted();
    if (disposed) throw failure;
    let abort;
    try {
      return await Promise.race([value, ended, new Promise((_, reject) => {
        abort = () => reject(signal.reason ?? cancelled()); signal?.addEventListener('abort', abort, { once: true });
      })]);
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async function recognize(bitmap, signal) {
    await wait(ready, signal); clearTimeout(idleTimer);
    const lines = lineRegions(await layout.findLines(bitmap), bitmap.width, bitmap.height);
    signal?.throwIfAborted();
    if (!lines.length) return [];
    const texts = await recognition.recognize({ bitmap, lines, includeLines: true });
    signal?.throwIfAborted();
    return positionedLines(lines, texts);
  }
  return {
    get disposed() { return disposed; },
    get configuration() { return configuration; },
    async prepare(signal) { await wait(ready, signal); return configuration; },
    recognizePage(bitmap, signal) {
      if (disposed || signal?.aborted) { bitmap.close(); return Promise.reject(signal?.reason ?? failure); }
      clearTimeout(idleTimer);
      const reading = recognize(bitmap, signal).finally(() => { bitmap.close(); jobs.delete(reading); quiet(); });
      jobs.add(reading);
      return wait(reading, signal);
    },
    dispose,
  };
}
