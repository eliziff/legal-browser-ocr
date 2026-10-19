import * as ort from 'onnxruntime-web/wasm';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
import { TesseractLayout } from './tesseract-layout.js';
import { orderLayoutLines } from './layout-order.js';
import { documentWorkers } from './worker-policy.js';
import { cleanModelText, positionedLines, cropToPdfTransform } from './text-layer.js';
import { createSearchablePdf } from './pdf-export.js';
import { LineRecognizer, recognizerProfile } from './recognizer.js';
import { setThumbnail } from './experiments/ocr-speed/preview.js';
import { memoryOptions } from './experiments/ocr-speed/session-options.js';
import { ocrModels, ocrTier } from './ocr-tiers.js';

const embedded = globalThis.LEGAL_OCR_ASSETS;
const experimental = new URLSearchParams(location.search);
const recognizer = recognizerProfile('indra');
let tier = ocrTier(experimental.get('tier') || 'balanced');
const requestedBackend = experimental.get('backend') || 'auto';
if (!['auto', 'cpu', 'webgpu'].includes(requestedBackend)) throw new Error(`Unknown processing device: ${requestedBackend}`);
let backend = 'wasm';
if (requestedBackend !== 'cpu') {
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter && !adapter.isFallbackAdapter && adapter.features.has('shader-f16')) backend = 'webgpu';
    else if (requestedBackend === 'webgpu') throw new Error('A WebGPU device with shader-f16 is required.');
  } catch (error) { if (requestedBackend === 'webgpu') throw error; }
}
const collectTimings = experimental.get('timing') === '1';
const previewMode = experimental.get('preview') || 'none';
const thumbnailPreviews = previewMode === 'thumbnail';
const omitPreviews = previewMode === 'none';
const detector = experimental.get('detector') === 'tesseract' ? null : experimental.get('detector') || 'indra';
if (detector && !['indra', 'paddle'].includes(detector)) throw new Error(`Unknown detector: ${detector}`);
const detectorLimit=experimental.get('detectorLimit');
if(detectorLimit&&!['min','max'].includes(detectorLimit))throw new Error(`Unknown detector resize limit: ${detectorLimit}`);
const workerPoolSize = experimental.has('pool') ? Number(experimental.get('pool')) : backend === 'webgpu' ? 1 : Math.min(6, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
const fullRuntime = experimental.get('runtime') === 'full';
const runtimeStem = experimental.get('runtime') === 'relaxed' ? 'ort-wasm-relaxedsimd' : 'ort-wasm-simd';
const debugRuntime = experimental.get('debug') === '1';
const requestedThreads = Number(experimental.get('threads')) || (workerPoolSize?1:4);
const threadCount = crossOriginIsolated ? Math.min(requestedThreads, navigator.hardwareConcurrency || 4) : 1;
const runtimeSuffix = '-threaded';
let batchSize = Number(experimental.get('batch')) || (backend === 'webgpu' ? 32 : recognizer.batchSize);
let bucketSize = Number(experimental.get('bucket')) || 24;
const sortedBatches = experimental.has('sort') ? experimental.get('sort') === '1' : backend === 'webgpu';
const pageBatch = Number(experimental.get('pageBatch') || (backend === 'webgpu' ? 4 : 1));
if (!Number.isInteger(pageBatch) || pageBatch < 1 || pageBatch > 4) throw new Error('pageBatch must be between 1 and 4');
const scaleOverride = Number(experimental.get('scale')) || 0;
const modelPath = experimental.get('model');
const graphOptimizationLevel = experimental.get('opt') || 'all';
const sessionOptions = {graphOptimizationLevel,...memoryOptions(experimental)};
const atlasBatch = experimental.get('atlas') !== '0';
const layoutWorkerCount = Math.max(1, Number(experimental.get('layoutWorkers')) || (backend === 'webgpu' ? 1 : Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 3)))));
const layoutScale = Number(experimental.get('layoutScale'))||1;
const trimLayout = experimental.get('layoutTrim')==='1';
const layoutPsm = Number(experimental.get('layoutPsm'))||3;
const layoutBinaryThreshold = Number(experimental.get('layoutBinary'))||0;
const retryThreshold = Number(experimental.get('retry')) || 0;
const retryScale = Number(experimental.get('retryScale')) || 1;
const collectConfidence = retryThreshold > 0 || experimental.get('confidence') === '1';
const decodeAsset = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
const assetUrl = (name, fallback, type = 'application/javascript') => embedded?.[name]
  ? `data:${type};base64,${embedded[name]}` : fallback;
const assetBytes = async (name, fallback) => embedded?.[name] ? decodeAsset(embedded[name]) : fetch(fallback).then(response => { if (!response.ok) throw new Error(`Asset load failed: ${fallback} (${response.status})`); return response.arrayBuffer(); });

