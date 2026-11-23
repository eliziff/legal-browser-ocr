import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web/wasm';
import { DetectorNativeRuntime, IndraNativeRuntime } from './indra-native.js';
import { decodeIndra } from './experiments/ocr-speed/detector-post.js';

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

test('indra-native.wasm DetectorNativeRuntime matches ORT Web output on legal text stripes', async () => {
  const detPath = resolve(root, 'assets/detectors/indra/model.onnx');
  assert.ok(existsSync(detPath), `expected detector at ${detPath}`);
  const wasmBytes = readFileSync(resolve(root, 'indra-native.wasm'));
  const modelBytes = readFileSync(detPath);

  const height = 768;
  const width = 576;
  const input = new Float32Array(height * width);
  for (let y = 40; y < height - 40; y += 28) {
    for (let dy = 0; dy < 10; dy++) {
      for (let x = 48; x < width - 48; x++) {
        if ((Math.floor(x / 5) + dy) % 3 !== 0) input[(y + dy) * width + x] = 0.85;
      }
    }
  }

  ort.env.wasm.wasmPaths = pathToFileURL(resolve(root, 'node_modules/onnxruntime-web/dist/') + '/').href;
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const detector = await DetectorNativeRuntime.create(wasmBytes, modelBytes);
  try {
    const ortOutputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 1, height, width]) });
    const ortTensor = ortOutputs[session.outputNames[0]];
    const ortData = ortTensor.data;
    const natData = detector.detect(input, height, width);
    assert.equal(natData.length, ortData.length);
    let maxDiff = 0;
    for (let i = 0; i < natData.length; i++) {
      const d = Math.abs(natData[i] - ortData[i]);
      if (d > maxDiff) maxDiff = d;
    }
    assert.ok(maxDiff < 1e-4, `DetectorNativeRuntime max_abs_diff ${maxDiff} >= 1e-4`);
    const ortBoxes = decodeIndra(ortData, width >> 1, height >> 1);
    const natBoxes = decodeIndra(natData, width >> 1, height >> 1);
    assert.equal(natBoxes.length, ortBoxes.length);
    for (let i = 0; i < ortBoxes.length; i++) {
      for (const k of ['x0', 'y0', 'x1', 'y1']) {
        assert.ok(Math.abs(natBoxes[i][k] - ortBoxes[i][k]) < 1e-3, `box ${i} ${k}: ${natBoxes[i][k]} vs ${ortBoxes[i][k]}`);
      }
    }

    // Quick warmup + comparison
    for (let i = 0; i < 2; i++) {
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 1, height, width]) });
      out[session.outputNames[0]].dispose();
      detector.detect(input, height, width);
    }
    const iters = 6;
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) {
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 1, height, width]) });
      out[session.outputNames[0]].dispose();
    }
    const ortMs = (performance.now() - t0) / iters;
    const t1 = performance.now();
    for (let i = 0; i < iters; i++) {
      detector.detect(input, height, width);
    }
    const natMs = (performance.now() - t1) / iters;
    console.log(`[bench-wasm] detector 768x576: ORT-Web=${ortMs.toFixed(1)}ms, DetectorNativeWasm=${natMs.toFixed(1)}ms, speedup=${(ortMs / natMs).toFixed(2)}x, maxDiff=${maxDiff.toExponential(2)}`);

    ortTensor.dispose();
  } finally {
    detector.dispose();
    await session.release();
  }
});
