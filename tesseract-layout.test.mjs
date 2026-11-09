import test from 'node:test';
import assert from 'node:assert/strict';
import { TesseractLayout } from './tesseract-layout.js';

for (const page of ['https://example.test/app/index.html', 'file:///tmp/ocr/index.html']) {
  test(`layout workers receive relative and embedded assets from ${new URL(page).protocol}`, async t => {
    const previous = { Worker: globalThis.Worker, location: globalThis.location }, jobs = [];
    globalThis.location = { href: page };
    globalThis.Worker = class {
      postMessage(job) {
        jobs.push(job);
        queueMicrotask(() => this.onmessage({ data: { id: job.id, lines: [{ x0: 0, y0: 0, x1: 2, y1: 2 }] } }));
      }
      terminate() {}
    };
    t.after(() => Object.assign(globalThis, previous));
    const modelOptions = Object.freeze({ modelPath: new URL('./model.bin', page), configPath: 'data:application/json;base64,e30=',
      runtimeMjs: 'data:application/javascript,export default 1',
      runtimeWasm: 'blob:https://example.test/5ba51cd8-ed03-42e0-a926-e8ffec1d6f80' });
    const expected = { ...modelOptions, modelPath: new URL('./model.bin', page).href };
    const layout = new TesseractLayout({ corePath: '../layout.mjs',
      wasmPath: 'data:application/wasm;base64,AGFzbQEAAAA=', modelOptions });
    try {
      assert.deepEqual(await layout.findLines({ width: 2, height: 2,
        getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(16) }) }) }),
      [{ x0: 0, y0: 0, x1: 2, y1: 2 }]);
      assert.equal(jobs[0].corePath, new URL('../layout.mjs', page).href);
      assert.equal(jobs[0].wasmPath, 'data:application/wasm;base64,AGFzbQEAAAA=');
      assert.deepEqual(jobs[0].modelOptions, expected);
    } finally { layout.terminate(); }
  });
}
