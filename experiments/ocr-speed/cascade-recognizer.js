import {CapturedSession} from './captured-session.js';
import {GpuMarginArgMax} from './gpu-margin-argmax.js';
import {LineRecognizer} from '../../recognizer.js';
import {needsTeacher} from './cascade-policy.js';

class MarginSession {
  constructor(ort, base, reduction) { Object.assign(this, {ort, base, reduction, batch: base.batch, outputNames: ['class_ids', 'lengths']}); }
  get createdSlots() { return this.base.createdSlots; }
  get buildSeconds() { return this.base.buildSeconds; }
  inputTensor(...args) { return this.base.inputTensor(...args); }
  async run(feeds) {
    const out = await this.base.run(feeds);
    try {
      const {ids, margins} = await this.reduction.run(out.logits), dims = out.logits.dims.slice(0, -1);
      return {class_ids: new this.ort.Tensor('uint32', ids, dims), margins: new this.ort.Tensor('float32', margins, dims), lengths: out.lengths};
    } catch (error) { out.lengths.dispose(); throw error; }
    finally { out.logits.dispose(); }
  }
  release() { return this.base.release(); }
}

export class CascadeRecognizer {
  static async create(ort, teacher, labels, settings, batchSize) {
    const response = await fetch(settings.smallModel); if (!response.ok) throw Error('Missing small recognizer asset');
    const model = new Uint8Array(await response.arrayBuffer());
    const base = await CapturedSession.create(ort, model, settings.sessionOptions, batchSize, teacher.session.classes, settings.captureEnabled, settings.gpuCacheShapes);
    try {
      const reduction = await GpuMarginArgMax.create(ort.env.webgpu.device);
      const session = new MarginSession(ort, base, reduction), small = new LineRecognizer(ort, session, {...teacher.profile, gpuArgMax: 0}, labels);
      small.gpuPreparer = teacher.gpuPreparer;
      const value = new CascadeRecognizer(); Object.assign(value, {small, teacher, policy: settings.policy}); return value;
    } catch (error) { await base.release(); throw error; }
  }

  async recognizePrepared(lines, options) {
    const timing = options.timing, before = timing?.model_batches || 0;
    const result = await this.small.recognizePrepared(lines, options);
    const smallBatches = (timing?.model_batches || 0) - before;
    const indices = result.flatMap((line, index) => needsTeacher(line.cascadeScore, this.policy) ? [index] : []);
    const revised = indices.length ? await this.teacher.recognizePrepared(indices.map(index => lines[index]), options) : [];
    indices.forEach((index, n) => { result[index] = revised[n]; });
    if (timing) {
      timing.frontier_cascade_lines = lines.length; timing.frontier_teacher_retry_lines = indices.length;
      timing.frontier_small_batches = smallBatches; timing.frontier_teacher_batches = timing.model_batches - before - smallBatches;
    }
    return result;
  }
}
