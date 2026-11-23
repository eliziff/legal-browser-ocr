import { decodeClassIds } from './recognizer.js';

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
    const { instance } = await WebAssembly.instantiate(wasmBytes);
    const { memory, alloc, dealloc, indra_load } = instance.exports;
    const len = modelBytes.byteLength;
    const ptr = alloc(len);
    try {
      new Uint8Array(memory.buffer, ptr, len).set(
        modelBytes instanceof Uint8Array ? modelBytes : new Uint8Array(modelBytes),
      );
      const handle = indra_load(ptr, len);
      if (!handle) throw new Error('Failed to load Indra model into indra-native.wasm');
      return new IndraNativeRuntime(instance, handle);
    } finally {
      dealloc(ptr, len);
    }
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
