import assert from 'node:assert/strict';
import {test} from 'node:test';
import {enqueueIds, recognizeQueued} from './experiments/ocr-speed/queued-recognition.js';
import {decodeClassIds} from './recognizer.js';

test('queued GPU readback releases partial allocations and submission failures', async () => {
  globalThis.GPUBufferUsage = {STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8, UNIFORM: 16};
  for (const failureAt of [1, 2, 3, 4]) {
    let allocations = 0, live = 0;
    const device = {
      limits: {maxComputeWorkgroupsPerDimension: 65535},
      createBuffer() {
        if (++allocations === failureAt) throw Error('deliberate allocation failure');
        live++; return {destroy() { live--; }};
      },
      queue: {writeBuffer() {}},
      createBindGroup() { throw Error('deliberate submission failure'); },
    };
    const argmax = {device, pipeline: Promise.resolve({getBindGroupLayout() {}})};
    await assert.rejects(enqueueIds(argmax, {dims: [2, 5, 3], gpuBuffer: {}}), /deliberate/);
    assert.equal(live, 0);
  }
});

test('queued batches preserve line order and release retained inputs after a model failure', async () => {
  globalThis.GPUBufferUsage = {STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8, UNIFORM: 16};
  globalThis.GPUMapMode = {READ: 1};
  for (const fail of [false, true]) {
    let liveBuffers = 0, liveTensors = 0, liveInputs = 0, peakInputs = 0, calls = 0;
    class Tensor {
      constructor(type, data, dims) { Object.assign(this, {data, dims}); liveTensors++; }
      dispose() { assert.ok(!this.disposed); this.disposed = true; liveTensors--; }
    }
    const sharedLogits = {classId: 0};
    const device = {
      limits: {maxComputeWorkgroupsPerDimension: 65535},
      createBuffer({size}) {
        liveBuffers++;
        return {memory: new ArrayBuffer(size), mapState: 'unmapped',
          async mapAsync() { await new Promise(resolve => setTimeout(resolve, 1)); this.mapState = 'mapped'; },
          getMappedRange() { return this.memory; }, unmap() { this.mapState = 'unmapped'; },
          destroy() { assert.ok(!this.destroyed); this.destroyed = true; liveBuffers--; }};
      },
      createBindGroup({entries}) { return entries.map(entry => entry.resource.buffer); },
      createCommandEncoder() {
        let bindings; const commands = [];
        return {beginComputePass() { return {setPipeline() {}, setBindGroup(_index, value) { bindings = value; },
          dispatchWorkgroups() { commands.push(() => { new Uint32Array(bindings[1].memory)[0] = bindings[0].classId; }); }, end() {}}; },
          copyBufferToBuffer(source, _a, target) { commands.push(() => new Uint8Array(target.memory).set(new Uint8Array(source.memory))); },
          finish() { return commands; }};
      },
      queue: {writeBuffer() {}, submit(lists) { for (const commands of lists) for (const command of commands) command(); }},
    };
    const recognizer = {ort: {Tensor}, labels: {1: 'a', 2: 'b', 3: 'c', 4: 'd'}, profile: {height: 1, widthMultiple: 8, minimum: 8},
      argmax: {device, pipeline: Promise.resolve({getBindGroupLayout() {}})},
      session: {batch: 1, async run(feeds) {
        if (++calls === 3 && fail) throw Error('deliberate model failure');
        sharedLogits.classId = Number(feeds.widths.data[0]) / 8;
        return {logits: {dims: [1, 1, 5], gpuBuffer: sharedLogits, dispose() {}}, lengths: new Tensor('int64', BigInt64Array.of(1n), [1])};
      }},
      gpuPreparer: {pack() {
        liveInputs++; peakInputs = Math.max(peakInputs, liveInputs);
        return {tensor: {}, release() { liveInputs--; }};
      }},
    };
    const run = recognizeQueued(recognizer, [24, 8, 16, 32].map(width => ({width, gpu: []})), decodeClassIds, {batchSize: 1}, 2);
    if (fail) await assert.rejects(run, /deliberate model failure/);
    else assert.deepEqual((await run).map(line => line.text), ['c', 'a', 'b', 'd']);
    assert.equal(liveBuffers, 0); assert.equal(liveTensors, 0); assert.equal(liveInputs, 0);
    assert.ok(peakInputs <= 2);
  }
});
