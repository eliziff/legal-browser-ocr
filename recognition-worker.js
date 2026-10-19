import * as wasm from 'onnxruntime-web/wasm';
import { cleanModelText } from './text-layer.js';
import { LineRecognizer, recognizerProfile } from './recognizer.js';

let session, labels, batchSize, bucketSize, sortedBatches;
let lineRecognizer;
let ort=wasm;
let collectTiming=false;
async function recognize(pages,scale,timing){
  const lines=pages.flatMap(page=>page.lines.map(line=>({...line,source:page.bitmap})));
  return (await lineRecognizer.recognize(lines,scale,{batchSize,bucketSize,sortedBatches,timing})).map(result=>result.text);
}

self.onmessage=async({data})=>{
  try{
    if(data.type==='init'){
      if(data.backend==='webgpu'){ort=await import('onnxruntime-web/webgpu');ort.env.webgpu.powerPreference='high-performance';}
      ort.env.wasm.wasmPaths={mjs:data.runtimeMjs,wasm:data.runtimeWasm};ort.env.wasm.numThreads=1;
      labels=Object.fromEntries(Object.entries(data.codec).flatMap(([character,ids])=>ids.map(id=>[id,character])));batchSize=data.batchSize;bucketSize=data.bucketSize;sortedBatches=data.sortedBatches;
      session=await ort.InferenceSession.create(data.model,{executionProviders:[data.backend||'wasm'],...data.sessionOptions});
      lineRecognizer=new LineRecognizer(ort,session,recognizerProfile(data.recognizer),labels);
      collectTiming=data.timing;
      self.postMessage({type:'ready'});return;
    }
    const timing=collectTiming?{crop_pack_seconds:0,model_seconds:0,decode_seconds:0}:undefined;
    const lines=await recognize(data.pages,data.scale,timing);
    let offset=0;
    const pages=data.pages.map(page=>{const selected=lines.slice(offset,offset+=page.lines.length);return {text:cleanModelText(selected.join('\n')),lines:selected}});
    self.postMessage({type:'result',pages,timing});
  }catch(error){self.postMessage({type:'error',message:error.message,stack:error.stack})}
  finally{for(const page of data.pages||[])page.bitmap.close()}
};
