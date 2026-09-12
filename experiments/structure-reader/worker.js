self.onmessage = async ({ data }) => {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(data.input));
    if (bytes.length > 4_000_000) throw new Error('This experiment supports up to 4 MB of OCR data.');
    const module = data.module || await WebAssembly.compile(data.wasm);
    const instance = await WebAssembly.instantiate(module);
    const api = instance.exports, ptr = api.allocate(bytes.length);
    let result;
    try {
      new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
      const packed = api.detect(ptr, bytes.length, data.profile);
      const output = Number(packed & 0xffffffffn), length = Number(packed >> 32n);
      try { result = JSON.parse(new TextDecoder().decode(new Uint8Array(api.memory.buffer, output, length))); }
      finally { api.release(output, length); }
    } finally { api.release(ptr, bytes.length); }
    if (result.error) throw new Error(result.error);
    self.postMessage({ ...result, module });
  } catch (error) { self.postMessage({ error: error.message }); }
};
