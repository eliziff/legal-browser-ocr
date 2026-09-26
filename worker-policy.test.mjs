import test from 'node:test';
import assert from 'node:assert/strict';
import {documentWorkers,recognitionWorkers} from './worker-policy.js';

test('recognition workers follow the browser CPU budget and reserve the UI',()=>{
  assert.deepEqual([1,2,4,8,16].map(recognitionWorkers),[1,1,3,7,15]);
});

test('documents use parallel pages only with isolated recognition workers',()=>{
  assert.equal(documentWorkers(4,'tesseract'),4);
  assert.equal(documentWorkers(4,'fast'),1);
  assert.equal(documentWorkers(4,'none'),1);
});
