// Experimental bounded overlap: submit the next batch while class IDs download.
export async function enqueueIds(argmax, tensor) {
  const {device} = argmax, pipeline = await argmax.pipeline;
  const classes = tensor.dims.at(-1), rows = tensor.dims.slice(0, -1).reduce((a, b) => a * b, 1);
  const bytes = rows * 4, x = Math.min(rows, device.limits.maxComputeWorkgroupsPerDimension), buffers = [];
  const make = (size, usage) => { const value = device.createBuffer({size, usage}); buffers.push(value); return value; };
  let readback;
  const release = () => {
    if (readback?.mapState === 'mapped') readback.unmap();
    for (const buffer of buffers) buffer.destroy();
  };
  try {
    const output = make(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    readback = make(bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const uniform = make(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(uniform, 0, new Uint32Array([classes, rows, x, 0]));
    const bindings = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
      {binding: 0, resource: {buffer: tensor.gpuBuffer}}, {binding: 1, resource: {buffer: output}},
      {binding: 2, resource: {buffer: uniform}},
    ]});
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(x, Math.ceil(rows / x)); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes); device.queue.submit([encoder.finish()]);
    // Capture failures immediately; draining pending work owns propagation and cleanup.
    return {result: readback.mapAsync(GPUMapMode.READ).then(() => ({data: new Uint32Array(readback.getMappedRange().slice(0))})).catch(error => ({error})).finally(release)};
  } catch (error) { release(); throw error; }
}

export async function recognizeQueued(recognizer, lines, decodeClassIds, {batchSize, timing}, depth) {
  const {ort, session, profile} = recognizer;
  const prepared = lines.map((line, index) => ({...line, index})).sort((a, b) => a.width - b.width);
  const results = new Array(lines.length), pending = [];
  async function drain() {
    const item = pending.shift(), started = performance.now();
    try {
      const {data, error} = await item.ids;
      if (timing) timing.model_seconds += (performance.now() - started) / 1000;
      if (error) throw error;
      const decodeStarted = performance.now();
      const tensor = new ort.Tensor('uint32', data, [item.batch.length, item.steps]);
      try { item.batch.forEach((line, n) => { results[line.index] = decodeClassIds(tensor, n, Number(item.out.lengths.data[n]), recognizer.labels); }); }
      finally { tensor.dispose(); }
      if (timing) timing.decode_seconds += (performance.now() - decodeStarted) / 1000;
    } finally { item.release(); }
  }
  try {
    for (let offset = 0; offset < prepared.length; offset += batchSize) {
      const batch = prepared.slice(offset, offset + batchSize), multiple = profile.widthMultiple || 8;
      const width = Math.ceil(Math.max(profile.minimum, ...batch.map(line => line.width)) / multiple) * multiple;
      const previousBuilds = session.createdSlots || 0, previousBuildSeconds = session.buildSeconds || 0;
      const packStarted = performance.now();
      const packed = recognizer.gpuPreparer.pack(batch, width);
      const feeds = {image: packed.tensor, widths: new ort.Tensor('int64', BigInt64Array.from(batch, line => BigInt(line.width)), [batch.length])};
      let out, retained = false;
      const release = () => { for (const tensor of Object.values(out || {})) tensor.dispose(); feeds.widths.dispose(); packed.release(); };
      try {
        if (timing) { const seconds = (performance.now() - packStarted) / 1000; timing.pack_seconds = (timing.pack_seconds || 0) + seconds; timing.crop_pack_seconds += seconds; }
        const started = performance.now();
        out = await session.run(feeds, ['logits', 'lengths']);
        // The reduction/copy enters the same GPU queue before its logits buffer is reused.
        // Wait only for command submission, not for the mapped result.
        const ticket = await enqueueIds(recognizer.argmax, out.logits);
        if (timing) {
          timing.model_seconds += (performance.now() - started) / 1000;
          timing.gpu_session_builds = (timing.gpu_session_builds || 0) + session.createdSlots - previousBuilds;
          timing.gpu_session_build_seconds = (timing.gpu_session_build_seconds || 0) + session.buildSeconds - previousBuildSeconds;
          recognizer.inputShapes ||= new Set(); const shape = `${batch.length}:${width}`;
          timing.new_input_shapes = (timing.new_input_shapes || 0) + Number(!recognizer.inputShapes.has(shape)); recognizer.inputShapes.add(shape);
          for (const [key, value] of Object.entries({model_batches: 1, recognition_lines: batch.length,
            executed_lines: session.batch, executed_pixels: session.batch * width * profile.height,
            padded_pixels: batch.length * width * profile.height,
            used_pixels: batch.reduce((sum, line) => sum + line.width * profile.height, 0), output_bytes: out.lengths.data.byteLength + batch.length * out.logits.dims[1] * 4})) timing[key] = (timing[key] || 0) + value;
        }
        pending.push({batch, out, steps: out.logits.dims[1], ids: ticket.result, release}); retained = true;
      } finally { if (!retained) release(); }
      if (pending.length >= depth) await drain();
    }
    while (pending.length) await drain();
    return results;
  } finally { while (pending.length) { try { await drain(); } catch { /* Preserve the original inference failure. */ } } }
}
