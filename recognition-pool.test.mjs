import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecognitionPool } from './recognition-pool.js';
import { createBrowserOcr } from './browser-runtime.js';

// Worker failures and cancellation are otherwise hard to reproduce with real models.
test('worker initialization failure rejects callers and releases every worker', async t => {
  const workers = stubWorkers(t);
  const pool = createPool();
  const bitmap = image();
  const reading = pool.recognize({ bitmap, lines: [] });
  workers[0].onmessage({ data: { type: 'error', message: 'Invented model load failure' } });
  await assert.rejects(reading, /Invented model load failure/);
  assert.equal(bitmap.closed, true);
  assert.ok(workers.every(worker => worker.stopped));
});

test('cancellation rejects active and queued pages and closes queued images', async t => {
  const workers = stubWorkers(t);
  const pool = createPool();
  workers[0].onmessage({ data: { type: 'ready' } });
  await pool.ready;
  const first = pool.recognize({ bitmap: image(), lines: [{}] });
  const queued = image(), second = pool.recognize({ bitmap: queued, lines: [{}] });
  await Promise.resolve();
  pool.dispose();
  await assert.rejects(first, { name: 'AbortError' });
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(queued.closed, true);
  assert.ok(workers.every(worker => worker.stopped));
  const later = image();
  await assert.rejects(pool.recognize({ bitmap: later, lines: [] }), { name: 'AbortError' });
  assert.equal(later.closed, true);
});

test('a crashed worker rejects all outstanding pages', async t => {
  const workers = stubWorkers(t);
  const pool = createPool();
  workers[0].onmessage({ data: { type: 'ready' } });
  await pool.ready;
  const readings = [1, 2].map(() => pool.recognize({ bitmap: image(), lines: [{}] }));
  await Promise.resolve();
  workers[0].onerror({ message: 'Invented worker crash' });
  for (const reading of readings) await assert.rejects(reading, /Invented worker crash/);
  assert.ok(workers.every(worker => worker.stopped));
});

test('disposing an embedding runtime interrupts preparation even while assets are pending', async () => {
  const pending = () => new Promise(() => {});
  const runtime = createBrowserOcr({ bytes: pending, url: pending });
  const preparing = runtime.prepare();
  runtime.dispose();
  await assert.rejects(preparing, { name: 'AbortError' });
  const bitmap = image();
  await assert.rejects(runtime.recognizePage(bitmap), { name: 'AbortError' });
  assert.equal(bitmap.closed, true);
});

function createPool() {
  return createRecognitionPool({ workerUrl: '/invented-worker.js', runtime: {}, model: new Uint8Array([1]), codec: {},
    options: { workerPoolSize: 1, pageBatch: 1 } });
}
function image() { return { closed: false, close() { this.closed = true; } }; }
function stubWorkers(t) {
  const previous = globalThis.Worker, workers = [];
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage() {}
    terminate() { this.stopped = true; }
  };
  t.after(() => { globalThis.Worker = previous; });
  return workers;
}
