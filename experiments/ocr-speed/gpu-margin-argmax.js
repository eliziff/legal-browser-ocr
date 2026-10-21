export class GpuMarginArgMax {
  static async create(device) {
    const value = new GpuMarginArgMax(); value.device = device;
    const module = device.createShaderModule({code: `
@group(0) @binding(0) var<storage,read> logits:array<f32>;
@group(0) @binding(1) var<storage,read_write> result:array<vec2<u32>>;
@group(0) @binding(2) var<uniform> shape:vec4<u32>;
var<workgroup> maxima:array<f32,128>;
var<workgroup> runners:array<f32,128>;
var<workgroup> indices:array<u32,128>;
@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_id) local:vec3<u32>){
  let row=group.x+group.y*shape.z;if(row>=shape.y){return;}let lane=local.x;
  var best=-3.402823e38;var runner=best;var index=0u;
  for(var c=lane;c<shape.x;c+=128u){
    let score=logits[row*shape.x+c];let take=score>best||(score==best&&c<index);
    runner=max(runner,select(score,best,take));best=select(best,score,take);index=select(index,c,take);
  }
  maxima[lane]=best;runners[lane]=runner;indices[lane]=index;workgroupBarrier();
  for(var stride=64u;stride>0u;stride/=2u){
    if(lane<stride){let other=lane+stride;let take=maxima[other]>maxima[lane]||(maxima[other]==maxima[lane]&&indices[other]<indices[lane]);
      runners[lane]=max(max(runners[lane],runners[other]),select(maxima[other],maxima[lane],take));
      maxima[lane]=select(maxima[lane],maxima[other],take);indices[lane]=select(indices[lane],indices[other],take);
    }workgroupBarrier();
  }
  if(lane==0u){result[row]=vec2<u32>(indices[0],bitcast<u32>(maxima[0]-runners[0]));}
}`});
    const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error');
    if (errors.length) throw Error(errors.map(message => message.message).join('\n'));
    value.pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}});
    return value;
  }

  async run(tensor) {
    const {device, pipeline} = this, classes = tensor.dims.at(-1), rows = tensor.dims.slice(0, -1).reduce((a, b) => a * b, 1);
    const x = Math.min(rows, device.limits.maxComputeWorkgroupsPerDimension), buffers = [];
    const make = (size, usage) => { const value = device.createBuffer({size, usage}); buffers.push(value); return value; };
    let readback;
    try {
      const output = make(rows * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      readback = make(rows * 8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      const uniform = make(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(uniform, 0, new Uint32Array([classes, rows, x, 0]));
      const bindings = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
        {binding: 0, resource: {buffer: tensor.gpuBuffer}}, {binding: 1, resource: {buffer: output}}, {binding: 2, resource: {buffer: uniform}},
      ]});
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(x, Math.ceil(rows / x)); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, rows * 8); device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
      const bytes = readback.getMappedRange(), words = new Uint32Array(bytes), floats = new Float32Array(bytes);
      return {ids: Uint32Array.from({length: rows}, (_, i) => words[i * 2]), margins: Float32Array.from({length: rows}, (_, i) => floats[i * 2 + 1])};
    } finally { if (readback?.mapState === 'mapped') readback.unmap(); for (const buffer of buffers) buffer.destroy(); }
  }
}