GlobalWorkerOptions.workerSrc = assetUrl('pdfWorker', './dist/pdf.worker.min.mjs');
const runtimePaths = embedded ? {
  mjs: assetUrl(threadCount > 1 ? 'ortThreadedMjs' : 'ortMjs', '', 'application/javascript'),
  wasm: assetUrl(threadCount > 1 ? 'ortThreadedWasm' : 'ortWasm', '', 'application/wasm'),
} : fullRuntime ? new URL('./node_modules/onnxruntime-web/dist/', location.href).href : {
  mjs: new URL(`./dist/${runtimeStem}${runtimeSuffix}.mjs`, location.href).href,
  wasm: new URL(`./dist/${runtimeStem}${runtimeSuffix}.wasm`, location.href).href,
};
const gpuRuntimePaths = {
  mjs: assetUrl('gpuMjs', new URL('./dist/ort-wasm-simd-threaded.jsep.mjs', location.href).href),
  wasm: assetUrl('gpuWasm', new URL('./dist/ort-wasm-simd-threaded.jsep.wasm', location.href).href, 'application/wasm'),
};
ort.env.wasm.wasmPaths = runtimePaths;
ort.env.wasm.numThreads = threadCount;
if (debugRuntime) ort.env.logLevel = 'verbose';

const $ = id => document.getElementById(id);
const pageCanvas = $('page'), overlay = $('overlay'), status = $('status'), text = $('text');
$('terms').href=assetUrl('packageNotice', './assets/manifest.json', 'application/json');
if (experimental.has('seg')) $('segmentation').value = experimental.get('seg');
const context = pageCanvas.getContext('2d'), overlayContext = overlay.getContext('2d');
let session, modelBytes, labels, pdf, imageBitmap, crop, cropTemplate, dragStart;
let sessionPromise;
let lineRecognizer;
let loadedFile = null, ocrPages = null, busy = false, poolError = null, modelReady = false;
let poolReady=Promise.resolve(),poolQueue=[],idleWorkers=[];
let recognitionSlots=[];
let poolFlush;
const hasTesseractLayout = !embedded || Boolean(embedded.layoutCore);
const layoutOptions={workerPath:assetUrl('layoutWorker','./tesseract-layout-worker.js'),corePath:assetUrl('layoutCore','./assets/layout-core.mjs'),wasmPath:assetUrl('layoutWasm','./assets/layout-core.wasm','application/wasm'),sourceResolution:Math.round(200*layoutScale),trim:trimLayout,psm:layoutPsm,binaryThreshold:layoutBinaryThreshold};
if(detector){
  layoutOptions.workerPath=assetUrl('detectorWorker','./dist/detector-worker.js');
  const layoutRuntime = backend === 'webgpu' ? gpuRuntimePaths : runtimePaths;
  layoutOptions.modelOptions={backend:detector,executionProvider:backend,modelPath:assetUrl(`${detector}Detector`,`./assets/detectors/${detector}/model.onnx`,'application/octet-stream'),configPath:assetUrl('detectorConfig','./assets/detectors/config.json','application/json'),runtimeMjs:layoutRuntime.mjs,runtimeWasm:layoutRuntime.wasm,longSide:Number(experimental.get('detectorSide'))||tier.detectorSide,limitType:detectorLimit||undefined,sessionOptions};
  $('segmentation').querySelector('[value="tesseract"]').textContent=detector==='indra'?'Indra line detection':'Paddle line detection';
}
const layouts=hasTesseractLayout?Array.from({length:layoutWorkerCount},()=>new TesseractLayout(layoutOptions)):[];
let idleLayouts=[],layoutQueue=[];
idleLayouts.push(...layouts);
const layoutReady = Promise.resolve();
if (!hasTesseractLayout) {
  $('segmentation').querySelector('[value="tesseract"]').remove();
  $('segmentation').value = 'fast';
}

