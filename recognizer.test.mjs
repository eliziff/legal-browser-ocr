import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeClassIds, decodeSequence, inkBounds, packLines, recognizerProfile } from './recognizer.js';

test('trained CTC outputs use time before classes, blank zero, and each line length', () => {
  const ids = [[1, 1, 0, 1, 2, 2], [2, 0, 2, 1, 1, 1]];
  const output = { dims: [2, 6, 3], data: Float32Array.from(ids.flatMap(row => row.flatMap(id => [0, 1, 2].map(c => c === id ? 4 : -4)))) };
  assert.equal(decodeSequence(output, 0, 5, ['', 'a', 'b']).text, 'aab');
  const compact = { dims: [2, 6], data: BigInt64Array.from(ids.flat(), BigInt) };
  assert.equal(decodeClassIds(compact, 0, 5, ['', 'a', 'b']).text, 'aab');
  assert.equal(decodeClassIds(compact, 1, 3, ['', 'a', 'b']).text, 'bb');
  const result = decodeSequence(output, 1, 3, ['', 'a', 'b'], true);
  assert.equal(result.text, 'bb');
  assert.ok(result.confidence > .99 && result.confidence <= 1);
});

test('CRNN replicates grayscale into normalized RGB and pads with normalized black', () => {
  const profile = { ...recognizerProfile('crnn'), height: 1 };
  const output = packLines([{ width: 2, gray: Uint8Array.of(0, 255) }], profile, 3);
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(output[c * 3] + profile.mean[c] / profile.std[c]) < 1e-6);
    assert.ok(Math.abs(output[c * 3 + 1] - (1 - profile.mean[c]) / profile.std[c]) < 1e-6);
    assert.equal(output[c * 3 + 2], output[c * 3]);
  }
  assert.deepEqual([...packLines([{ width: 2, gray: Uint8Array.of(0, 255) }], { ...recognizerProfile('indra'), height: 1 }, 3)], [1, 0, 0]);
});

test('Indra finds the ink box before adding margins based on ink height', () => {
  const rgba = new Uint8Array(10 * 10 * 4).fill(255);
  for (let y = 3; y < 7; y++) for (let x = 2; x < 8; x++) rgba.fill(0, (y * 10 + x) * 4, (y * 10 + x) * 4 + 3);
  assert.deepEqual(inkBounds(rgba, 10, 10), { x: 2, y: 3, width: 6, height: 4, px: 2, py: 1 });
  assert.throws(() => recognizerProfile('unknown'), /Unknown recognizer/);
});
