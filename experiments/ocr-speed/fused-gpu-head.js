// Experimental full-alphabet classifier: reduce eight timesteps in registers.
export class FusedGpuHead {
  static async create(device, binary, {margins = false, partitioned = true, reuseBuffers = false, packedWeights = false} = {}) {
    const [channels, classes, half] = new Uint32Array(binary, 0, 4);
    if (![64, 128].includes(channels) || !classes || binary.byteLength !== 16 + (channels + 1) * classes * 4) throw Error('Invalid classifier asset');
    if (packedWeights && !half) throw Error('Packed classifier weights require an FP16 model');
    const partitions = partitioned ? Math.ceil(classes / 64) : 1;
    const value = new FusedGpuHead(); Object.assign(value, {device, channels, classes, margins, partitions, reuseBuffers, packedWeights, workspaceAllocations: 0, buffers: []});
    const make = bytes => { const buffer = device.createBuffer({size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}); value.buffers.push(buffer); return buffer; };
    try {
      value.weight = make(channels * classes * (packedWeights ? 2 : 4)); value.bias = make(classes * 4);
      if (packedWeights) {
        const upload = device.createBuffer({size: channels * classes * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
        try {
          device.queue.writeBuffer(upload, 0, binary, 16, channels * classes * 4);
          const packing = device.createShaderModule({code: `
@group(0) @binding(0) var<storage,read> source:array<f32>;
@group(0) @binding(1) var<storage,read_write> halves:array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) item:vec3<u32>){
  let index=item.x*2u;if(index>=${channels * classes}u){return;}
  halves[item.x]=pack2x16float(vec2<f32>(source[index],source[index+1u]));
}`});
          const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module: packing, entryPoint: 'main'}});
          const bindings = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
            {binding: 0, resource: {buffer: upload}}, {binding: 1, resource: {buffer: value.weight}},
          ]});
          const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
          pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(Math.ceil(channels * classes / 128)); pass.end();
          device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
        } finally { upload.destroy(); }
      } else device.queue.writeBuffer(value.weight, 0, binary, 16, channels * classes * 4);
      device.queue.writeBuffer(value.bias, 0, binary, 16 + channels * classes * 4, classes * 4);
      const module = device.createShaderModule({code: shader(channels, classes, Boolean(half), margins, partitions, packedWeights)});
      const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error');
      if (errors.length) throw Error(errors.map(message => `${message.lineNum}: ${message.message}`).join('\n'));
      value.pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}});
      if (partitions > 1) value.combine = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'combine'}});
      return value;
    } catch (error) { value.release(); throw error; }
  }

  release() {
    for (const buffer of this.buffers.splice(0)) buffer.destroy();
    for (const buffer of this.workspace?.buffers || []) buffer.destroy();
    this.workspace = undefined;
  }

  acquire(rows) {
    if (this.reuseBuffers && this.workspace && !this.workspace.busy && this.workspace.rows >= rows) {
      this.workspace.busy = true;
      return this.workspace;
    }
    const {device} = this, buffers = [];
    const make = (size, usage) => { const buffer = device.createBuffer({size, usage}); buffers.push(buffer); return buffer; };
    try {
      const output = make(rows * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const readback = make(rows * 8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      const uniform = make(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const partial = this.partitions > 1 ? make(rows * this.partitions * 16, GPUBufferUsage.STORAGE) : output;
      const state = {rows, output, readback, uniform, partial, buffers, busy: true};
      this.workspaceAllocations++;
      // Retain one bounded workspace; concurrent calls own separate temporary buffers.
      if (this.reuseBuffers && !this.workspace?.busy && buffers.reduce((sum, buffer) => sum + buffer.size, 0) <= 16 * 1024 * 1024) {
        for (const buffer of this.workspace?.buffers || []) buffer.destroy();
        this.workspace = state;
      }
      return state;
    } catch (error) { for (const buffer of buffers) buffer.destroy(); throw error; }
  }

  async run(features, actual = features.dims[0]) {
    const {device, pipeline} = this, steps = features.dims.at(-1), rows = actual * steps;
    const groups = actual * Math.ceil(steps / 8), x = Math.min(groups, device.limits.maxComputeWorkgroupsPerDimension);
    const state = this.acquire(rows), {output, readback, uniform, partial} = state;
    try {
      device.queue.writeBuffer(uniform, 0, new Uint32Array([steps, groups, x, 0, rows, 0, 0, 0]));
      const bindings = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
        {binding: 0, resource: {buffer: features.gpuBuffer}}, {binding: 1, resource: {buffer: this.weight}},
        {binding: 2, resource: {buffer: this.bias}}, {binding: 3, resource: {buffer: partial}}, {binding: 4, resource: {buffer: uniform}},
      ]});
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(x, Math.ceil(groups / x), this.partitions); pass.end();
      if (this.combine) {
        const bind = device.createBindGroup({layout: this.combine.getBindGroupLayout(0), entries: [
          {binding: 3, resource: {buffer: partial}}, {binding: 4, resource: {buffer: uniform}}, {binding: 5, resource: {buffer: output}},
        ]});
        const reduce = encoder.beginComputePass(); reduce.setPipeline(this.combine); reduce.setBindGroup(0, bind); reduce.dispatchWorkgroups(Math.ceil(rows / 64)); reduce.end();
      }
      encoder.copyBufferToBuffer(output, 0, readback, 0, rows * 8); device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ, 0, rows * 8);
      const bytes = readback.getMappedRange(0, rows * 8), words = new Uint32Array(bytes), floats = new Float32Array(bytes);
      return {ids: Uint32Array.from({length: rows}, (_, index) => words[index * 2]),
        margins: this.margins ? Float32Array.from({length: rows}, (_, index) => floats[index * 2 + 1]) : undefined};
    } catch (error) {
      if (this.workspace === state) this.workspace = undefined;
      throw error;
    } finally {
      if (readback.mapState === 'mapped') readback.unmap();
      state.busy = false;
      if (this.workspace !== state) for (const buffer of state.buffers) buffer.destroy();
    }
  }
}

