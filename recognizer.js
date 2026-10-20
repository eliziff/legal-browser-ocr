import {GpuArgMax} from './experiments/ocr-speed/gpu-argmax.js';

const profiles = {
  indra: { id: 'indra', label: 'Indra', model: 'assets/indra/model.onnx', codec: 'assets/indra/codec.json', height: 32, channels: 1, minimum: 8, batchSize: 16 },
  crnn: { id: 'crnn', label: 'docTR CRNN', model: 'assets/crnn/model.onnx', codec: 'assets/crnn/codec.json', height: 32, channels: 3, minimum: 128, batchSize: 16,
    mean: [.694, .695, .693], std: [.299, .296, .301] },
};

export function recognizerProfile(id = 'indra') {
  if (!Object.hasOwn(profiles, id)) throw new Error(`Unknown recognizer: ${id}`);
  return profiles[id];
}

export function inkBounds(rgba, width, height) {
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let left = 0, right = width - 1;
    // Only the first and last ink pixel in a row can change its bounds.
    for (; left < width; left++) {
      const offset = row + left * 4;
      if (rgba[offset] + rgba[offset + 1] + rgba[offset + 2] < 659) break;
    }
    if (left === width) continue;
    for (; right > left; right--) {
      const offset = row + right * 4;
      if (rgba[offset] + rgba[offset + 1] + rgba[offset + 2] < 659) break;
    }
    x0 = Math.min(x0, left); y0 = Math.min(y0, y);
    x1 = Math.max(x1, right + 1); y1 = y + 1;
  }
  if (x1 <= x0) return { x: 0, y: 0, width, height, px: 0, py: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, px: Math.ceil(.3 * (y1 - y0)), py: Math.ceil(.2 * (y1 - y0)) };
}

export function packLines(lines, profile, width) {
  const { height, channels } = profile, plane = height * width;
  const tensor = new Float32Array(lines.length * channels * plane);
  for (let n = 0; n < lines.length; n++) for (let c = 0; c < channels; c++) {
    const offset = (n * channels + c) * plane;
    if (profile.id === 'crnn') tensor.fill(-profile.mean[c] / profile.std[c], offset, offset + plane);
    const line = lines[n];
    for (let y = 0; y < height; y++) for (let x = 0; x < line.width; x++) {
      const value = line.gray[y * line.width + x] / 255;
      tensor[offset + y * width + x] = profile.id === 'crnn' ? (value - profile.mean[c]) / profile.std[c] : 1 - value;
    }
  }
  return tensor;
}

export function decodeSequence(output, n, validSteps, labels, confidence = false) {
  const [, steps, classes] = output.dims, data = output.data;
  let previous = 0, text = '', total = 0, emissions = 0;
  for (let t = 0; t < Math.min(steps, validSteps); t++) {
    const offset = (n * steps + t) * classes;
    let best = 0, maximum = -Infinity;
    for (let c = 0; c < classes; c++) if (data[offset + c] > maximum) { maximum = data[offset + c]; best = c; }
    if (best && best !== previous) {
      text += labels[best] || '';
      if (confidence) {
        let sum = 0;
        for (let c = 0; c < classes; c++) sum += Math.exp(data[offset + c] - maximum);
        total += 1 / sum; emissions++;
      }
    }
    previous = best;
  }
  return confidence ? { text, confidence: emissions ? total / emissions : 0 } : { text };
}

export function decodeClassIds(output, n, validSteps, labels) {
  const steps = output.dims[1];
  let previous = 0, text = '';
  for (let t = 0; t < Math.min(steps, validSteps); t++) {
    const id = Number(output.data[n * steps + t]);
    if (id && id !== previous) text += labels[id] || '';
    previous = id;
  }
  return { text };
}

// The trained exports take NCHW images and unpadded widths, and return NTC logits.
// Keep this preparation and decoding identical in the main thread and workers.
export class LineRecognizer {
  constructor(ort, session, profile, labels) {
    Object.assign(this, { ort, session, profile, labels });
    this.canvas = new OffscreenCanvas(1, 1);
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.resized = new OffscreenCanvas(1, 1);
    this.resizeContext = this.resized.getContext('2d', { willReadFrequently: true });
    if(profile.gpuArgMax)this.argmax=new GpuArgMax(ort.env.webgpu.device,profile.gpuArgMax);
  }

