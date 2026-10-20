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

test('automatic GPU initialization failure starts the CPU pool and recognizes the page', async t => {
  const workers = stubWorkers(t), pool = recoveringPool(), bitmap = image();
  const reading = pool.recognize({ bitmap, lines: [{}] });
  workers[0].onmessage({ data: { type: 'error', message: 'Invented GPU model failure' } });
  await flush();
  workers[1].onmessage({ data: { type: 'ready' } });
  await flush();
  workers[1].onmessage({ data: { type: 'result', pages: [{ text: 'Juniper inventory' }] } });
  assert.equal(await reading, 'Juniper inventory');
  assert.equal(pool.configuration.backend, 'wasm');
  assert.equal(bitmap.closed, true);
  assert.equal(workers[0].stopped, true);
  pool.dispose();
});

test('GPU device loss retries active and queued pages once on CPU with their retained images', async t => {
  const workers = stubWorkers(t);
  const pool = recoveringPool(), images = [image(), image()];
  workers[0].onmessage({ data: { type: 'ready' } });
  await pool.ready;
  const readings = images.map(bitmap => pool.recognize({ bitmap, lines: [{}] }));
  await flush();
  workers[0].onmessage({ data: { type: 'fatal', message: 'Invented device loss' } });
  await flush();
  assert.equal(workers.length, 2);
  workers[1].onmessage({ data: { type: 'ready' } });
  for (const text of ['Juniper inventory', 'Maple balance']) {
    await flush();
    workers[1].onmessage({ data: { type: 'result', pages: [{ text }] } });
  }
  assert.deepEqual(await Promise.all(readings), ['Juniper inventory', 'Maple balance']);
  assert.ok(images.every(bitmap => bitmap.closed));
  assert.equal(pool.configuration.backend, 'wasm');
  pool.dispose();
  assert.ok(workers.every(worker => worker.stopped));
});

test('cancelling while CPU recovery assets are pending rejects callers without creating more workers', async t => {
  const workers = stubWorkers(t);
  let finish;
  const pool = recoveringPool(() => new Promise(resolve => { finish = resolve; })), bitmap = image();
  const reading = pool.recognize({ bitmap, lines: [{}] });
  workers[0].onmessage({ data: { type: 'error', message: 'Invented GPU model failure' } });
  await flush();
  pool.dispose();
  await assert.rejects(reading, { name: 'AbortError' });
  await assert.rejects(pool.ready, { name: 'AbortError' });
  finish(poolSettings('wasm'));
  await flush();
  assert.equal(bitmap.closed, true);
  assert.equal(workers.length, 1);
});

test('a host can replay consumed page pixels after GPU failure without keeping an extra bitmap', async t => {
  const workers = stubWorkers(t), pool = recoveringPool(), bitmap = image();
  workers[0].onmessage({ data: { type: 'ready' } }); await pool.ready;
  let replayed = false;
  const reading = pool.recognize({ bitmap, lines: [{}], replay: async () => {
    assert.equal(bitmap.closed, true);
    replayed = true; return image();
  } });
  await flush(); bitmap.close();
  workers[0].onmessage({ data: { type: 'fatal', message: 'Invented GPU device loss' } });
  await flush(); workers[1].onmessage({ data: { type: 'ready' } });
  await flush(); workers[1].onmessage({ data: { type: 'result', pages: [{ text: 'Maple balance' }] } });
  assert.equal(await reading, 'Maple balance');
  assert.equal(replayed, true);
  pool.dispose();
});

function createPool() {
  return createRecognitionPool({ workerUrl: '/invented-worker.js', runtime: {}, model: new Uint8Array([1]), codec: {},
    options: { workerPoolSize: 1, pageBatch: 1 } });
}
function image() { return { closed: false, close() { this.closed = true; } }; }
function poolSettings(backend) {
  return { workerUrl: '/invented-worker.js', runtime: {}, model: new Uint8Array([1]), codec: {},
    options: { workerPoolSize: 1, pageBatch: 1, backend } };
}
function recoveringPool(fallback = () => poolSettings('wasm')) {
  return createRecognitionPool({ ...poolSettings('webgpu'), fallback });
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function stubWorkers(t) {
  const previous = globalThis.Worker, previousBitmap = globalThis.createImageBitmap, workers = [];
  globalThis.createImageBitmap ||= async () => image();
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage() {}
    terminate() { this.stopped = true; }
  };
  t.after(() => { globalThis.Worker = previous; globalThis.createImageBitmap = previousBitmap; });
  return workers;
}
