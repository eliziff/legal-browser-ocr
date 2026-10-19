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
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    if (Math.round((rgba[offset] + rgba[offset + 1] + rgba[offset + 2]) / 3) < 220) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
    }
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
  }

  prepare(line, scale) {
    const { canvas, context, resized, resizeContext, profile } = this;
    const source = line.source || line;
    let box = { x: line.source ? line.x : 0, y: line.source ? line.y : 0, width: line.width, height: line.height, px: 0, py: 0 };
    if (profile.id === 'indra') {
      canvas.width = Math.max(1, Math.round(line.width)); canvas.height = Math.max(1, Math.round(line.height));
      context.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
      box = inkBounds(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      box.x += line.source ? line.x : 0; box.y += line.source ? line.y : 0;
    }
    const width = Math.min(4096, Math.max(8, Math.round((box.width + box.px * 2) * profile.height / (box.height + box.py * 2) * scale)));
    resized.width = width; resized.height = profile.height;
    resizeContext.fillStyle = 'white'; resizeContext.fillRect(0, 0, width, profile.height);
    const sx = width / (box.width + box.px * 2), sy = profile.height / (box.height + box.py * 2);
    resizeContext.drawImage(source, box.x, box.y, box.width, box.height, box.px * sx, box.py * sy, box.width * sx, box.height * sy);
    const rgba = resizeContext.getImageData(0, 0, width, profile.height).data;
    const gray = new Uint8Array(width * profile.height);
    for (let i = 0; i < gray.length; i++) gray[i] = Math.round((rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3);
    return { width, gray };
  }

  async recognize(lines, scale = 1, { batchSize = this.profile.batchSize, bucketSize = 24, sortedBatches = false, confidence = false, timing } = {}) {
    let started=timing?performance.now():0;
    const prepared = lines.map((line, index) => ({ ...this.prepare(line, scale), index })), groups = new Map(), results = new Array(lines.length);
    if (sortedBatches) groups.set(0, prepared.sort((a, b) => a.width - b.width));
    else for (const line of prepared) {
      const key = Math.ceil(line.width / bucketSize);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }
    if(timing)timing.crop_pack_seconds+=(performance.now()-started)/1000;
    for (const group of groups.values()) for (let offset = 0; offset < group.length; offset += batchSize) {
      const batch = group.slice(offset, offset + batchSize), width = Math.ceil(Math.max(this.profile.minimum, ...batch.map(line => line.width)) / 8) * 8;
      const { ort } = this;
      started=timing?performance.now():0;
      const feeds={
        image: new ort.Tensor('float32', packLines(batch, this.profile, width), [batch.length, this.profile.channels, this.profile.height, width]),
        widths: new ort.Tensor('int64', BigInt64Array.from(batch, line => BigInt(line.width)), [batch.length]),
      };
      if(timing)timing.crop_pack_seconds+=(performance.now()-started)/1000;
      started=timing?performance.now():0;
      const ids = !confidence && this.session.outputNames.includes('class_ids');
      const out = await this.session.run(feeds, ids ? ['class_ids', 'lengths'] : ['logits', 'lengths']);
      try {
      if(timing)timing.model_seconds+=(performance.now()-started)/1000;
      if (timing) {
        timing.model_batches = (timing.model_batches || 0) + 1;
        timing.recognition_lines = (timing.recognition_lines || 0) + batch.length;
        timing.padded_pixels = (timing.padded_pixels || 0) + batch.length * width * this.profile.height;
        timing.used_pixels = (timing.used_pixels || 0) + batch.reduce((sum, line) => sum + line.width * this.profile.height, 0);
        timing.output_bytes = (timing.output_bytes || 0) + Object.values(out).reduce((sum, value) => sum + value.data.byteLength, 0);
      }
      started=timing?performance.now():0;
      batch.forEach((line, n) => { results[line.index] = ids
        ? decodeClassIds(out.class_ids, n, Number(out.lengths.data[n]), this.labels)
        : decodeSequence(out.logits, n, Number(out.lengths.data[n]), this.labels, confidence); });
      } finally { for (const value of Object.values(out)) value.dispose(); for (const value of Object.values(feeds)) value.dispose(); }
      if(timing)timing.decode_seconds+=(performance.now()-started)/1000;
    }
    return results;
  }
}
