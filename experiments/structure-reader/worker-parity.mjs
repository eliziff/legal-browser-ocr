import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Exercise the actual shipped JS worker/ABI, with frozen layout evidence.
// No OCR runtime or layout model download is needed for this contract gate.
const bundle=await build({entryPoints:['experiments/structure-reader/worker.js'],bundle:true,format:'iife',write:false});
const wasm=readFileSync('experiments/structure-reader/target/bindgen/browser_structure_bg.wasm').toString('base64');
const executable=resolve(`experiments/structure-reader/target/debug/upstream-parity${process.platform==='win32'?'.exe':''}`);
writeFileSync('dist/pipeline-parity/worker.html','<!doctype html><title>Worker parity</title>');
const browser=await chromium.launch({headless:true,channel:process.env.SELECTION_BROWSER||(process.platform==='win32'?'chrome':undefined)});
try {
  const page=await browser.newPage();await page.context().setOffline(true);
  await page.goto(pathToFileURL(resolve('dist/pipeline-parity/worker.html')).href);
  const fixture=JSON.parse(readFileSync('experiments/structure-reader/fixtures/ocr-layout.json','utf8'));
  for(const kind of ['native','ocr']){
    const file=kind==='native'?'dist/pipeline-parity/native.pdf':'experiments/structure-reader/fixtures/ocr-layout.pdf';
    const ocrFile='dist/pipeline-parity/worker-ocr.json',layoutFile='dist/pipeline-parity/worker-layout.json';
    writeFileSync(ocrFile,JSON.stringify(fixture.ocr));writeFileSync(layoutFile,JSON.stringify(fixture.layouts));
    const reference=spawnSync(executable,[file,...kind==='ocr'?[ocrFile,layoutFile]:[]],{encoding:'utf8',maxBuffer:16*1024*1024});
    assert.equal(reference.status,0,reference.stderr);
    const result=await page.evaluate(({workerSource,wasm,pdf,ocr,layouts})=>new Promise((resolve,reject)=>{
      const url=URL.createObjectURL(new Blob([workerSource],{type:'application/javascript'})),worker=new Worker(url);
      const finish=()=>{clearTimeout(timeout);worker.terminate();URL.revokeObjectURL(url)};
      const timeout=setTimeout(()=>{finish();reject(Error('Worker parity timed out'))},60000);
      worker.onerror=event=>{finish();reject(Error(event.message))};
      worker.onmessage=({data})=>{if(data.progress)return;if(data.error||data.renderPage){finish();reject(Error(data.error||'Unexpected model inference'));return}finish();resolve(data)};
      worker.postMessage({wasm:Uint8Array.fromBase64(wasm),pdf:Uint8Array.fromBase64(pdf),profile:0,layouts,
        input:{pages:ocr?.map(lines=>({width:600,height:800,lines:lines.map(line=>({...line,x:line.bbox[0],y:line.bbox[1],width:line.bbox[2]-line.bbox[0],height:line.bbox[3]-line.bbox[1]}))}))}});
    }),{workerSource:bundle.outputFiles[0].text,wasm,pdf:readFileSync(file).toString('base64'),ocr:kind==='ocr'?fixture.ocr:null,layouts:kind==='ocr'?fixture.layouts:null});
    const {module,layouts,...actual}=result;
    assert.deepEqual(actual,JSON.parse(reference.stdout).detected);
    console.log(`PASS: offline file worker ${kind} output equals native upstream`);
  }
}finally{await browser.close()}
