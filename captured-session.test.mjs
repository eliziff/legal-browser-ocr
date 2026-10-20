import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CapturedSession} from './experiments/ocr-speed/captured-session.js';

globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4};

function gpu(failAt=Infinity) {
  let bytes=0,created=0,released=0,sessions=0;
  const device={createBuffer({size}){
    if(++created===failAt)throw Error('GPU allocation failed');
    bytes+=size;let destroyed=false;
    return {size,destroy(){assert.equal(destroyed,false);destroyed=true;bytes-=size}};
  }};
  const ort={env:{webgpu:{device}},Tensor:{fromGpuBuffer:(gpuBuffer,{dims})=>({gpuBuffer,dims})},
    InferenceSession:{async create(){sessions++;return {async release(){released++}}}}};
  return {ort,get bytes(){return bytes},get released(){return released},get sessions(){return sessions}};
}

test('GPU shape cache stays bounded, reuses recent buffers and releases evicted resources',async()=>{
  for(const capacity of [4,8]){
  const source=gpu(),session=await CapturedSession.create(source.ort,new Uint8Array(),{},16,1679,true,capacity);
  try{
    for(let width=256;width<=4096;width+=256){
      const slot=await session.slot(width);
      assert.equal(await session.slot(width),slot);
      assert.ok(session.slots.size<=capacity);
      assert.ok(source.bytes<=256*1024*1024);
    }
    assert.ok(source.released>0);
  }finally{await session.release()}
  assert.equal(source.bytes,0);
  assert.equal(source.released,source.sessions);
  }
});

test('failed GPU allocation releases the partially initialized session and buffers',async()=>{
  const source=gpu(2);
  await assert.rejects(CapturedSession.create(source.ort,new Uint8Array(),{},16,1679,true),/allocation failed/);
  assert.equal(source.bytes,0);
  assert.equal(source.released,source.sessions);
});