async function loadRecognizer() {
  modelReady=false;
  for (const slot of recognitionSlots) slot.worker.terminate();
  recognitionSlots=[];idleWorkers=[];poolError=null;
  if (session) await session.release();
  session=sessionPromise=lineRecognizer=undefined;
  const pack = ocrModels[tier.model];
  const [codec, model] = await Promise.all([
    assetBytes(pack.codec, './'+pack.codec).then(bytes=>JSON.parse(new TextDecoder().decode(bytes))),
    assetBytes(pack.cpu, modelPath || './'+pack.cpu),
    layoutReady,
  ]);
  modelBytes = model;
  labels = Object.fromEntries(Object.entries(codec).flatMap(([character, ids]) => ids.map(id => [id, character])));
  if(workerPoolSize) {
    const workerModel = backend === 'webgpu' ? await assetBytes(pack.gpu, './'+pack.gpu) : model;
    poolReady=initializeRecognitionPool(codec,workerModel);
  }
  else await ensureMainSession();
  await poolReady;
  modelReady=true;
  status.textContent = `Model ready (${tier.label}, ${backend === 'webgpu' ? 'GPU' : 'CPU'}). ${loadedFile ? 'Ready to recognize.' : 'Select a PNG or PDF.'}`;
  $('all').disabled = busy || !loadedFile;
}
let ready = loadRecognizer();
ready.catch(error => { status.textContent = `Model failed to load: ${error.message}`; });
$('mode').disabled=true;
ready.then(()=>setBusy(busy),()=>setBusy(busy));
$('mode').value = experimental.get('tier') || 'balanced';
$('mode').onchange = async () => {
  if (busy) return;
  invalidateOcr();setBusy(true);
  const previous = tier;
  tier = ocrTier($('mode').value);
  if (layoutOptions.modelOptions) layoutOptions.modelOptions.longSide = tier.detectorSide;
  try {
    if (previous.model !== tier.model) ready = loadRecognizer();
    await ready;
    status.textContent = `${tier.label} ready${tier.model === 'light' ? ' · higher error rate' : ''}.`;
  } catch (error) { status.textContent = `Model failed to load: ${error.message}`; }
  finally { setBusy(false); }
};
$('segmentation').onchange=()=>{if(!busy)invalidateOcr()};
window.legalOcrConfiguration=()=>({backend,tier:$('mode').value,model:tier.model,workerPoolSize,layoutWorkerCount,batchSize,pageBatch,detectorSide:layoutOptions.modelOptions?.longSide});

function ensureMainSession(){
  return sessionPromise||=(ort.InferenceSession.create(modelBytes,{executionProviders:['wasm'],...sessionOptions,...(debugRuntime&&{logSeverityLevel:0,logVerbosityLevel:1})}).then(value=>session=value));
}

function pumpRecognitionPool(){
  if(poolFlush&&poolQueue.length<pageBatch)return;
  while(idleWorkers.length&&poolQueue.length){
    const slot=idleWorkers.pop(),tasks=[poolQueue.shift()];
    while(tasks.length<pageBatch&&poolQueue[0]?.scale===tasks[0].scale)tasks.push(poolQueue.shift());
    slot.tasks=tasks;
    slot.worker.postMessage({type:'recognize',scale:tasks[0].scale,pages:tasks.map(task=>({bitmap:task.bitmap,lines:task.lines}))},tasks.map(task=>task.bitmap));
  }
}

function pumpLayoutPool(){
  while(idleLayouts.length&&layoutQueue.length){const worker=idleLayouts.pop(),task=layoutQueue.shift();worker.findLines(task.canvas,task.timing).then(task.resolve,task.reject).finally(()=>{idleLayouts.push(worker);pumpLayoutPool()})}
}

async function findLayoutLines(canvas,timing){
  await layoutReady;return new Promise((resolve,reject)=>{layoutQueue.push({canvas,timing,resolve,reject});pumpLayoutPool()});
}

async function initializeRecognitionPool(codec,model){
  const workerUrl=assetUrl('recognitionWorker','./dist/recognition-worker.js');
  const slots=await Promise.all(Array.from({length:workerPoolSize},()=>new Promise((resolve,reject)=>{
    const worker=new Worker(workerUrl),slot={worker,tasks:null};recognitionSlots.push(slot);
    worker.onmessage=({data})=>{
      if(data.type==='ready'){idleWorkers.push(slot);resolve(slot);pumpRecognitionPool();return}
      const tasks=slot.tasks;slot.tasks=null;
      if(data.type==='error'){
        if(!tasks){reject(new Error(data.message));return}
        for(const task of tasks)task.reject(new Error(data.message));
      }else if(tasks){
        const count=tasks.reduce((sum,task)=>sum+task.lines.length,0);
        tasks.forEach((task,index)=>{
          if(task.timing&&data.timing){
            // Shared batch work is attributed by line count, not individual page latency.
            const fraction=count?task.lines.length/count:1/tasks.length;
            Object.assign(task.timing,Object.fromEntries(Object.entries(data.timing).map(([key,value])=>[key,value*fraction])),{recognition_batch_pages:tasks.length});
          }
          task.resolve(task.includeLines?data.pages[index].lines:data.pages[index].text);
        });
      }
      idleWorkers.push(slot);pumpRecognitionPool();
    };
    worker.onerror=event=>{
      poolError=new Error(`${event.message||'Recognition worker failed'}. Reload this app to retry.`);
      reject(poolError);for(const task of slot.tasks||[])task.reject(poolError);slot.tasks=null;
      idleWorkers=idleWorkers.filter(value=>value!==slot);
      for(const task of poolQueue.splice(0)){task.bitmap.close();task.reject(poolError)}
    };
    const runtime=backend==='webgpu'?gpuRuntimePaths:runtimePaths;
    worker.postMessage({type:'init',backend,runtimeMjs:runtime.mjs,runtimeWasm:runtime.wasm,model:model.slice(0),codec,recognizer:recognizer.id,timing:collectTimings,batchSize,bucketSize,sortedBatches,sessionOptions});
  })));
  return slots;
}

