import test from 'node:test';
import assert from 'node:assert/strict';
import {documentWorkers,recognitionWorkers,takeRecognitionBatch} from './worker-policy.js';

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
