import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeIndra, decodePaddle, xycut } from './experiments/ocr-speed/detector-post.js';

test('decodes two Indra core bands without joining diagonal neighbors', () => {
  const width = 12, height = 6, plane = width * height, data = new Float32Array(plane * 3);
  data.fill(-10, 0, plane); data.fill(2, plane);
  for (const [start, row] of [[1, 1], [5, 2]]) for (let x = start; x < start + 4; x++) data[row * width + x] = 10;
  const boxes = decodeIndra(data, width, height);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], { x0: 1.4, y0: 1, x1: 10.6, y1: 5 });
});

test('DB detection expands a confident rectangle and rejects faint regions', () => {
  const width = 32, height = 24, data = new Float32Array(width * height);
  for (let y = 8; y < 14; y++) for (let x = 6; x < 26; x++) data[y * width + x] = .9;
  const config = { threshold: .2, boxThreshold: .4, unclipRatio: 1.4, maxCandidates: 3000 };
  const boxes = decodePaddle(data, width, height, config);
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0].x0 < 6 && boxes[0].x1 > 25 && boxes[0].y0 < 8 && boxes[0].y1 > 13);
  data.fill(.3);
  assert.deepEqual(decodePaddle(data, width, height, config), []);
});

test('XY-cut reads a spanning heading, then each column, then a spanning footer', () => {
  const box = (id, x0, y0, x1, y1) => ({ id, x0, y0, x1, y1 });
  const lines = [box('right2', 120, 70, 200, 80), box('left1', 0, 50, 80, 60), box('footer', 0, 110, 200, 120), box('heading', 0, 0, 200, 10), box('right1', 120, 50, 200, 60), box('left2', 0, 70, 80, 80)];
  assert.deepEqual(xycut(lines).map(line => line.id), ['heading', 'left1', 'left2', 'right1', 'right2', 'footer']);
});