async function recognizeInPool(bitmap,lines,scale,includeLines=false,timing){
  try{await poolReady;if(poolError)throw poolError}catch(error){bitmap.close();throw error}
  return new Promise((resolve,reject)=>{
    poolQueue.push({bitmap,lines,scale,includeLines,timing,resolve,reject});
    if(pageBatch>1&&!poolFlush)poolFlush=setTimeout(()=>{poolFlush=null;pumpRecognitionPool()},8);
    pumpRecognitionPool();
  });
}

function setBusy(value) {
  busy=value;
  for(const id of ['file','segmentation','mode','clear'])$(id).disabled=value;
  $('all').disabled=value||!loadedFile||!modelReady;
  $('download').disabled=value||!ocrPages;
}
function invalidateOcr() {
  ocrPages=null;$('download').disabled=true;
}

function setCanvasSize(width, height) {
  pageCanvas.width = overlay.width = width; pageCanvas.height = overlay.height = height;
}

async function renderPage(number) {
  if (pdf) {
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 2 });
    setCanvasSize(Math.round(viewport.width), Math.round(viewport.height));
    await page.render({ canvasContext: context, viewport }).promise;
  } else if (imageBitmap) {
    setCanvasSize(imageBitmap.width, imageBitmap.height); context.drawImage(imageBitmap, 0, 0);
  }
  crop = cropTemplate ? {
    x: cropTemplate.x * pageCanvas.width, y: cropTemplate.y * pageCanvas.height,
    w: cropTemplate.w * pageCanvas.width, h: cropTemplate.h * pageCanvas.height
  } : null;
  drawCrop();
}

function point(event) {
  const box = overlay.getBoundingClientRect();
  return { x:Math.max(0,Math.min(overlay.width,(event.clientX-box.left)*overlay.width/box.width)), y:Math.max(0,Math.min(overlay.height,(event.clientY-box.top)*overlay.height/box.height)) };
}
function drawCrop() {
  overlayContext.clearRect(0,0,overlay.width,overlay.height); if(!crop)return;
  overlayContext.fillStyle='rgb(180 35 24 / 18%)';overlayContext.strokeStyle='#b42318';overlayContext.lineWidth=3;
  overlayContext.fillRect(crop.x,crop.y,crop.w,crop.h);overlayContext.strokeRect(crop.x,crop.y,crop.w,crop.h);
}
overlay.addEventListener('pointerdown',e=>{if(busy||!loadedFile)return;invalidateOcr();dragStart=point(e);crop=null;overlay.setPointerCapture(e.pointerId)});
overlay.addEventListener('pointermove',e=>{if(busy||!dragStart)return;const p=point(e);crop={x:Math.min(p.x,dragStart.x),y:Math.min(p.y,dragStart.y),w:Math.abs(p.x-dragStart.x),h:Math.abs(p.y-dragStart.y)};drawCrop()});
overlay.addEventListener('pointerup',()=>{if(busy||!dragStart)return;dragStart=null;if(crop&&(crop.w<8||crop.h<8))crop=null;cropTemplate=crop?{x:crop.x/overlay.width,y:crop.y/overlay.height,w:crop.w/overlay.width,h:crop.h/overlay.height}:null;drawCrop();status.textContent=crop?'Crop selected for every page.':'Crop cleared.'});
$('clear').onclick=()=>{if(busy)return;invalidateOcr();crop=cropTemplate=null;drawCrop()};

$('file').onchange = async () => {
  const file=$('file').files[0];if(!file||busy)return;
  setBusy(true);invalidateOcr();loadedFile=null;crop=cropTemplate=dragStart=null;
  $('document').textContent='';text.textContent='';setCanvasSize(1,1);status.textContent='Loading page…';
  try{
    if(pdf)await pdf.destroy();pdf=null;imageBitmap?.close();imageBitmap=null;
    await ready;
    // Keep the immutable File, not PDF.js's transferred/detached ArrayBuffer.
    if(file.type==='application/pdf'||file.name.toLowerCase().endsWith('.pdf'))pdf=await getDocument({data:await file.arrayBuffer()}).promise;
    else imageBitmap=await createImageBitmap(file);
    await renderPage(1);loadedFile=file;
    text.textContent='Drag a crop or recognize the document.';status.textContent='Page 1 ready.';
  }catch(error){status.textContent=`Could not load file: ${error.message}`}
  finally{setBusy(false)}
};

