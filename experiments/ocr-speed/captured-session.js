// Static GPU sessions retain buffers for command replay, with a bounded LRU cache.
export class CapturedSession {
  static async create(ort, model, options, batch, classes, capture, maxShapes=4) {
    const value=new CapturedSession();
    Object.assign(value,{ort,model,options,batch,classes,capture,maxShapes,slots:new Map(),bytes:0,createdSlots:0,buildSeconds:0,outputNames:['logits','lengths']});
    try{await value.slot(512)}catch(error){await value.release();throw error}
    return value;
  }

  async slot(width) {
    const previous=this.slots.get(width);
    if(previous){this.slots.delete(width);this.slots.set(width,previous);return previous}
    const bytes=this.batch*(32*width+Math.ceil(width/4)*(1+this.classes))*4;
    while(this.slots.size&&(this.slots.size>=this.maxShapes||this.bytes+bytes>256*1024*1024)){
      const [key,slot]=this.slots.entries().next().value;
      this.slots.delete(key);this.bytes-=slot.bytes;
      await this.releaseSlot(slot);
    }
    const slot=await this.createSlot(width);
    slot.bytes=bytes;this.bytes+=bytes;this.slots.set(width,slot);
    return slot;
  }

  async createSlot(width) {
    const started=performance.now();
    const {ort,batch,classes,capture}=this,steps=Math.ceil(width/4);
    const session=await ort.InferenceSession.create(this.model,{...this.options,executionProviders:['webgpu'],
      enableGraphCapture:capture,preferredOutputLocation:{logits:'gpu-buffer'},freeDimensionOverrides:{batch,width,steps}});
    const device=ort.env.webgpu.device,buffers=[];
    const tensor=dims=>{
      const size=dims.reduce((a,b)=>a*b,4),buffer=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
      buffers.push(buffer);return ort.Tensor.fromGpuBuffer(buffer,{dataType:'float32',dims});
    };
    try{
      const slot={session,device,width,steps,buffers,image:tensor([batch,1,32,width]),mask:tensor([batch,1,1,steps]),logits:tensor([batch,steps,classes])};
      this.createdSlots++;this.buildSeconds+=(performance.now()-started)/1000;
      return slot;
    }
    catch(error){for(const buffer of buffers)buffer.destroy();await session.release();throw error}
  }

  async run(feeds) {
    const actual=feeds.image.dims[0],width=feeds.image.dims[3],slot=await this.slot(width);
    const {device,steps}=slot;
    if(actual>this.batch)throw Error('Capture batch exceeds its fixed session size');
    if(feeds.image.location==='gpu-buffer'&&feeds.image.gpuBuffer!==slot.image.gpuBuffer){
      const commands=device.createCommandEncoder();
      commands.copyBufferToBuffer(feeds.image.gpuBuffer,0,slot.image.gpuBuffer,0,actual*32*width*4);
      device.queue.submit([commands.finish()]);
    }else if(feeds.image.location!=='gpu-buffer')device.queue.writeBuffer(slot.image.gpuBuffer,0,feeds.image.data);
    const mask=new Float32Array(this.batch*steps),counts=BigInt64Array.from(feeds.widths.data,value=>(value+3n)/4n);
    for(let n=0;n<actual;n++)mask.fill(1,n*steps,n*steps+Number(counts[n]));
    device.queue.writeBuffer(slot.mask.gpuBuffer,0,mask);
    await slot.session.run({image:slot.image,mask:slot.mask},{logits:slot.logits});
    // The session retains these buffers for command replay; the consumer releases
    // only its small CPU IDs/lengths after the GPU ArgMax has finished reading.
    return {logits:{dims:[actual,steps,this.classes],location:'gpu-buffer',gpuBuffer:slot.logits.gpuBuffer,dispose(){}},
      lengths:new this.ort.Tensor('int64',counts,[actual])};
  }

  async inputTensor(width, actual) {
    const slot=await this.slot(width);
    return this.ort.Tensor.fromGpuBuffer(slot.image.gpuBuffer,{dataType:'float32',dims:[actual,1,32,width]});
  }

  async release() {
    const slots=[...this.slots.values()];this.slots.clear();this.bytes=0;
    const results=await Promise.allSettled(slots.map(slot=>this.releaseSlot(slot)));
    const failed=results.find(result=>result.status==='rejected');
    if(failed)throw failed.reason;
  }

  async releaseSlot(slot) {
    try{await slot.session.release()}finally{for(const buffer of slot.buffers)buffer.destroy()}
  }
}
