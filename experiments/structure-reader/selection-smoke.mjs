import { chromium } from 'playwright';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createSearchablePdf } from '../../pdf-export.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const canvas=createCanvas(600,800), ctx=canvas.getContext('2d');
ctx.fillStyle='white';ctx.fillRect(0,0,600,800);ctx.fillStyle='black';ctx.font='24px Arial';
const texts=['Alpha first line','Bravo second line','Charlie third line','Delta fourth line','Echo fifth line','Foxtrot sixth line','Golf seventh line'];
const lines=texts.map((text,i)=>{ctx.fillText(text,60,100+50*i);return {text,x:60,y:80+50*i,width:ctx.measureText(text).width,height:25};});
const pdf=await createSearchablePdf({pngBytes:canvas.toBuffer('image/png'),pages:[{lines,transform:[1,0,0,-1,0,800]}]});
mkdirSync('dist/selection-smoke',{recursive:true});
writeFileSync('dist/selection-smoke/fixture.pdf',pdf);
const browser=await chromium.launch({headless:true,channel:process.env.SELECTION_BROWSER || undefined});
console.log('Browser',browser.version());
try {
 const page=await browser.newPage({viewport:{width:1400,height:1000}});
 await page.goto(process.env.SELECTION_URL || 'http://127.0.0.1:8799/');
 await page.evaluate(async bytes=>{
  const db=await new Promise(resolve=>{const r=indexedDB.open('legal-ocr-recent-pdfs',1);r.onupgradeneeded=()=>r.result.createObjectStore('documents',{keyPath:'id'});r.onsuccess=()=>resolve(r.result)});
  await new Promise(resolve=>{const tx=db.transaction('documents','readwrite');tx.objectStore('documents').put({id:'selection',name:'Selection.pdf',blob:new Blob([Uint8Array.from(bytes)],{type:'application/pdf'}),entries:[],page:1});tx.oncomplete=resolve});db.close();localStorage.setItem('legal-ocr-active','selection');
 },Array.from(pdf));
 await page.reload();
 await page.waitForSelector('.textLayer span');
 await page.locator('#reader-zoom').selectOption('page-fit');
 await page.locator('#structure-reader').scrollIntoViewIfNeeded();
 const rects=await page.locator('.textLayer span').evaluateAll(spans=>spans.filter(s=>s.textContent.trim()).map(s=>{const r=s.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,text:s.textContent}}));
 const a=rects[2],b=rects[3];
 async function checkPaint(name) {
  const geometry=await page.evaluate(()=>{
   const layer=document.querySelector('.textLayer'),r=layer.getBoundingClientRect(),selection=getSelection();
   const boxes=[];
   if(selection.rangeCount&&!selection.isCollapsed){
    const selected=selection.getRangeAt(0);
    for(const span of layer.querySelectorAll('span')){
     if(!span.textContent||!selected.intersectsNode(span))continue;
     const part=document.createRange();part.selectNodeContents(span);
     if(part.compareBoundaryPoints(Range.START_TO_START,selected)<0)part.setStart(selected.startContainer,selected.startOffset);
     if(part.compareBoundaryPoints(Range.END_TO_END,selected)>0)part.setEnd(selected.endContainer,selected.endOffset);
     for(const box of part.getClientRects())boxes.push({x:box.x,y:box.y,right:box.right,bottom:box.bottom});
    }
   }
   return {bounds:{x:r.x,y:r.y,right:r.right,bottom:r.bottom},boxes,text:selection.toString()};
  });
  const png=await page.screenshot({path:`dist/selection-smoke/${name}-drag.png`});
  const screenshot=await loadImage(png),paint=createCanvas(screenshot.width,screenshot.height),c=paint.getContext('2d');
  c.drawImage(screenshot,0,0);const pixels=c.getImageData(0,0,paint.width,paint.height).data;
  let blue=0,outside=0;
  for(let y=Math.max(0,Math.ceil(geometry.bounds.y));y<Math.min(paint.height,geometry.bounds.bottom);y++)
   for(let x=Math.max(0,Math.ceil(geometry.bounds.x));x<Math.min(paint.width,geometry.bounds.right);x++){
    const i=(y*paint.width+x)*4;
    if(pixels[i+2]-pixels[i]>25&&pixels[i+1]>pixels[i]){
     blue++;
     if(!geometry.boxes.some(r=>x>=r.x-2&&x<=r.right+2&&y>=r.y-2&&y<=r.bottom+2))outside++;
    }
   }
  assert.ok(outside<10,`${name}: ${outside} highlight pixels outside the selected text`);
  if(geometry.text)assert.ok(blue>30,name+': selected text has no visible highlight');
 }
 const cases=[
  ['down',[a.x+2,a.y+a.h/2],[b.x+b.w-2,b.y+b.h/2]],
  ['up',[b.x+b.w-2,b.y+b.h/2],[a.x+2,a.y+a.h/2]],
  ['right-margin',[a.x+a.w+30,a.y+a.h/2],[b.x+b.w-2,b.y+b.h/2]],
  ['left-margin',[b.x-20,b.y+b.h/2],[a.x+2,a.y+a.h/2]],
  ['into-right-margin',[a.x+2,a.y+a.h/2],[b.x+b.w+30,b.y+b.h/2]],
  ['into-left-margin',[b.x+b.w-2,b.y+b.h/2],[a.x-20,a.y+a.h/2]],
  ['into-gap',[a.x+2,a.y+a.h/2],[b.x+b.w/2,b.y-8]],
  ['reverse-into-gap',[b.x+b.w-2,b.y+b.h/2],[a.x+a.w/2,a.y+a.h+8]],
 ];
 for(const [name,from,to] of cases){
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.mouse.move(...from);await page.mouse.down();
  await page.mouse.move(...to,{steps:20});
  await page.waitForTimeout(80);
  const during=await page.evaluate(()=>getSelection().toString());
  await checkPaint(name);
  await page.mouse.up();await page.waitForTimeout(80);
  const after=await page.evaluate(()=>getSelection().toString());
  console.log(name,JSON.stringify({during,after}));
  assert.ok(!after.includes('Alpha')&&!after.includes('Foxtrot'),name+': selection jumped to unrelated text');
  assert.equal(during,after,name+': release changed selection');
 }
 await page.mouse.move(b.x+b.w/2,b.y+b.h/2);await page.mouse.down();
 for(const [name,x,y] of [['reverse-up',a.x+2,a.y+a.h/2],['reverse-down',rects[4].x+rects[4].w-2,rects[4].y+rects[4].h/2],['reverse-back',a.x+2,a.y+a.h/2]]){
  await page.mouse.move(x,y,{steps:20});await page.waitForTimeout(80);await checkPaint(name);
 }
 await page.mouse.up();
}finally{await browser.close();}
