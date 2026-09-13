import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {PDFDocument,StandardFonts,degrees,PDFName,PDFNumber} from 'pdf-lib';
import {createCanvas} from '@napi-rs/canvas';
import {initSync} from './target/bindgen/browser_structure.js';
import {fileURLToPath} from 'node:url';

const api=initSync({module:readFileSync(new URL('./target/bindgen/browser_structure_bg.wasm',import.meta.url))});
const nativeExecutable=fileURLToPath(new URL(`./target/debug/upstream-parity${process.platform==='win32'?'.exe':''}`,import.meta.url));
function invoke(operation,...buffers) {
  const args=[],allocations=[];
  try {
    for(const buffer of buffers){
      if(typeof buffer==='number'){args.push(buffer);continue;}
      const bytes=buffer instanceof Uint8Array?buffer:new TextEncoder().encode(JSON.stringify(buffer));
      const ptr=api.allocate(bytes.length);allocations.push([ptr,bytes.length]);
      new Uint8Array(api.memory.buffer,ptr,bytes.length).set(bytes);args.push(ptr,bytes.length);
    }
    const packed=api[operation](...args),ptr=Number(packed&0xffffffffn),length=Number(packed>>32n);
    allocations.push([ptr,length]);
    const result=JSON.parse(new TextDecoder().decode(new Uint8Array(api.memory.buffer,ptr,length)));
    assert.equal(result?.error,undefined,result?.error);return result;
  } finally {for(const [ptr,length] of allocations)api.release(ptr,length);}
}
const body='The parties agree to the terms stated in this document. This paragraph is ordinary body text.';
const rows=[
  ['REPEATED JOURNAL HEADER',50,25,8],['1. Introduction',50,90,20],
  [body,50,150,12],[body,50,180,12],['2. Payment',50,250,20],[body,50,310,12],
  ['1 Footnote: a citation and explanatory prose.',50,740,8],
];
async function fixture(kind,rotation=0) {
  const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);
  const canvas=createCanvas(600,800),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,600,800);ctx.fillStyle='black';
  rows.forEach(([text,x,y,size])=>{ctx.font=`${size}px Arial`;ctx.fillText(text,x,y+size);});
  const image=await doc.embedPng(canvas.toBuffer('image/png'));
  for(let i=0;i<2;i++){
    const page=doc.addPage([600,800]);
    if(kind==='native'||(kind==='mixed'&&i===0))rows.forEach(([text,x,y,size])=>page.drawText(text,{font,x,y:800-y-size,size}));
    else page.drawImage(image,{x:0,y:0,width:600,height:800});
    if(rotation){page.setRotation(degrees(rotation));page.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));}
  }
  return doc.save();
}
mkdirSync('dist/pipeline-parity',{recursive:true});
test('captured OCR layout matches upstream and retains independently specified headings',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/ocr-layout.json',import.meta.url)));
  const file=fileURLToPath(new URL('./fixtures/ocr-layout.pdf',import.meta.url));
  const ocrFile='dist/pipeline-parity/captured-ocr.json',layoutFile='dist/pipeline-parity/captured-layout.json';
  writeFileSync(ocrFile,JSON.stringify(fixture.ocr));writeFileSync(layoutFile,JSON.stringify(fixture.layouts));
  const extracted=invoke('extract_ocr',readFileSync(file),fixture.ocr.map(lines=>({width:600,height:800,lines})));
  const result=invoke('detect',{extracted,layouts:fixture.layouts},0);
  const reference=spawnSync(nativeExecutable,[file,ocrFile,layoutFile],{encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(reference.status,0,reference.stderr);
  assert.deepEqual(result,JSON.parse(reference.stdout).detected);
  assert.deepEqual(result.nodes.filter(node=>node.kind==='heading').map(node=>node.label),fixture.expectedHeadings);
  writeFileSync(layoutFile,JSON.stringify(fixture.fastLayouts));
  const fast=invoke('detect',{extracted,layouts:fixture.fastLayouts},0);
  const fastReference=spawnSync(nativeExecutable,[file,ocrFile,layoutFile],{encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(fastReference.status,0,fastReference.stderr);
  assert.deepEqual(fast,JSON.parse(fastReference.stdout).detected);
  assert.deepEqual(fast.nodes.filter(node=>node.kind==='heading'),[]);
  assert.deepEqual(fast.diagnostics.find(d=>d.code==='PPDOC_LAYOUT_INCOMPLETE').line_ids,fixture.fastUnmatchedLines);
});
for(const kind of ['native','ocr','mixed'])test(`${kind}: WASM extraction and graph equal the native upstream APIs`,async()=>{
  const pdf=await fixture(kind),file=`dist/pipeline-parity/${kind}.pdf`;writeFileSync(file,pdf);
  const routing=invoke('extract_pdf',pdf);
  assert.deepEqual(routing.metadata.pages_needing_ocr,kind==='native'?[]:kind==='mixed'?[1]:[0,1]);
  const lines=rows.map(([text,x,y,size])=>({text,bbox:[x,y,x+450,y+size],confidence:1}));
  const ocr=[lines,lines],ocrFile=`dist/pipeline-parity/${kind}.json`;writeFileSync(ocrFile,JSON.stringify(ocr));
  const extracted=kind==='native'?routing:invoke('extract_ocr',pdf,ocr.map(lines=>({width:600,height:800,lines})));
  const result=invoke('detect',{extracted,layouts:null},0);
  const reference=spawnSync(nativeExecutable,[file,...kind==='native'?[]:[ocrFile]],{encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(reference.status,0,reference.stderr);
  const native=JSON.parse(reference.stdout);
  assert.deepEqual(extracted,native.extracted);
  assert.deepEqual(result,native.detected);
  assert.ok(result.nodes.length>0);
  if(kind==='native'){
    assert.ok(extracted.pages[0].lines.some(line=>line.spans.some(span=>span.font==='Helvetica'&&span.size===20)));
    const headings=result.nodes.filter(node=>node.kind==='heading');
    assert.ok(headings.length>0);
    const labels=headings.map(node=>node.label || '').join('\n');
    assert.ok(!labels.includes('Footnote')&&!labels.includes('JOURNAL HEADER'));
  }
  writeFileSync(`dist/pipeline-parity/${kind}-result.json`,JSON.stringify(result,null,2));
});
test('native rotated pages preserve upstream geometry and OCR routing',async()=>{
  const pdf=await fixture('native',90),file='dist/pipeline-parity/rotated.pdf';writeFileSync(file,pdf);
  const result=invoke('extract_pdf',pdf);
  const reference=spawnSync(nativeExecutable,[file],{encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(reference.status,0,reference.stderr);
  assert.deepEqual(result,JSON.parse(reference.stdout).extracted);
  assert.deepEqual(result.metadata.pages_needing_ocr,[]);
});

// Exercise the browser ABI against native image preparation, not a copied JS algorithm.
test('both model inputs and raster witnesses agree with native upstream',()=>{
  const width=80,height=100,rgb=Uint8Array.from({length:width*height*3},(_,i)=>(i*37+i%19)%256);
  const file='dist/pipeline-parity/raster.rgb';writeFileSync(file,rgb);
  for(const variant of [0,1]){
    const reference=spawnSync(nativeExecutable,['--raster',file,String(width),String(height),String(variant)],{encoding:'utf8'});
    assert.equal(reference.status,0,reference.stderr);const native=JSON.parse(reference.stdout);
    const ptr=api.allocate(rgb.length);let packed;
    try{new Uint8Array(api.memory.buffer,ptr,rgb.length).set(rgb);packed=api.preprocess(ptr,rgb.length,width,height,variant);}finally{api.release(ptr,rgb.length);}
    const output=Number(packed&0xffffffffn),length=Number(packed>>32n);
    try{
      const pixels=new Float32Array(api.memory.buffer,output,length/4);
      native.samples.forEach((value,i)=>assert.ok(Math.abs(pixels[Math.floor(i*(pixels.length-1)/256)]-value)<1e-6,`variant ${variant}, sample ${i}`));
    }finally{api.release(output,length);}
    const gray=Uint8Array.from({length:width*height},(_,i)=>(rgb[i*3]*77+rgb[i*3+1]*150+rgb[i*3+2]*29)>>8);
    assert.equal(invoke('scan_separator',gray,width,height),native.separator);
  }
});

test('raster footnote separator survives the browser ABI in page units',()=>{
  const width=800,height=1000,gray=new Uint8Array(width*height).fill(255);
  for(const [top,bottom] of [[100,620],[720,950]])for(let y=top;y<bottom;y+=4)for(let row=y;row<y+2;row++)for(let x=80;x<720;x+=3)gray[row*width+x]=0;
  for(let y=700;y<702;y++)for(let x=64;x<320;x++)gray[y*width+x]=0;
  const rgb=Uint8Array.from({length:gray.length*3},(_,i)=>gray[Math.floor(i/3)]),file='dist/pipeline-parity/separator.rgb';writeFileSync(file,rgb);
  const reference=spawnSync(nativeExecutable,['--raster',file,String(width),String(height),'0'],{encoding:'utf8'});
  assert.equal(reference.status,0,reference.stderr);
  assert.equal(JSON.parse(reference.stdout).separator,0.701);
  assert.equal(invoke('scan_separator',gray,width,height),0.701);
  assert.equal(invoke('scan_separator',gray.subarray(1),width,height),null);
});

for(const profile of [1,2])test(`text profile ${profile} matches its upstream public parser`,async()=>{
  const extracted=invoke('extract_pdf',await fixture('native'));
  const text=extracted.pages.map(page=>page.lines.map(line=>line.text).join('\n')+'\n').join('\n');
  const file=`dist/pipeline-parity/profile-${profile}.txt`;writeFileSync(file,text);
  const reference=spawnSync(nativeExecutable,['--text-profile',String(profile),file],{encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(reference.status,0,reference.stderr);const native=JSON.parse(reference.stdout);
  const result=invoke('detect',{extracted,layouts:null},profile);
  assert.deepEqual(result.nodes,native.nodes);assert.equal(result.offset_unit,native.offset_unit);
});
