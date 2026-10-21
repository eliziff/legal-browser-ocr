import test from 'node:test';
import assert from 'node:assert/strict';
import {emissionMargins, needsTeacher} from './experiments/ocr-speed/cascade-policy.js';

test('cascade confidence charges emitted characters and respects the valid CTC extent', () => {
  const value = emissionMargins([9, 1, 1, 0, 1, 2, 0, 8], [99, 4, .1, .1, 2, 6, .1, 99], 1, 6);
  assert.deepEqual(value, {emissions: 3, minimum: 2, mean: 4, lowerQuartile: 2});
  assert.equal(needsTeacher(value, {metric: 'mean', threshold: 3}), false);
  assert.equal(needsTeacher(value, {metric: 'minimum', threshold: 3}), true);
  assert.equal(needsTeacher(emissionMargins([0, 0], [5, 8], 0, 2), {metric: 'mean', threshold: 0}), true);
});