  prepare(line, scale, timing) {
    const { canvas, context, resized, resizeContext, profile } = this;
    const source = line.source || line;
    let started=timing?performance.now():0;
    let box = { x: line.source ? line.x : 0, y: line.source ? line.y : 0, width: line.width, height: line.height, px: 0, py: 0 };
    if (profile.id === 'indra') {
      canvas.width=Math.max(1,Math.round(line.width));canvas.height=Math.max(1,Math.round(line.height));
      context.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
      const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
      if(timing)timing.crop_read_seconds=(timing.crop_read_seconds||0)+(performance.now()-started)/1000;
      started=timing?performance.now():0;
      box = inkBounds(pixels, canvas.width, canvas.height);
      if(timing)timing.ink_scan_seconds=(timing.ink_scan_seconds||0)+(performance.now()-started)/1000;
      box.x += line.source ? line.x : 0; box.y += line.source ? line.y : 0;
    }
    started=timing?performance.now():0;
    const width = Math.min(4096, Math.max(8, Math.round((box.width + box.px * 2) * profile.height / (box.height + box.py * 2) * scale)));
    resized.width = width; resized.height = profile.height;
    resizeContext.fillStyle = 'white'; resizeContext.fillRect(0, 0, width, profile.height);
    const sx = width / (box.width + box.px * 2), sy = profile.height / (box.height + box.py * 2);
    resizeContext.drawImage(source, box.x, box.y, box.width, box.height, box.px * sx, box.py * sy, box.width * sx, box.height * sy);
    const rgba = resizeContext.getImageData(0, 0, width, profile.height).data;
    if(timing)timing.resize_read_seconds=(timing.resize_read_seconds||0)+(performance.now()-started)/1000;
    started=timing?performance.now():0;
    const gray = new Uint8Array(width * profile.height);
    for (let i = 0; i < gray.length; i++) gray[i] = Math.round((rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3);
    if(timing)timing.gray_seconds=(timing.gray_seconds||0)+(performance.now()-started)/1000;
    return { width, gray };
  }

  prepareLines(lines, scale, timing) {
    return lines.map(line=>this.prepare(line,scale,timing));
  }

  preparePage(bitmap, lines, scale, timing) {
    const started = timing ? performance.now() : 0;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    try {
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
      if (timing) {
        const seconds = (performance.now() - started) / 1000;
        timing.page_copy_seconds = (timing.page_copy_seconds || 0) + seconds;
        timing.crop_pack_seconds = (timing.crop_pack_seconds || 0) + seconds;
      }
      const prepareStarted = timing ? performance.now() : 0;
      const prepared = this.prepareLines(lines.map(line => ({ ...line, source: canvas })), scale, timing);
      if (timing) timing.crop_pack_seconds += (performance.now() - prepareStarted) / 1000;
      return prepared;
    } finally { canvas.width = canvas.height = 1; }
  }

  async recognize(lines, scale = 1, options = {}) {
    const { timing } = options, started = timing ? performance.now() : 0;
    const prepared = this.prepareLines(lines, scale, timing);
    if (timing) timing.crop_pack_seconds = (timing.crop_pack_seconds || 0) + (performance.now() - started) / 1000;
    return this.recognizePrepared(prepared, options);
  }

  async recognizePrepared(lines, { batchSize = this.profile.batchSize, bucketSize = 24, sortedBatches = false, confidence = false, timing } = {}) {
    let started=timing?performance.now():0;
    const prepared = lines.map((line,index)=>({...line,index})), groups = new Map(), results = new Array(lines.length);
    if (sortedBatches) groups.set(0, prepared.sort((a, b) => a.width - b.width));
    else for (const line of prepared) {
      const key = Math.ceil(line.width / bucketSize);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }
    if(timing)timing.crop_pack_seconds+=(performance.now()-started)/1000;
    for (const group of groups.values()) for (let offset = 0; offset < group.length; offset += batchSize) {
      const batch = group.slice(offset, offset + batchSize), multiple = this.profile.widthMultiple || 8;
      const width = Math.ceil(Math.max(this.profile.minimum, ...batch.map(line => line.width)) / multiple) * multiple;
      const { ort } = this;
      started=timing?performance.now():0;
      const feeds={
        image: new ort.Tensor('float32', packLines(batch, this.profile, width), [batch.length, this.profile.channels, this.profile.height, width]),
        widths: new ort.Tensor('int64', BigInt64Array.from(batch, line => BigInt(line.width)), [batch.length]),
      };
      if(timing){const seconds=(performance.now()-started)/1000;timing.pack_seconds=(timing.pack_seconds||0)+seconds;timing.crop_pack_seconds+=seconds;}
      started=timing?performance.now():0;
      const custom=Boolean(this.argmax)&&!confidence;
      const ids = !confidence && (custom||this.session.outputNames.includes('class_ids'));
      let out;
      const dispose=()=>{for(const value of Object.values(out||{}))value.dispose();for(const value of Object.values(feeds))value.dispose()};
      try {
      out = await this.session.run(feeds, ids&&!custom ? ['class_ids', 'lengths'] : ['logits', 'lengths']);
      if(custom){
        const data=await this.argmax.run(out.logits);
        out.class_ids=new ort.Tensor('uint32',data,[batch.length,out.logits.dims[1]]);
      }
      if(timing)timing.model_seconds+=(performance.now()-started)/1000;
      if (timing) {
        this.inputShapes ||= new Set();
        const shape = `${batch.length}:${width}`;
        timing.new_input_shapes = (timing.new_input_shapes || 0) + Number(!this.inputShapes.has(shape));
        this.inputShapes.add(shape);
        timing.model_batches = (timing.model_batches || 0) + 1;
        timing.recognition_lines = (timing.recognition_lines || 0) + batch.length;
        timing.padded_pixels = (timing.padded_pixels || 0) + batch.length * width * this.profile.height;
        timing.used_pixels = (timing.used_pixels || 0) + batch.reduce((sum, line) => sum + line.width * this.profile.height, 0);
        timing.output_bytes = (timing.output_bytes || 0) + Object.values(out).reduce((sum, value) => sum + (value.location==='gpu-buffer'?0:value.data.byteLength), 0);
      }
      const decodeStarted=timing?performance.now():0;
      batch.forEach((line, n) => { results[line.index] = ids
        ? decodeClassIds(out.class_ids, n, Number(out.lengths.data[n]), this.labels)
        : decodeSequence(out.logits, n, Number(out.lengths.data[n]), this.labels, confidence); });
      if(timing)timing.decode_seconds+=(performance.now()-decodeStarted)/1000;
      }finally{dispose();}
    }
    return results;
  }
}
