import { takeRecognitionBatch } from './worker-policy.js';
import { TesseractLayout } from './tesseract-layout.js';

export function createLayoutPool(options, count) {
  const workers = Array.from({ length: count }, () => new TesseractLayout(options)), idle = [...workers], queue = [];
  let stopped;
  function pump() {
    while (idle.length && queue.length) {
      const worker = idle.pop(), task = queue.shift();
      worker.findLines(task.canvas, task.timing).then(task.resolve, task.reject).finally(() => { idle.push(worker); pump(); });
    }
  }
  return {
    findLines(canvas, timing) {
      if (stopped) return Promise.reject(stopped);
      return new Promise((resolve, reject) => { queue.push({ canvas, timing, resolve, reject }); pump(); });
    },
    dispose(error = new DOMException('Layout cancelled', 'AbortError')) {
      stopped = error; for (const worker of workers) worker.terminate();
      for (const task of queue.splice(0)) task.reject(error);
    },
  };
}

/** The app and embedding hosts use the same preparation, batching and worker lifecycle. */
export function createRecognitionPool({ fallback, ...settings }) {
  if (!fallback) return createWorkerPool(settings);
  let pool = createWorkerPool(settings), configuration = settings.options, recovery, stopped, rejectDisposal;
  const ended = new Promise((_, reject) => { rejectDisposal = reject; });
  ended.catch(() => {});
  function recover(cause) {
    if (stopped || cause.name === 'AbortError') return Promise.reject(stopped || cause);
    if (!recovery) {
      pool.dispose(cause);
      recovery = Promise.race([ended, Promise.resolve().then(fallback).then(cpu => {
        if (stopped) throw stopped;
        configuration = cpu.options; pool = createWorkerPool(cpu);
        return pool.ready;
      })]);
    }
    return recovery;
  }
  const ready = pool.ready.catch(recover);
  ready.catch(() => {});
  return {
    ready,
    get configuration() { return configuration; },
    get error() { return stopped || pool.error; },
    pump() { pool.pump(); },
    dispose(cause = new DOMException('Recognition cancelled', 'AbortError')) {
      if (stopped) return;
      stopped = cause; rejectDisposal(cause); pool.dispose(cause);
    },
    async recognize(task) {
      let bitmap = task.bitmap;
      try {
        await Promise.race([ready, ended]);
        if (stopped) throw stopped;
        if (configuration.backend === 'webgpu') {
          const active = pool, input = task.replay ? bitmap : await createImageBitmap(bitmap);
          if (stopped) { input.close(); throw stopped; }
          try { return await active.recognize({ ...task, bitmap: input }); }
          catch (cause) { await recover(cause); if (task.replay) bitmap = await task.replay(); }
        }
        // GPU batches may be incomplete after a failure; CPU retries queue independently.
        return await pool.recognize({ ...task, bitmap, batch: undefined });
      } finally { task.bitmap?.close(); }
    },
  };
}

