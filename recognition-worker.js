import * as wasm from 'onnxruntime-web/wasm';
import { cleanModelText } from './text-layer.js';
import { LineRecognizer, recognizerProfile } from './recognizer.js';
import { CapturedSession } from './experiments/ocr-speed/captured-session.js';
import { GpuPreparation } from './experiments/ocr-speed/gpu-preparation.js';

let session, labels, batchSize, bucketSize, sortedBatches;
let lineRecognizer;
let ort=wasm;
let collectTiming=false;
self.onmessage=async({data})=>{
  let gpuPrepared;
  try{
    if(data.type==='init'){
      if(data.backend==='webgpu'){ort=await import('onnxruntime-web/webgpu');ort.env.webgpu.powerPreference='high-performance';}
      ort.env.wasm.wasmPaths={mjs:data.runtimeMjs,wasm:data.runtimeWasm};ort.env.wasm.numThreads=data.backend==='wasm'&&self.crossOriginIsolated?data.workerThreads||1:1;
      labels=Object.fromEntries(Object.entries(data.codec).flatMap(([character,ids])=>ids.map(id=>[id,character])));batchSize=data.batchSize;bucketSize=data.bucketSize;sortedBatches=data.sortedBatches;
      const provider=data.backend||'wasm';
      session=data.captureMode?await CapturedSession.create(ort,data.model,data.sessionOptions,data.batchSize,Math.max(...Object.keys(labels).map(Number))+1,data.captureEnabled,data.gpuCacheShapes)
        :await ort.InferenceSession.create(data.model,{executionProviders:[provider],...data.sessionOptions,...(data.gpuArgMax?{preferredOutputLocation:{logits:'gpu-buffer'}}:{})});
      lineRecognizer=new LineRecognizer(ort,session,{...recognizerProfile(data.recognizer),widthMultiple:data.widthMultiple||8,gpuArgMax:data.gpuArgMax,gpuDirect:data.gpuDirect},labels);
      await lineRecognizer.argmax?.pipeline;
      if(data.gpuPrep)lineRecognizer.gpuPreparer=await GpuPreparation.create(ort);
      if(provider==='webgpu')ort.env.webgpu.device.lost.then(info=>self.postMessage({type:'fatal',message:`GPU device lost: ${info.message||info.reason}`}));
      collectTiming=data.timing;
      self.postMessage({type:'ready'});return;
    }
    const timing=collectTiming?{crop_pack_seconds:0,model_seconds:0,decode_seconds:0}:undefined;
    if(lineRecognizer.gpuPreparer?.canPrepare(data.pages))gpuPrepared=await lineRecognizer.gpuPreparer.preparePages(data.pages,data.scale,timing);
    const prepared=gpuPrepared?.lines||data.pages.flatMap(page=>page.prepared||lineRecognizer.preparePage(page.bitmap,page.lines,data.scale,timing));
    const lines=(await lineRecognizer.recognizePrepared(prepared,{batchSize,bucketSize,sortedBatches,timing})).map(result=>result.text);
    let offset=0;
    const pages=data.pages.map(page=>{const selected=lines.slice(offset,offset+=page.lines.length);return {text:cleanModelText(selected.join('\n')),lines:selected}});
    self.postMessage({type:'result',pages,timing});
  }catch(error){self.postMessage({type:'error',message:error.message,stack:error.stack})}
  finally{gpuPrepared?.release();for(const page of data.pages||[])page.bitmap?.close()}
};
