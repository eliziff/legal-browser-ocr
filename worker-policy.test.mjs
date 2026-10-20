import test from 'node:test';
import assert from 'node:assert/strict';
import {documentWorkers,recognitionWorkers,runtimeDefaults,takeRecognitionBatch} from './worker-policy.js';

test('recognition workers follow the browser CPU budget and reserve the UI',()=>{
  assert.deepEqual([1,2,4,8,16].map(recognitionWorkers),[1,1,3,7,15]);
});

test('document microbatches retain fixed page membership despite completion order',()=>{
  const task=(index,group)=>({scale:1,batch:{index,group}}),first={expected:2},last={expected:1};
  const queue=[task(2,first)];
  assert.deepEqual(takeRecognitionBatch(queue,4),[]);
  assert.equal(queue.length,1);
  queue.push(task(5,last));
  assert.deepEqual(takeRecognitionBatch(queue,4).map(task=>task.batch.index),[5]);
  queue.push(task(1,first));
  assert.deepEqual(takeRecognitionBatch(queue,4).map(task=>task.batch.index),[1,2]);
  assert.equal(queue.length,0);
  queue.push({scale:1},{scale:1},{scale:.75});
  assert.equal(takeRecognitionBatch(queue,4).length,2);
  assert.equal(takeRecognitionBatch(queue,4)[0].scale,.75);
  queue.push(task(1,first));first.expected--;
  assert.equal(takeRecognitionBatch(queue,4)[0].batch.index,1);
});

test('documents use parallel pages only with isolated recognition workers',()=>{
  assert.equal(documentWorkers(4,'tesseract'),4);
  assert.equal(documentWorkers(4,'fast'),1);
  assert.equal(documentWorkers(4,'none'),1);
});

test('app and embedding defaults share CPU budgets and the pipelined GPU configuration', () => {
  assert.equal(runtimeDefaults('webgpu',8).layoutWorkerCount,2);
  assert.equal(runtimeDefaults('webgpu',12).layoutWorkerCount,4);
  for (const parallelism of [1, 2, 4, 8, 16]) {
    const cpu = runtimeDefaults('wasm', parallelism), gpu = runtimeDefaults('webgpu', parallelism);
    assert.ok(cpu.workerPoolSize >= 1 && cpu.workerPoolSize <= 6);
    assert.ok(cpu.workerPoolSize < parallelism || parallelism === 1);
    assert.equal(cpu.pageConcurrency, cpu.workerPoolSize);
    assert.equal(cpu.prepareWorker, false);
    assert.equal(gpu.workerPoolSize, 1);
    assert.equal(gpu.pageBatch, 4);
    assert.equal(gpu.pageConcurrency, 8);
    assert.equal(gpu.layoutBackend, 'wasm');
    assert.equal(gpu.prepareWorker, false);
    assert.equal(gpu.captureMode, true);
    assert.equal(gpu.captureEnabled, true);
    assert.equal(gpu.gpuPrep, true);
    assert.equal(gpu.gpuArgMax, 128);
    assert.equal(cpu.captureMode, false);
    assert.equal(cpu.gpuPrep, false);
  }
});
