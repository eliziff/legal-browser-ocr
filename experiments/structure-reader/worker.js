import * as ort from 'onnxruntime-web/wasm';
import accurateModel from './assets/layout-model.json';
import fastModel from './assets/layout-fast-model.json';
import { initSync } from './target/bindgen/browser_structure.js';

let receivePage;
const unpack = (api, packed) => {
  if (!packed) throw new Error('Invalid layout image dimensions');
  const ptr = Number(packed & 0xffffffffn), length = Number(packed >> 32n);
  try { return new Uint8Array(api.memory.buffer, ptr, length).slice(); }
  finally { api.release(ptr, length); }
};
function call(api, operation, input, ...args) {
  const bytes = new TextEncoder().encode(JSON.stringify(input)), ptr = api.allocate(bytes.length);
  try {
    new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
    const result = JSON.parse(new TextDecoder().decode(unpack(api, api[operation](ptr, bytes.length, ...args))));
    if (result.error) throw new Error(result.error);
    return result;
  } finally { api.release(ptr, bytes.length); }
}
function extract(api, pdf, pages) {
  const ptr=api.allocate(pdf.length);
  let input, inputPtr;
  try {
    new Uint8Array(api.memory.buffer,ptr,pdf.length).set(pdf);
    let result;
    if (pages) {
      input=new TextEncoder().encode(JSON.stringify(pages.map(page=>({width:page.width,height:page.height,lines:page.lines.map(line=>({
        text:line.text,bbox:[line.x,line.y,line.x+line.width,line.y+line.height],confidence:line.confidence ?? 1,
      }))}))));
      inputPtr=api.allocate(input.length);new Uint8Array(api.memory.buffer,inputPtr,input.length).set(input);
      result=api.extract_ocr(ptr,pdf.length,inputPtr,input.length);
    } else result=api.extract_pdf(ptr,pdf.length);
    const output=JSON.parse(new TextDecoder().decode(unpack(api,result)));
    if(output.error)throw Error(output.error);
    return output;
  } finally {api.release(ptr,pdf.length);if(input)api.release(inputPtr,input.length);}
}

async function layoutPages(data, api) {
  const model = data.regioning === 'fast' ? fastModel : accurateModel;
  const [targetHeight, targetWidth] = model.inputSize;
  if (data.layouts) return data.layouts;
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 2)) : 1;
  ort.env.wasm.wasmPaths = data.runtime;
  self.postMessage({ progress: 'Loading document layout model…' });
  const bytes = data.model;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== model.sha256) throw new Error('Layout model checksum does not match this package');
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  const layouts = [];
  try {
    for (let index = 0; index < data.input.pages.length; index++) {
      if (!data.input.pages[index].lines.length) { layouts.push(null); continue; }
      self.postMessage({ progress: `Analysing layout · page ${index + 1} of ${data.input.pages.length}` });
      const page = await new Promise((resolve, reject) => {
        receivePage = { resolve, reject };
        self.postMessage({ renderPage: index + 1 });
      });
      const { width, height, bitmap } = page;
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0); bitmap.close();
      const rgba = context.getImageData(0, 0, width, height).data;
      const rgb = new Uint8Array(width * height * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2]; }
      canvas.width = canvas.height = 1;
      const ptr = api.allocate(rgb.length);
      let pixels;
      try {
        new Uint8Array(api.memory.buffer, ptr, rgb.length).set(rgb);
        pixels = new Float32Array(unpack(api, api.preprocess(ptr, rgb.length, width, height, model.variant)).buffer);
      } finally { api.release(ptr, rgb.length); }
      const feeds = {
        image: new ort.Tensor('float32', pixels, [1, 3, targetHeight, targetWidth]),
        scale_factor: new ort.Tensor('float32', Float32Array.of(targetHeight / height, targetWidth / width), [1, 2]),
      };
      if (model.inputNames.includes('im_shape')) feeds.im_shape = new ort.Tensor('float32', Float32Array.of(targetHeight, targetWidth), [1, 2]);
      const outputs = await session.run(feeds);
      try {
        const count = Number(outputs[model.outputNames[1]].data[0]);
        const values = Array.from(outputs[model.outputNames[0]].data.slice(0, count * 6));
        const { detections } = call(api, 'decode_boxes', { values, width, height, labels: model.labels, threshold: model.scoreThreshold });
        layouts.push({ width, height, detections });
      } finally {
        for (const tensor of [...Object.values(feeds), ...Object.values(outputs)]) tensor.dispose();
      }
    }
    return layouts;
  } finally { await session.release(); }
}

self.onmessage = async ({ data }) => {
  if (data.page || data.pageError) {
    const pending = receivePage; receivePage = null;
    if (data.pageError) pending?.reject(new Error(data.pageError));
    else pending?.resolve(data.page);
    return;
  }
  try {
    const module = data.module || await WebAssembly.compile(data.wasm);
    const api = initSync({module});
    if(data.extract){self.postMessage({extracted:extract(api,data.extract),module});return;}
    const extracted=extract(api,data.pdf,data.input.pages);
    data.input.pages=extracted.pages;
    const layouts = data.profile === 0 ? await layoutPages(data, api) : null;
    self.postMessage({ progress: 'Building document structure…' });
    const result = call(api, 'detect', {extracted,layouts}, data.profile);
    self.postMessage({ ...result, module, layouts });
  } catch (error) { self.postMessage({ error: error.message }); }
};
