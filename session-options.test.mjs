import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryOptions, tensorWidthMultiple } from './experiments/ocr-speed/session-options.js';

test('allocator experiments preserve defaults and accept only explicit boolean flags', () => {
  assert.deepEqual(memoryOptions(new URLSearchParams()), {});
  assert.deepEqual(memoryOptions(new URLSearchParams('arena=1&memPattern=0')), {enableCpuMemArena:true,enableMemPattern:false});
  assert.throws(() => memoryOptions(new URLSearchParams('arena=maybe')), /must be 0 or 1/);
});

test('tensor width experiments keep the default and bound the padded shape', () => {
  assert.equal(tensorWidthMultiple(new URLSearchParams()), 8);
  assert.equal(tensorWidthMultiple(new URLSearchParams('tensorWidth=64')), 64);
  for (const width of ['', '0', '9', '1024', 'NaN'])
    assert.throws(() => tensorWidthMultiple(new URLSearchParams({tensorWidth:width})), /multiple of 8/);
});
