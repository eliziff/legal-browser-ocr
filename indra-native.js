import { decodeClassIds } from './recognizer.js';

async function createHandle(wasmBytes, modelBytes, loadFnName) {
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  const { memory, alloc, dealloc } = instance.exports;
  const loadFn = instance.exports[loadFnName];
  if (typeof loadFn !== 'function') throw new Error(`Missing Wasm export: ${loadFnName}`);
  const len = modelBytes.byteLength;
  const ptr = alloc(len);
  try {
    new Uint8Array(memory.buffer, ptr, len).set(
      modelBytes instanceof Uint8Array ? modelBytes : new Uint8Array(modelBytes),
    );
    const handle = loadFn(ptr, len);
    if (!handle) throw new Error(`Failed to load model via ${loadFnName}`);
    return { instance, handle };
  } finally {
    dealloc(ptr, len);
  }
}

/** Runs Indra CPU line recognition inside `indra-native.wasm` (SIMD128) without ORT padding. */
export class IndraNativeRuntime {
  constructor(instance, handle) {
    this.instance = instance;
    this.handle = handle;
    this.grayPtr = 0;
    this.grayCap = 0;
    this.idsPtr = 0;
    this.idsCap = 0;
  }

  static async create(wasmBytes, modelBytes) {
    const { instance, handle } = await createHandle(wasmBytes, modelBytes, 'indra_load');
    return new IndraNativeRuntime(instance, handle);
  }

  #ensureGray(needed) {
    if (needed <= this.grayCap) return this.grayPtr;
    const { alloc, dealloc } = this.instance.exports;
    if (this.grayPtr) dealloc(this.grayPtr, this.grayCap);
    this.grayCap = Math.max(needed, 32 * 4096);
    this.grayPtr = alloc(this.grayCap);
    return this.grayPtr;
  }

  #ensureIds(needed) {
    if (needed <= this.idsCap) return this.idsPtr;
    const { alloc, dealloc } = this.instance.exports;
    if (this.idsPtr) dealloc(this.idsPtr, this.idsCap * 4);
    this.idsCap = Math.max(needed, 1024);
    this.idsPtr = alloc(this.idsCap * 4);
    return this.idsPtr;
  }

  recognizeLine(gray, width, labels, timing) {
    const { memory, indra_recognize_u8 } = this.instance.exports;
    const pxLen = width * 32;
    const grayPtr = this.#ensureGray(pxLen);
    const maxSteps = Math.ceil(width / 4) + 8;
    const idsPtr = this.#ensureIds(maxSteps);
    let started = timing ? performance.now() : 0;
    new Uint8Array(memory.buffer, grayPtr, pxLen).set(gray.subarray(0, pxLen));
    const steps = indra_recognize_u8(this.handle, grayPtr, width, idsPtr, maxSteps);
    if (timing) {
      timing.model_seconds += (performance.now() - started) / 1000;
      timing.recognition_lines = (timing.recognition_lines || 0) + 1;
      started = performance.now();
    }
    const ids = new Uint32Array(memory.buffer, idsPtr, steps);
    const result = decodeClassIds({ dims: [1, steps], data: ids }, 0, steps, labels);
    if (timing) timing.decode_seconds += (performance.now() - started) / 1000;
    return result;
  }

  recognizePrepared(lines, labels, { timing } = {}) {
    return lines.map(line => this.recognizeLine(line.gray, line.width, labels, timing));
  }

  dispose() {
    const { dealloc, indra_free } = this.instance.exports;
    if (this.grayPtr) dealloc(this.grayPtr, this.grayCap);
    if (this.idsPtr) dealloc(this.idsPtr, this.idsCap * 4);
    if (this.handle) indra_free(this.handle);
    this.grayPtr = this.idsPtr = this.handle = 0;
  }
}

/** Runs the Indra FPN line-box detector inside `indra-native.wasm` (SIMD128) without ORT CPU overhead. */
export class DetectorNativeRuntime {
  constructor(instance, handle) {
    this.instance = instance;
    this.handle = handle;
    this.inPtr = 0;
    this.inCap = 0;
    this.outPtr = 0;
    this.outCap = 0;
  }

  static async create(wasmBytes, modelBytes) {
    const { instance, handle } = await createHandle(wasmBytes, modelBytes, 'detector_load');
    return new DetectorNativeRuntime(instance, handle);
  }

  #ensureIn(neededFloats) {
    if (neededFloats <= this.inCap) return this.inPtr;
    const { alloc, dealloc } = this.instance.exports;
    if (this.inPtr) dealloc(this.inPtr, this.inCap * 4);
    this.inCap = Math.max(neededFloats, 896 * 640);
    this.inPtr = alloc(this.inCap * 4);
    return this.inPtr;
  }

  #ensureOut(neededFloats) {
    if (neededFloats <= this.outCap) return this.outPtr;
    const { alloc, dealloc } = this.instance.exports;
    if (this.outPtr) dealloc(this.outPtr, this.outCap * 4);
    this.outCap = Math.max(neededFloats, 3 * 448 * 320);
    this.outPtr = alloc(this.outCap * 4);
    return this.outPtr;
  }

  detect(inputF32, height, width) {
    const inLen = height * width;
    const outLen = 3 * (height >> 1) * (width >> 1);
    const inPtr = this.#ensureIn(inLen);
    const outPtr = this.#ensureOut(outLen);
    const { memory, detector_run } = this.instance.exports;
    new Float32Array(memory.buffer, inPtr, inLen).set(inputF32.subarray(0, inLen));
    const written = detector_run(this.handle, inPtr, height, width, outPtr);
    if (!written) throw new Error(`detector_run failed for ${width}x${height}`);
    return new Float32Array(memory.buffer, outPtr, written);
  }

  dispose() {
    const { dealloc, detector_free } = this.instance.exports;
    if (this.inPtr) dealloc(this.inPtr, this.inCap * 4);
    if (this.outPtr) dealloc(this.outPtr, this.outCap * 4);
    if (this.handle) detector_free(this.handle);
    this.inPtr = this.outPtr = this.handle = 0;
  }
}