function sourceCanvas() {
  if(!crop)return pageCanvas; const canvas=document.createElement('canvas');canvas.width=Math.round(crop.w);canvas.height=Math.round(crop.h);
  canvas.getContext('2d').drawImage(pageCanvas,crop.x,crop.y,crop.w,crop.h,0,0,canvas.width,canvas.height);return canvas;
}

function inkThreshold(pixels) {
  const histogram=new Uint32Array(256);for(let i=0;i<pixels.length;i+=16)histogram[Math.round((pixels[i]+pixels[i+1]+pixels[i+2])/3)]++;
  let total=0,sum=0;for(let i=0;i<256;i++){total+=histogram[i];sum+=i*histogram[i]}let left=0,leftSum=0,best=0,threshold=0;
  for(let i=0;i<256;i++){left+=histogram[i];leftSum+=i*histogram[i];if(!left||left===total)continue;const between=(leftSum/left-(sum-leftSum)/(total-left))**2*left*(total-left);if(between>best){best=between;threshold=i}}
  return threshold>160?threshold:210;
}

function projectionLines(source,pixels,dark,x0=0,y0=0,width=source.width,height=source.height) {
  const sourceWidth=source.width;dark??=inkThreshold(pixels);const inkRows=new Uint16Array(height),low=Math.max(4,width/200),high=Math.max(4,width/60);for(let y=0;y<height;y++)for(let x=0;x<width;x+=2){const i=((y0+y)*sourceWidth+x0+x)*4;if((pixels[i]+pixels[i+1]+pixels[i+2])/3<dark)inkRows[y]++}
  const ranges=(threshold,from=0,to=height)=>{const out=[];let start=-1;for(let y=from;y<=to;y++){if(y<to&&inkRows[y]>=threshold&&start<0)start=y;if((y===to||inkRows[y]<threshold)&&start>=0){if(y-start>=4)out.push([start,y]);start=-1}}return out};
  let bands=ranges(low),sizes=bands.map(([a,b])=>b-a).filter(n=>n<100).sort((a,b)=>a-b),typical=sizes[Math.floor(sizes.length/2)]||40;
  bands=bands.flatMap(([a,b])=>b-a>typical*1.65?ranges(high,a,b):[[a,b]]);
  const lines=[];for(const [start,y] of bands){let left=width,right=0;for(let yy=Math.max(0,start-6);yy<Math.min(height,y+6);yy++)for(let x=0;x<width;x+=2){const i=((y0+yy)*sourceWidth+x0+x)*4;if((pixels[i]+pixels[i+1]+pixels[i+2])/3<dark){left=Math.min(left,x);right=Math.max(right,x)}}const inkLeft=left,inkRight=right;left=Math.max(0,left-12);right=Math.min(width,right+14);const c=document.createElement('canvas'),cropY=Math.max(0,start-6);c.width=Math.max(1,right-left);c.height=Math.min(height,y-start+12);c.dataset.y=y0+start;c.x=x0+left;c.y=y0+cropY;c.ocrBox={x:x0+inkLeft,y:y0+start,width:Math.max(1,inkRight-inkLeft+2),height:y-start};c.getContext('2d').drawImage(source,x0+left,y0+cropY,c.width,c.height,0,0,c.width,c.height);lines.push(c)}
  return lines;
}