function createWorkerPool({ workerUrl, preparationUrl, runtime, model, codec, options }) {
  const { workerPoolSize, pageBatch, batchSize, bucketSize, sortedBatches, sessionOptions,
    backend, recognizer, widthMultiple, workerThreads, gpuArgMax, captureMode, captureEnabled, gpuCacheShapes, gpuPrep, gpuDirect, collectTimings } = options;
  const slots = [], idle = [], queue = [], prepared = new Map();
  let preparation, nextId = 0, flush, error;
  function dispose(cause = new DOMException('Recognition cancelled', 'AbortError')) {
    if (error) return;
    error = cause; clearTimeout(flush);
    for (const slot of slots) {
      slot.worker.terminate(); slot.rejectReady(cause);
      for (const task of slot.tasks ?? []) task.reject(cause);
    }
    preparation?.terminate();
    for (const task of prepared.values()) task.reject(cause);
    prepared.clear();
    for (const task of queue.splice(0)) { task.bitmap?.close(); task.reject(cause); }
  }
  function pump() {
    if (error || flush && queue.length < pageBatch && !queue[0]?.batch) return;
    while (idle.length && queue.length) {
      const tasks = takeRecognitionBatch(queue, pageBatch);
      if (!tasks.length) return;
      const slot = idle.pop(); slot.tasks = tasks;
      const pages = tasks.map(task => ({ bitmap: task.bitmap, prepared: task.prepared, lines: task.lines }));
      const transfers = tasks.flatMap(task => task.prepared ? task.prepared.map(line => line.gray.buffer) : [task.bitmap]);
      try { slot.worker.postMessage({ type: 'recognize', scale: tasks[0].scale, pages }, transfers); }
      catch (cause) { dispose(cause); }
    }
  }
  const ready = Promise.all([
    ...Array.from({ length: workerPoolSize }, () => new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl), slot = { worker, tasks: null, rejectReady: reject }; slots.push(slot);
      worker.onmessage = ({ data }) => {
        if (data.type === 'fatal') { dispose(new Error(data.message)); return; }
        if (data.type === 'ready') { idle.push(slot); resolve(); pump(); return; }
        const tasks = slot.tasks; slot.tasks = null;
        if (data.type === 'error') {
          if (!tasks) { reject(new Error(data.message)); return; }
          for (const task of tasks) task.reject(new Error(data.message));
        } else if (tasks) {
          const count = tasks.reduce((sum, task) => sum + task.lines.length, 0);
          tasks.forEach((task, index) => {
            if (task.timing && data.timing) {
              const fraction = count ? task.lines.length / count : 1 / tasks.length;
              for (const [key, value] of Object.entries(data.timing)) task.timing[key] = (task.timing[key] || 0) + value * fraction;
              task.timing.recognition_batch_pages = tasks.length;
            }
            task.resolve(task.includeLines ? data.pages[index].lines : data.pages[index].text);
          });
        }
        idle.push(slot); pump();
      };
      worker.onerror = event => dispose(new Error(event.message || 'Recognition worker failed'));
      const copy = model.slice();
      worker.postMessage({ type: 'init', backend, captureMode, captureEnabled, gpuCacheShapes, gpuPrep, gpuDirect, workerThreads, runtimeMjs: runtime.mjs,
        runtimeWasm: runtime.wasm, model: copy, codec, recognizer, widthMultiple, gpuArgMax, timing: collectTimings,
        batchSize, bucketSize, sortedBatches, sessionOptions }, [copy.buffer]);
    })),
    ...(preparationUrl ? [new Promise((resolve, reject) => {
      preparation = new Worker(preparationUrl); prepared.set(0, { reject });
      preparation.onmessage = ({ data }) => {
        if (data.type === 'ready') { prepared.delete(0); resolve(); return; }
        const task = prepared.get(data.id); prepared.delete(data.id);
        if (!task) return;
        if (data.error) task.reject(new Error(data.error));
        else { if (task.timing && data.timing) Object.assign(task.timing, data.timing); task.resolve(data.prepared); }
      };
      preparation.onerror = event => dispose(new Error(event.message || 'Crop preparation worker failed'));
      preparation.postMessage({ type: 'init', timing: collectTimings });
    })] : []),
  ]);
  ready.catch(dispose);
  return {
    ready, pump, dispose,
    get error() { return error; },
    async recognize({ bitmap, lines, scale = 1, includeLines = false, timing, batch }) {
      let crops;
      try {
        await ready; if (error) throw error;
        if (preparation) {
          const id = ++nextId, source = bitmap; bitmap = undefined;
          crops = await new Promise((resolve, reject) => {
            prepared.set(id, { resolve, reject, timing });
            try { preparation.postMessage({ id, bitmap: source, lines, scale }, [source]); }
            catch (cause) { prepared.delete(id); source.close(); reject(cause); }
          });
          if (error) throw error;
        }
      } catch (cause) { bitmap?.close(); throw cause; }
      return new Promise((resolve, reject) => {
        if (batch) batch.queued = true;
        queue.push({ bitmap, prepared: crops, lines, scale, includeLines, timing, batch, resolve, reject });
        if (pageBatch > 1 && !batch && !flush) flush = setTimeout(() => { flush = undefined; pump(); }, 8);
        pump();
      });
    },
  };
}
