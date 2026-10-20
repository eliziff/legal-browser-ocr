const shader=`
@group(0) @binding(0) var image:texture_2d_array<f32>;
@group(0) @binding(1) var linearSampler:sampler;
@group(0) @binding(2) var<storage,read> boxes:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read_write> output:array<f32>;
@group(0) @binding(4) var<uniform> shape:vec4<u32>;
var<workgroup> bounds:array<vec4<u32>,64>;
fn samplePixel(position:vec2<f32>,layer:i32)->vec3<f32>{
  return floor(textureSampleLevel(image,linearSampler,position/vec2<f32>(textureDimensions(image)),layer,0.0).rgb*255.0+vec3<f32>(0.5));
}
@compute @workgroup_size(64)
fn ink(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_id) lane:vec3<u32>){
  let line=group.x;if(line>=shape.x){return;}
  let source=boxes[line*2u];let sizes=boxes[line*2u+1u];
  let w=u32(sizes.x);let h=u32(sizes.y);
  var found=vec4<u32>(w,h,0u,0u);
  for(var i=lane.x;i<w*h;i+=64u){
    let pixel=vec2<u32>(i%w,i/w);
    let rgb=samplePixel(source.xy+(vec2<f32>(pixel)+vec2<f32>(0.5))*source.zw/vec2<f32>(f32(w),f32(h)),i32(sizes.z));
    if(floor((rgb.x+rgb.y+rgb.z)/3.0+0.5)<220.0){found=vec4<u32>(min(found.xy,pixel),max(found.zw,pixel+vec2<u32>(1u)));}
  }
  bounds[lane.x]=found;workgroupBarrier();
  for(var stride=32u;stride>0u;stride/=2u){
    if(lane.x<stride){bounds[lane.x]=vec4<u32>(min(bounds[lane.x].xy,bounds[lane.x+stride].xy),max(bounds[lane.x].zw,bounds[lane.x+stride].zw));}
    workgroupBarrier();
  }
  if(lane.x==0u){
    var box=bounds[0];var padding=vec2<f32>(0.0);
    if(box.z<=box.x){box=vec4<u32>(0u,0u,w,h);}
    else{padding=ceil(vec2<f32>(0.3,0.2)*f32(box.w-box.y));}
    let size=vec2<f32>(box.zw-box.xy);
    let width=clamp(floor((size.x+padding.x*2.0)*32.0/(size.y+padding.y*2.0)*sizes.w+0.5),8.0,4096.0);
    let base=line*8u;
    output[base]=source.x+f32(box.x);output[base+1u]=source.y+f32(box.y);
    output[base+2u]=size.x;output[base+3u]=size.y;
    output[base+4u]=padding.x;output[base+5u]=padding.y;output[base+6u]=width;output[base+7u]=sizes.z;
  }
}
@compute @workgroup_size(64)
fn resize(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_id) lane:vec3<u32>){
  let index=(group.x+group.y*shape.z)*64u+lane.x;if(index>=shape.x){return;}
  let width=shape.y;let line=index/(width*32u);let x=index%width;let y=(index/width)%32u;
  let box=boxes[line*2u];let info=boxes[line*2u+1u];
  if(f32(x)>=info.z){output[index]=0.0;return;}
  let factor=vec2<f32>(info.z,32.0)/(box.zw+2.0*info.xy);
  let left=info.xy*factor;let right=left+box.zw*factor;
  let pixel=vec2<f32>(f32(x),f32(y));
  let center=pixel+vec2<f32>(0.5);
  if(any(center<left)||any(center>=right)){output[index]=0.0;return;}
  let position=clamp(box.xy+(pixel+vec2<f32>(0.5)-left)/factor,box.xy+vec2<f32>(0.5),box.xy+box.zw-vec2<f32>(0.5));
  let rgb=samplePixel(position,i32(info.w));
  output[index]=1.0-floor((rgb.x+rgb.y+rgb.z)/3.0+0.5)/255.0;
}`;

