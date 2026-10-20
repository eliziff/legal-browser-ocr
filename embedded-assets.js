import pako from 'pako';

/** Decode only the packaged assets the selected backend needs. */
export function createEmbeddedAssets(values, compressed = []) {
  const gzip = new Set(compressed), urls = new Map();
  async function bytes(name) {
    let data;
    if (typeof Uint8Array.fromBase64 === 'function') data = Uint8Array.fromBase64(values[name]);
    else {
      const binary = atob(values[name]); data = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    }
    if (!gzip.has(name)) return data;
    try {
      if (typeof DecompressionStream === 'function') {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      return pako.ungzip(data);
    } catch (cause) { throw new Error(`Could not decompress packaged asset ${name}: ${cause}`); }
  }
  return {
    bytes,
    url(name, type = 'application/javascript') {
      if (!urls.has(name)) urls.set(name, bytes(name).then(data => {
        // File-loaded workers have opaque origins and cannot share blob module URLs.
        if (globalThis.location?.protocol === 'file:') {
          if (typeof FileReader === 'function') return new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(new Blob([data], { type }));
          });
          const chunks = [];
          for (let i = 0; i < data.length; i += 32768) chunks.push(String.fromCharCode(...data.subarray(i, i + 32768)));
          return `data:${type};base64,${btoa(chunks.join(''))}`;
        }
        return URL.createObjectURL(new Blob([data], { type }));
      }));
      return urls.get(name);
    },
    async dispose() {
      const results = await Promise.allSettled(urls.values()); urls.clear();
      for (const result of results) if (result.status === 'fulfilled' && result.value.startsWith('blob:')) URL.revokeObjectURL(result.value);
    },
  };
}
