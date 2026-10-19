import * as wasm from 'onnxruntime-web/wasm';
import { decodeIndra, decodePaddle, xycut } from './detector-post.js';

let ready;
let ort=wasm;
async function load(options) {
  if(options.executionProvider==='webgpu'){ort=await import('onnxruntime-web/webgpu');ort.env.webgpu.powerPreference='high-performance';}
  ort.env.wasm.wasmPaths = { mjs: options.runtimeMjs, wasm: options.runtimeWasm };
  ort.env.wasm.numThreads = 1;
  const configResponse = await fetch(options.configPath), modelResponse = await fetch(options.modelPath);
  if (!configResponse.ok || !modelResponse.ok) throw new Error('Detector assets are missing. Open the detectors package.');
  const config = (await configResponse.json())[options.backend];
  if(options.limitType)config.limitType=options.limitType;
  const session = await ort.InferenceSession.create(await modelResponse.arrayBuffer(), { executionProviders: [options.executionProvider||'wasm'], graphOptimizationLevel: 'all', ...options.sessionOptions });
  return { config, session };
}

function input(bitmap, width, height, backend, config) {
  let scale = backend === 'indra' ? config.longSide / Math.max(width, height) : config.limitType==='max'?Math.min(1,config.limitSide/Math.max(width,height)):Math.max(1, config.limitSide / Math.min(width, height));
  if (backend === 'paddle') scale = Math.min(scale, config.maxSide / Math.max(width, height));
  let resizedWidth = Math.max(1, Math.round(width * scale)), resizedHeight = Math.max(1, Math.round(height * scale));
  const inputWidth = backend === 'indra' ? Math.ceil(resizedWidth / 32) * 32 : Math.max(32, Math.round(resizedWidth / 32) * 32);
  const inputHeight = backend === 'indra' ? Math.ceil(resizedHeight / 32) * 32 : Math.max(32, Math.round(resizedHeight / 32) * 32);
  if (backend === 'paddle') { resizedWidth = inputWidth; resizedHeight = inputHeight; }
  const canvas = new OffscreenCanvas(inputWidth, inputHeight), context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = 'white'; context.fillRect(0, 0, inputWidth, inputHeight);
  context.imageSmoothingQuality = backend === 'indra' ? 'high' : 'low';
  context.drawImage(bitmap, 0, 0, width, height, 0, 0, resizedWidth, resizedHeight);
  const rgba = context.getImageData(0, 0, inputWidth, inputHeight).data, plane = inputWidth * inputHeight;
  const channels = backend === 'indra' ? 1 : 3, data = new Float32Array(plane * channels);
  if (backend === 'indra') {
    for (let y = 0; y < resizedHeight; y++) for (let x = 0; x < resizedWidth; x++) {
      const index = y * inputWidth + x, offset = index * 4;
      data[index] = 1 - Math.round(rgba[offset] * .299 + rgba[offset + 1] * .587 + rgba[offset + 2] * .114) / 255;
    }
  } else {
    const mean = [.485, .456, .406], std = [.229, .224, .225];
    for (let c = 0; c < 3; c++) for (let i = 0; i < plane; i++) data[c * plane + i] = (rgba[i * 4 + 2 - c] / 255 - mean[c]) / std[c];
  }
  canvas.width = canvas.height = 1;
  return { data, dims: [1, channels, inputHeight, inputWidth], scale, inputWidth, inputHeight };
}

self.onmessage = async ({ data: { id, bitmap, pixels, width, height, modelOptions, profile } }) => {
  let source;
  try {
    ready ||= load(modelOptions);
    const loaded = await ready, session = loaded.session, config = {...loaded.config}, started = performance.now();
    if(modelOptions.longSide)config[modelOptions.backend==='indra'?'longSide':'limitSide']=modelOptions.longSide;
    if (!bitmap) { source = new OffscreenCanvas(width, height); source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0); }
    const prepared = input(bitmap || source, width, height, modelOptions.backend, config), detectionStarted = performance.now();
    const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', prepared.data, prepared.dims) });
    const tensor = output[session.outputNames[0]], [h, w] = tensor.dims.slice(-2), postStarted = performance.now();
    const boxes = modelOptions.backend === 'indra' ? decodeIndra(tensor.data, w, h) : decodePaddle(tensor.data, w, h, config);
    for(const value of Object.values(output))value.dispose();
    const sx = modelOptions.backend === 'indra' ? 1 / prepared.scale : width / w, sy = modelOptions.backend === 'indra' ? 1 / prepared.scale : height / h;
    const lines = boxes.map(box => ({ x0: Math.max(0, box.x0 * sx), y0: Math.max(0, box.y0 * sy), x1: Math.min(width, box.x1 * sx), y1: Math.min(height, box.y1 * sy) })).filter(box => box.x1 > box.x0 && box.y1 > box.y0);
    self.postMessage({ id, lines: xycut(lines), ...(profile && { timing: { layout_prepare_seconds: (detectionStarted - started) / 1000, layout_model_seconds: (postStarted - detectionStarted) / 1000, layout_post_seconds: (performance.now() - postStarted) / 1000, layout_detect_seconds: (performance.now() - detectionStarted) / 1000 } }) });
  } catch (error) { self.postMessage({ id, error: error.message }); }
  finally { bitmap?.close(); if (source) source.width = source.height = 1; }
};
