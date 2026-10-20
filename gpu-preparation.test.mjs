import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GpuPreparation} from './experiments/ocr-speed/gpu-preparation.js';

test('partial GPU crop allocation failure releases the buffers already allocated',()=>{
  globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4,UNIFORM:8};
  let allocations=0,bytes=0;
  const value=new GpuPreparation();
  value.device={createBuffer({size}){
    if(++allocations===2)throw Error('GPU allocation failed');
    bytes+=size;return {destroy(){bytes-=size}};
  }};
  assert.throws(()=>value.pack([{gpu:new Float32Array(8)}],256),/allocation failed/);
  assert.equal(bytes,0);
});

test('crop packing leaves the borrowed recognition input alive when its own resources are released',()=>{
  globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4,UNIFORM:8};
  let bytes=0;
  const value=new GpuPreparation(),input={destroy(){throw Error('Borrowed input was destroyed')}};
  value.device={
    limits:{maxComputeWorkgroupsPerDimension:65535},
    createBuffer({size}){bytes+=size;return {destroy(){bytes-=size}}},
    queue:{writeBuffer(){},submit(){}},
    createCommandEncoder(){return {beginComputePass(){return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}}},finish(){}}},
  };
  value.bindings=()=>({});
  const target={gpuBuffer:input},packed=value.pack([{gpu:new Float32Array(8)}],256,target);
  assert.equal(packed.tensor,target);
  packed.release();
  assert.equal(bytes,0);
});