function shader(channels, classes, half, margins, partitions, packedWeights) {
  const write = (row, suffix) => partitions > 1
    ? `result[(${row})*${partitions}u+group.z]=vec4<u32>(ids${suffix}[0][j],bitcast<u32>(best${suffix}[0][j]),${margins ? `bitcast<u32>(second${suffix}[0][j])` : '0u'},0u);`
    : `result[${row}]=vec2<u32>(ids${suffix}[0][j],${margins ? `bitcast<u32>(best${suffix}[0][j]-second${suffix}[0][j])` : '0u'});`;
  return `
@group(0) @binding(0) var<storage,read> features:array<f32>;
@group(0) @binding(1) var<storage,read> weights:array<${packedWeights ? 'u32' : 'f32'}>;
@group(0) @binding(2) var<storage,read> biases:array<f32>;
@group(0) @binding(3) var<storage,read_write> result:array<${partitions > 1 ? 'vec4' : 'vec2'}<u32>>;
struct Shape { main:vec4<u32>, extra:vec4<u32> };
@group(0) @binding(4) var<uniform> dimensions:Shape;
${partitions > 1 ? '@group(0) @binding(5) var<storage,read_write> finalResult:array<vec2<u32>>;' : ''}
var<workgroup> tile:array<vec4<f32>,${channels * 2}>;
var<workgroup> best0:array<vec4<f32>,64>;
var<workgroup> best1:array<vec4<f32>,64>;
var<workgroup> ids0:array<vec4<u32>,64>;
var<workgroup> ids1:array<vec4<u32>,64>;
${margins ? 'var<workgroup> second0:array<vec4<f32>,64>; var<workgroup> second1:array<vec4<f32>,64>;' : ''}
fn rounded(value:vec4<f32>)->vec4<f32>{
  ${half ? 'return vec4<f32>(unpack2x16float(pack2x16float(value.xy)),unpack2x16float(pack2x16float(value.zw)));' : 'return value;'}
}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_id) local:vec3<u32>){
  let shape=dimensions.main;
  let block=group.x+group.y*shape.z;if(block>=shape.y){return;}
  let lane=local.x;let blocks=(shape.x+7u)/8u;let batch=block/blocks;let first=(block%blocks)*8u;
  for(var c=lane;c<${channels}u;c+=64u){
    var a=vec4<f32>(0.0);var b=a;
    for(var j=0u;j<4u;j++){
      if(first+j<shape.x){a[j]=features[(batch*${channels}u+c)*shape.x+first+j];}
      if(first+j+4u<shape.x){b[j]=features[(batch*${channels}u+c)*shape.x+first+j+4u];}
    }
    tile[c*2u]=a;tile[c*2u+1u]=b;
  }
  workgroupBarrier();
  var maximum0=vec4<f32>(-3.402823e38);var maximum1=maximum0;
  var index0=vec4<u32>(0u);var index1=index0;
  ${margins ? 'var runner0=maximum0;var runner1=maximum0;' : ''}
  for(var klass=lane${partitions > 1 ? '+group.z*64u' : ''};klass<${partitions > 1 ? `min(${classes}u,(group.z+1u)*64u)` : `${classes}u`};klass+=64u){
    var a=vec4<f32>(0.0);var b=a;
    for(var c=0u;c<${channels}u;c++){
      let offset=c*${classes}u+klass;
      let weight=${packedWeights ? 'unpack2x16float(weights[offset/2u])[offset%2u]' : 'weights[offset]'};a=a+tile[c*2u]*weight;b=b+tile[c*2u+1u]*weight;
    }
    a=rounded(a+vec4<f32>(biases[klass]));b=rounded(b+vec4<f32>(biases[klass]));
    let take0=(a>maximum0)|((a==maximum0)&(vec4<u32>(klass)<index0));
    let take1=(b>maximum1)|((b==maximum1)&(vec4<u32>(klass)<index1));
    ${margins ? 'runner0=max(runner0,select(a,maximum0,take0));runner1=max(runner1,select(b,maximum1,take1));' : ''}
    maximum0=select(maximum0,a,take0);maximum1=select(maximum1,b,take1);
    index0=select(index0,vec4<u32>(klass),take0);index1=select(index1,vec4<u32>(klass),take1);
  }
  best0[lane]=maximum0;best1[lane]=maximum1;ids0[lane]=index0;ids1[lane]=index1;
  ${margins ? 'second0[lane]=runner0;second1[lane]=runner1;' : ''}
  workgroupBarrier();
  for(var stride=32u;stride>0u;stride/=2u){
    if(lane<stride){
      let other=lane+stride;
      let take0=(best0[other]>best0[lane])|((best0[other]==best0[lane])&(ids0[other]<ids0[lane]));
      let take1=(best1[other]>best1[lane])|((best1[other]==best1[lane])&(ids1[other]<ids1[lane]));
      ${margins ? 'second0[lane]=max(max(second0[lane],second0[other]),select(best0[other],best0[lane],take0));second1[lane]=max(max(second1[lane],second1[other]),select(best1[other],best1[lane],take1));' : ''}
      best0[lane]=select(best0[lane],best0[other],take0);best1[lane]=select(best1[lane],best1[other],take1);
      ids0[lane]=select(ids0[lane],ids0[other],take0);ids1[lane]=select(ids1[lane],ids1[other],take1);
    }
    workgroupBarrier();
  }
  if(lane==0u){for(var j=0u;j<4u;j++){
    if(first+j<shape.x){${write('batch*shape.x+first+j', 0)}}
    if(first+j+4u<shape.x){${write('batch*shape.x+first+j+4u', 1)}}
  }}
}
${partitions > 1 ? `
@compute @workgroup_size(64)
fn combine(@builtin(global_invocation_id) item:vec3<u32>){
  let row=item.x;if(row>=dimensions.extra.x){return;}
  var maximum=-3.402823e38;var runner=maximum;var index=0u;
  for(var part=0u;part<${partitions}u;part++){
    let value=result[row*${partitions}u+part];let score=bitcast<f32>(value.y);
    let take=score>maximum||(score==maximum&&value.x<index);
    ${margins ? 'runner=max(max(runner,bitcast<f32>(value.z)),select(score,maximum,take));' : ''}
    maximum=select(maximum,score,take);index=select(index,value.x,take);
  }
  finalResult[row]=vec2<u32>(index,${margins ? 'bitcast<u32>(maximum-runner)' : '0u'});
}` : ''}`;
}