export class GpuPreparation {
  static async create(ort) {
    const value=new GpuPreparation();value.ort=ort;value.device=ort.env.webgpu.device;
    const module=value.device.createShaderModule({code:shader});
    const errors=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error');
    if(errors.length)throw Error(errors.map(message=>`${message.lineNum}: ${message.message}`).join('\n'));
    [value.ink,value.resize]=await Promise.all(['ink','resize'].map(entryPoint=>value.device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}})));
    value.sampler=value.device.createSampler({minFilter:'linear',magFilter:'linear'});
    return value;
  }

  canPrepare(pages) {
    return pages.every(page=>page.bitmap&&page.bitmap.width<=this.device.limits.maxTextureDimension2D&&page.bitmap.height<=this.device.limits.maxTextureDimension2D);
  }

  bindings(pipeline,texture,parameters,output,shape) {
    return this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:texture.createView({dimension:'2d-array'})},{binding:1,resource:this.sampler},
      {binding:2,resource:{buffer:parameters}},{binding:3,resource:{buffer:output}},{binding:4,resource:{buffer:shape}},
    ]});
  }

  async preparePages(pages,scale,timing) {
    const started=performance.now(),{device}=this,count=pages.reduce((sum,page)=>sum+page.lines.length,0);
    if(!count)return {lines:[],release(){}};
    const texture=device.createTexture({size:[Math.max(...pages.map(page=>page.bitmap.width)),Math.max(...pages.map(page=>page.bitmap.height)),pages.length],
      format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    const buffers=[];let complete=false;
    const make=(size,usage)=>{const buffer=device.createBuffer({size,usage});buffers.push(buffer);return buffer};
    try {
      pages.forEach((page,index)=>device.queue.copyExternalImageToTexture({source:page.bitmap},{texture,origin:[0,0,index],premultipliedAlpha:false},[page.bitmap.width,page.bitmap.height]));
      const data=Float32Array.from(pages.flatMap((page,index)=>page.lines.flatMap(line=>[line.x,line.y,line.width,line.height,Math.max(1,Math.round(line.width)),Math.max(1,Math.round(line.height)),index,scale])));
      const params=make(data.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),output=make(data.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
      const uniform=make(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),readback=make(data.byteLength,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(params,0,data);device.queue.writeBuffer(uniform,0,new Uint32Array([count,0,0,0]));
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
      pass.setPipeline(this.ink);pass.setBindGroup(0,this.bindings(this.ink,texture,params,output,uniform));pass.dispatchWorkgroups(count);pass.end();
      encoder.copyBufferToBuffer(output,0,readback,0,data.byteLength);device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const bounds=new Float32Array(readback.getMappedRange().slice(0));readback.unmap();
      const lines=Array.from({length:count},(_,i)=>({width:bounds[i*8+6],gpu:bounds.slice(i*8,i*8+8)}));
      this.texture=texture;complete=true;
      if(timing){timing.gpu_prepare_seconds=(performance.now()-started)/1000;timing.crop_pack_seconds+=timing.gpu_prepare_seconds;}
      return {lines,release:()=>{texture.destroy();if(this.texture===texture)this.texture=undefined}};
    } finally {for(const buffer of buffers){if(buffer.mapState==='mapped')buffer.unmap();buffer.destroy()}if(!complete)texture.destroy()}
  }

  pack(lines,width,target) {
    const {device,ort}=this,parameters=Float32Array.from(lines.flatMap(line=>Array.from(line.gpu))),pixels=lines.length*32*width;
    const buffers=[];
    const make=(size,usage)=>{const buffer=device.createBuffer({size,usage});buffers.push(buffer);return buffer};
    const release=()=>{for(const buffer of buffers)buffer.destroy()};
    try{
      const output=target?.gpuBuffer||make(pixels*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
      const params=make(parameters.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
      const uniform=make(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      const groups=Math.ceil(pixels/64),x=Math.min(groups,device.limits.maxComputeWorkgroupsPerDimension);
      device.queue.writeBuffer(params,0,parameters);device.queue.writeBuffer(uniform,0,new Uint32Array([pixels,width,x,0]));
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
      pass.setPipeline(this.resize);pass.setBindGroup(0,this.bindings(this.resize,this.texture,params,output,uniform));pass.dispatchWorkgroups(x,Math.ceil(groups/x));pass.end();device.queue.submit([encoder.finish()]);
      return {tensor:target||ort.Tensor.fromGpuBuffer(output,{dataType:'float32',dims:[lines.length,1,32,width]}),release};
    }catch(error){release();throw error}
  }
}