function lineCanvases(source) {
  const {width,height}=source, pixels=source.getContext('2d').getImageData(0,0,width,height).data,dark=inkThreshold(pixels);let ruleX=0,ruleInk=0;
  for(let x=Math.floor(width*.55);x<width*.9;x+=2){let ink=0;for(let y=0;y<height;y+=2){const i=(y*width+x)*4;if((pixels[i]+pixels[i+1]+pixels[i+2])/3<160)ink++}if(ink>ruleInk){ruleInk=ink;ruleX=x}}
  if(ruleInk<height*.18){
    const rows=new Uint16Array(height);for(let y=0;y<height;y+=2)for(let x=0;x<width;x+=4){const i=(y*width+x)*4;if((pixels[i]+pixels[i+1]+pixels[i+2])/3<dark)rows[y]++}let top=0,bottom=(height-1)&~1;while(top<bottom&&rows[top]<4)top+=2;while(bottom>top&&rows[bottom]<4)bottom-=2;const activeHeight=bottom-top+1;
    let start=-1,bestStart=0,bestEnd=0;for(let x=Math.floor(width*.25);x<=Math.floor(width*.75);x++){let ink=0;for(let y=top;y<=bottom;y+=4){const i=(y*width+x)*4;if((pixels[i]+pixels[i+1]+pixels[i+2])/3<dark)ink++}if(ink<=activeHeight/80&&start<0)start=x;if((ink>activeHeight/80||x===Math.floor(width*.75))&&start>=0){if(x-start>bestEnd-bestStart){bestStart=start;bestEnd=x}start=-1}}
    if(bestEnd-bestStart>=width*.015){const split=Math.round((bestStart+bestEnd)/2);return [projectionLines(source,pixels,dark,0,0,split,height),projectionLines(source,pixels,dark,split,0,width-split,height)].flat()}
    return projectionLines(source,pixels,dark);
  }
  let top=height,bottom=0;for(let y=0;y<height;y++){const i=(y*width+ruleX)*4;if((pixels[i]+pixels[i+1]+pixels[i+2])/3<160){top=Math.min(top,y);bottom=Math.max(bottom,y)}}
  return [projectionLines(source,pixels,dark,0,0,width,top),projectionLines(source,pixels,dark,0,top,ruleX,bottom-top),projectionLines(source,pixels,dark,ruleX+1,top,width-ruleX-1,bottom-top),projectionLines(source,pixels,dark,0,bottom,width,height-bottom)].flat();
}

function withoutRunningHeader(lines, source) {
  const heights=lines.map(line=>line.height).sort((a,b)=>a-b), typical=heights[Math.floor(heights.length/2)]||1;
  const rule=lines.find(line=>Number(line.dataset.y||0)<source.height*.1&&line.width>source.width*.85&&line.height<typical*.55);
  return rule?lines.filter(line=>Number(line.dataset.y||0)>Number(rule.dataset.y)):lines;
}

async function tesseractLines(source,timing) {
  let layoutSource=source;
  if(layoutScale!==1){layoutSource=document.createElement('canvas');layoutSource.width=Math.max(1,Math.round(source.width*layoutScale));layoutSource.height=Math.max(1,Math.round(source.height*layoutScale));layoutSource.getContext('2d').drawImage(source,0,0,layoutSource.width,layoutSource.height)}
  let boxes=await findLayoutLines(layoutSource,timing);
  if(layoutScale!==1)boxes=boxes.map(box=>({x0:box.x0*source.width/layoutSource.width,y0:box.y0*source.height/layoutSource.height,x1:box.x1*source.width/layoutSource.width,y1:box.y1*source.height/layoutSource.height}));
  boxes = orderLayoutLines(boxes, source.width, source.height);
  if(atlasBatch)return boxes.map(box=>({source,ocrBox:{x:box.x0,y:box.y0,width:box.x1-box.x0,height:box.y1-box.y0},x:Math.max(0,box.x0-10),y:Math.max(0,box.y0-6),width:Math.max(1,Math.min(source.width,box.x1+11)-Math.max(0,box.x0-10)),height:Math.max(1,Math.min(source.height,box.y1+7)-Math.max(0,box.y0-6))}));
  return boxes.map(box => {
    const x = Math.max(0, box.x0 - 10), y = Math.max(0, box.y0 - 6);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.min(source.width, box.x1 + 11) - x);
    canvas.height = Math.max(1, Math.min(source.height, box.y1 + 7) - y);
    canvas.x=x;canvas.y=y;canvas.ocrBox={x:box.x0,y:box.y0,width:box.x1-box.x0,height:box.y1-box.y0};
    canvas.getContext('2d').drawImage(source, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return canvas;
  });
}

async function infer(lines,scale,allowRetry=true) {
  await ensureMainSession();
  lineRecognizer ||= new LineRecognizer(ort,session,recognizer,labels);
  const results=await lineRecognizer.recognize(lines,scale,{batchSize,bucketSize,sortedBatches,confidence:collectConfidence});
  if(allowRetry&&retryThreshold&&scale<retryScale){
    const uncertain=[];
    results.forEach((result,index)=>{if((result.confidence??Infinity)<retryThreshold)uncertain.push(index)});
    if(uncertain.length){
      const replacements=await infer(uncertain.map(index=>lines[index]),retryScale,false);
      uncertain.forEach((index,n)=>{results[index]={...replacements[n],retried:true}});
    }
  }
  return results;
}

async function segment(canvas,timing) {
  const started=performance.now(),segmentation=$('segmentation').value;
  const lines=segmentation==='tesseract'?await tesseractLines(canvas,timing):segmentation==='none'?[canvas]:withoutRunningHeader(lineCanvases(canvas),canvas);
  return {lines,seconds:(performance.now()-started)/1000};
}

