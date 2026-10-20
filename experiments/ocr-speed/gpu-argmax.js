export class GpuArgMax {
  constructor(device, workgroupSize=128) {
    if(![64,128,256].includes(workgroupSize))throw Error('ArgMax workgroup must be 64, 128 or 256');
    this.device=device;
    const module=device.createShaderModule({code:`
      @group(0) @binding(0) var<storage,read> logits:array<f32>;
      @group(0) @binding(1) var<storage,read_write> ids:array<u32>;
      @group(0) @binding(2) var<uniform> shape:vec4<u32>;
      var<workgroup> values:array<f32,${workgroupSize}>;
      var<workgroup> indices:array<u32,${workgroupSize}>;
      @compute @workgroup_size(${workgroupSize})
      fn main(@builtin(workgroup_id) groupId:vec3<u32>,@builtin(local_invocation_id) laneId:vec3<u32>){
        let row=groupId.x+groupId.y*shape.z;
        if(row>=shape.y){return;}
        let lane=laneId.x;
        var best=logits[row*shape.x];
        var index=0u;
        for(var c=lane;c<shape.x;c+=${workgroupSize}u){
          let value=logits[row*shape.x+c];
          if(value>best||(value==best&&c<index)){best=value;index=c;}
        }
        values[lane]=best;indices[lane]=index;
        workgroupBarrier();
        for(var stride=${workgroupSize/2}u;stride>0u;stride/=2u){
          if(lane<stride){
            let other=values[lane+stride];let otherIndex=indices[lane+stride];
            if(other>values[lane]||(other==values[lane]&&otherIndex<indices[lane])){
              values[lane]=other;indices[lane]=otherIndex;
            }
          }
          workgroupBarrier();
        }
        if(lane==0u){ids[row]=indices[0];}
      }`});
    this.pipeline=module.getCompilationInfo().then(info=>{
      const errors=info.messages.filter(message=>message.type==='error');
      if(errors.length)throw Error(errors.map(message=>`${message.lineNum}: ${message.message}`).join('\n'));
      return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    });
  }

  async run(tensor) {
    const {device}=this,pipeline=await this.pipeline;
    const classes=tensor.dims.at(-1),rows=tensor.dims.slice(0,-1).reduce((a,b)=>a*b,1);
    const bytes=rows*4,x=Math.min(rows,device.limits.maxComputeWorkgroupsPerDimension);
    const output=device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const readback=device.createBuffer({size:bytes,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    const uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    try{
      device.queue.writeBuffer(uniform,0,new Uint32Array([classes,rows,x,0]));
      const bindings=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:tensor.gpuBuffer}},
        {binding:1,resource:{buffer:output}},
        {binding:2,resource:{buffer:uniform}},
      ]});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
      pass.setPipeline(pipeline);pass.setBindGroup(0,bindings);pass.dispatchWorkgroups(x,Math.ceil(rows/x));pass.end();
      encoder.copyBufferToBuffer(output,0,readback,0,bytes);device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      return new Uint32Array(readback.getMappedRange().slice(0));
    }finally{
      if(readback.mapState==='mapped')readback.unmap();
      uniform.destroy();readback.destroy();output.destroy();
    }
  }
}
