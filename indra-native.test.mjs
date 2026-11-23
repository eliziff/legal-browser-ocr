import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IndraNativeRuntime } from './indra-native.js';

const root = import.meta.dirname;

test('indra-native.wasm loads ONNX weights and decodes synthetic line images', async () => {
  const modelPath = resolve(root, '../legal-pdf-parser/runtime/indra/assets/markers/model.onnx');
  const codecPath = resolve(root, '../legal-pdf-parser/runtime/indra/assets/markers/codec.json');
  assert.ok(existsSync(modelPath), `expected model at ${modelPath}`);
  assert.ok(existsSync(codecPath), `expected codec at ${codecPath}`);

  const wasmBytes = readFileSync(resolve(root, 'indra-native.wasm'));
  const modelBytes = readFileSync(modelPath);
  const codec = JSON.parse(readFileSync(codecPath, 'utf8'));
  const labels = Object.fromEntries(
    Object.entries(codec).flatMap(([character, ids]) => ids.map(id => [id, character])),
  );

  const runtime = await IndraNativeRuntime.create(wasmBytes, modelBytes);
  try {
    const width = 320;
    const gray = new Uint8Array(width * 32).fill(255);
    for (let x = 20; x < 300; x++) {
      if (Math.floor(x / 6) % 2 === 0) {
        for (let y = 7; y < 25; y++) gray[y * width + x] = 0;
      }
    }
    const synthetic = runtime.recognizeLine(gray, width, labels);
    assert.equal(typeof synthetic.text, 'string');
    assert.ok(synthetic.text.length > 0, 'expected non-empty CTC output on striped synthetic input');

    const blank = runtime.recognizeLine(new Uint8Array(width * 32).fill(255), width, labels);
    assert.equal(blank.text, '');
  } finally {
    runtime.dispose();
  }
});