async function recognize(canvas, timing, withLayout=false) {
  await ready;const mode=scaleOverride||1;
  const {lines,seconds}=await segment(canvas,timing);
  if(timing){timing.layout_seconds=seconds;timing.layout_boxes=lines.map(line=>line.ocrBox||{x:line.x||0,y:line.y||0,width:line.width,height:line.height})}
  const inferenceStarted=performance.now();
  const texts=workerPoolSize&&$('segmentation').value==='tesseract'
    ?await recognizeInPool(await createImageBitmap(canvas),lines.map(({x,y,width,height})=>({x,y,width,height})),mode,true,timing)
    :(await infer(lines,mode)).map(item=>item.text);
  if(timing)timing.inference_seconds=(performance.now()-inferenceStarted)/1000;
  const value=cleanModelText(texts.join('\n'));
  return withLayout?{text:value,lines:positionedLines(lines,texts)}:value;
}

async function preparePages(canvases) {
  await ready;const started=performance.now(),segments=[],lines=[];
  for(const canvas of canvases){const value=await segment(canvas);segments.push({offset:lines.length,count:value.lines.length});lines.push(...value.lines)}
  return {lines,segments,layout_seconds:(performance.now()-started)/1000};
}

async function recognizePreparedPages(prepared) {
  const started=performance.now(),results=await infer(prepared.lines,scaleOverride||1);
  const confidences=results.map(result=>result.confidence).filter(Number.isFinite).sort((a,b)=>a-b);
  return {inference_seconds:(performance.now()-started)/1000,retried:results.filter(result=>result.retried).length,confidence_median:confidences[Math.floor(confidences.length/2)],pages:prepared.segments.map(({offset,count})=>({line_count:count,text:cleanModelText(results.slice(offset,offset+count).map(item=>item.text).join('\n'))}))};
}

window.legalOcrLineCanvases=()=>{const source=sourceCanvas();return withoutRunningHeader(lineCanvases(source),source)};
window.legalOcrRecognizeLines=async lines=>cleanModelText((await infer(lines,scaleOverride||1)).map(item=>item.text).join('\n'));
window.legalOcrRecognizePage=async()=>{const started=performance.now(),timing={},value=await recognize(sourceCanvas(),timing);return {seconds:(performance.now()-started)/1000,...timing,text:value}};
window.legalOcrPreparePages=preparePages;
window.legalOcrRecognizePreparedPages=recognizePreparedPages;
window.legalOcrSetTuning=value=>{if(value.batch)batchSize=value.batch;if(value.bucket)bucketSize=value.bucket};
window.legalOcrRecognizePages=async canvases=>{const started=performance.now(),prepared=await preparePages(canvases),recognized=await recognizePreparedPages(prepared);return {seconds:(performance.now()-started)/1000,layout_seconds:prepared.layout_seconds,...recognized}};
window.legalOcrRecognizePagesPooled=async canvases=>{
  await ready;await poolReady;if(!workerPoolSize)throw new Error('Set ?pool=N to enable the recognition worker pool');
  const started=performance.now(),scale=scaleOverride||1,counts=[];let layoutsDone=0,layout_wall_seconds=0;
  const tasks=canvases.map(async(canvas,index)=>{const {lines}=await segment(canvas);if(++layoutsDone===canvases.length)layout_wall_seconds=(performance.now()-started)/1000;counts[index]=lines.length;const boxes=lines.map(({x,y,width,height})=>({x,y,width,height}));return recognizeInPool(await createImageBitmap(canvas),boxes,scale)});
  const values=await Promise.all(tasks);return {seconds:(performance.now()-started)/1000,layout_wall_seconds,pages:values.map((text,index)=>({line_count:counts[index],text}))};
};

function cropDocumentCanvas(canvas){
  if(!cropTemplate)return {canvas,area:null};
  const selected=document.createElement('canvas'),area={x:cropTemplate.x*canvas.width,y:cropTemplate.y*canvas.height,w:cropTemplate.w*canvas.width,h:cropTemplate.h*canvas.height};
  selected.width=Math.max(1,Math.round(area.w));selected.height=Math.max(1,Math.round(area.h));
  selected.getContext('2d').drawImage(canvas,area.x,area.y,area.w,area.h,0,0,selected.width,selected.height);
  return {canvas:selected,area};
}
async function documentCanvas(number){
  const canvas=document.createElement('canvas');
  let transform=[1,0,0,-1,0,pageCanvas.height]; // PNG: one source pixel per PDF point.
  if(pdf){
    const page=await pdf.getPage(number),viewport=page.getViewport({scale:2});
    transform=viewport.transform;canvas.width=Math.round(viewport.width);canvas.height=Math.round(viewport.height);
    if(number===1)canvas.getContext('2d').drawImage(pageCanvas,0,0);
    else await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
  }else{
    canvas.width=pageCanvas.width;canvas.height=pageCanvas.height;canvas.getContext('2d').drawImage(pageCanvas,0,0);
  }
  const selected=cropDocumentCanvas(canvas);
  if(selected.canvas!==canvas)canvas.width=canvas.height=1;
  return {canvas:selected.canvas,transform:cropToPdfTransform(transform,selected.area,selected.canvas.width,selected.canvas.height)};
}

