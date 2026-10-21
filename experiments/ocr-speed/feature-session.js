import {CapturedSession} from './captured-session.js';

export class FeatureSession extends CapturedSession {
  static async create(ort, model, options, batch, capture, maxShapes, head) {
    const value = new FeatureSession();
    Object.assign(value, {ort, model, options, batch, capture, maxShapes, head, classes: head.channels,
      slots: new Map(), bytes: 0, createdSlots: 0, buildSeconds: 0, outputNames: ['class_ids', 'lengths']});
    try { await value.slot(512); return value; } catch (error) { await value.release(); throw error; }
  }

  async createSlot(width) {
    const started = performance.now(), {ort, batch, classes, capture} = this, steps = Math.ceil(width / 4);
    const session = await ort.InferenceSession.create(this.model, {...this.options, executionProviders: ['webgpu'],
      enableGraphCapture: capture, preferredOutputLocation: {features: 'gpu-buffer'}, freeDimensionOverrides: {batch, width, steps}});
    const device = ort.env.webgpu.device, buffers = [];
    const tensor = dims => {
      const buffer = device.createBuffer({size: dims.reduce((a, b) => a * b, 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
      buffers.push(buffer); return ort.Tensor.fromGpuBuffer(buffer, {dataType: 'float32', dims});
    };
    try {
      const image = tensor([batch, 1, 32, width]), mask = tensor([batch, 1, 1, steps]), logits = tensor([batch, classes, 1, steps]);
      const wrapped = {run: feeds => session.run(feeds, {features: logits}), release: () => session.release()};
      this.createdSlots++; this.buildSeconds += (performance.now() - started) / 1000;
      return {session: wrapped, device, width, steps, buffers, image, mask, logits};
    } catch (error) { buffers.forEach(buffer => buffer.destroy()); await session.release(); throw error; }
  }

  async run(feeds) {
    const out = await super.run(feeds), actual = feeds.image.dims[0], steps = out.logits.dims[1];
    try {
      const result = await this.head.run({gpuBuffer: out.logits.gpuBuffer, dims: [actual, this.classes, 1, steps]});
      return {class_ids: new this.ort.Tensor('uint32', result.ids, [actual, steps]), lengths: out.lengths,
        ...(result.margins && {margins: new this.ort.Tensor('float32', result.margins, [actual, steps])})};
    } catch (error) { out.lengths.dispose(); throw error; }
  }

  async release() { try { await super.release(); } finally { this.head.release(); } }
}
