import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryOptions } from './experiments/ocr-speed/session-options.js';

test('allocator experiments preserve defaults and accept only explicit boolean flags', () => {
  assert.deepEqual(memoryOptions(new URLSearchParams()), {});
  assert.deepEqual(memoryOptions(new URLSearchParams('arena=1&memPattern=0')), {enableCpuMemArena:true,enableMemPattern:false});
  assert.throws(() => memoryOptions(new URLSearchParams('arena=maybe')), /must be 0 or 1/);
});