$('all').onclick=async()=>{
  if(busy||!loadedFile)return;
  setBusy(true);invalidateOcr();
  const target=$('document');target.textContent='';text.textContent='Waiting…';
  const count=pdf?.numPages||1,started=performance.now(),results=new Array(count);
  const timings=collectTimings?new Array(count):null;
  const entries=[{pre:text},...Array.from({length:Math.max(0,count-1)},(_,index)=>{
    const pair=document.createElement('article');pair.className='pair';
    const img=omitPreviews?null:document.createElement('img');
    if(img)img.alt=`Page ${index+2}`;
    else pair.style.gridTemplateColumns='1fr';
    const copy=document.createElement('div');copy.className='text';
    const pre=document.createElement('pre');pre.textContent='Waiting…';
    copy.append(pre);if(img)pair.append(img);pair.append(copy);target.append(pair);return{img,pre};
  })];
  let next=1,done=0,failed=0;
  const runner=async()=>{
    while(next<=count){
      const number=next++,entry=entries[number-1],timing=collectTimings?{}:undefined,pageStarted=performance.now();let canvas;
      try{
        const page=await documentCanvas(number);canvas=page.canvas;
        if(timing)timing.render_seconds=(performance.now()-pageStarted)/1000;
        const previewStarted=performance.now();
        if(entry.img&&!thumbnailPreviews)entry.img.src=canvas.toDataURL('image/jpeg',.72);
        if(timing)timing.preview_seconds=(performance.now()-previewStarted)/1000;
        if(timing)timing.render_preview_seconds=(performance.now()-pageStarted)/1000;
        entry.pre.textContent='Recognizing…';
        const result=await recognize(canvas,timing,true);
        entry.pre.textContent=result.text;
        results[number-1]={lines:result.lines,transform:page.transform};
        if(entry.img&&thumbnailPreviews){const started=performance.now();await setThumbnail(entry.img,canvas);if(timing)timing.preview_seconds=(performance.now()-started)/1000}
        if(timing){timing.page_wall_seconds=(performance.now()-pageStarted)/1000;timings[number-1]=timing}
      }catch(error){failed++;entry.pre.textContent=`OCR failed: ${error.message}`}
      finally{if(canvas)canvas.width=canvas.height=1}
      done++;status.textContent=`Processed ${done} of ${count} pages · ${((performance.now()-started)/1000).toFixed(1)} seconds`;
      await new Promise(requestAnimationFrame);
    }
  };
  try{
    await Promise.all(Array.from({length:Math.min(count,documentWorkers(workerPoolSize*pageBatch,$('segmentation').value))},runner));
    if(timings){window.legalOcrLastDocumentTimings=timings;window.legalOcrLastDocumentLines=results.map(page=>page?.lines||[])}
    if(failed)status.textContent=poolError?.message||`OCR failed on ${failed} of ${count} pages. Retry recognition before downloading a PDF.`;
    else{ocrPages=results;status.textContent=`Done · ${count} pages in ${((performance.now()-started)/1000).toFixed(2)} seconds. Searchable PDF ready to download.`}
  }catch(error){status.textContent=`OCR failed: ${error.message}`}
  finally{setBusy(false)}
};

$('download').onclick=async()=>{
  if(busy||!loadedFile||!ocrPages)return;
  setBusy(true);status.textContent='Adding the text layer to the original pages…';
  try{
    const bytes=await loadedFile.arrayBuffer();
    const output=await createSearchablePdf({...(pdf?{pdfBytes:bytes}:{pngBytes:bytes}),pages:ocrPages});
    const url=URL.createObjectURL(new Blob([output],{type:'application/pdf'}));
    const link=document.createElement('a');link.href=url;link.download=loadedFile.name.replace(/\.[^.]+$/,'')+'-searchable.pdf';
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    status.textContent='Searchable PDF downloaded. Original page appearance preserved.';
  }catch(error){status.textContent=`PDF export failed: ${error.message}`}
  finally{setBusy(false)}
};
