import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

mkdirSync('dist/structure-smoke', { recursive: true });
const pdf = await PDFDocument.create();
for (const lines of [
  ['1. Definitions','This agreement defines the terms used by the parties.','The buyer accepts delivery of the goods.','The seller shall provide written notice.','All notices must be sent to the address below.','The parties agree to act in good faith.','2. Payment','The buyer shall pay the agreed price.'],
  ['3. Termination','Either party may terminate this agreement.','Notice must be given in writing.','4. Governing Law','This agreement is governed by Canadian law.'],
]) {
  const canvas = createCanvas(900,1200), context = canvas.getContext('2d');
  context.fillStyle='white'; context.fillRect(0,0,900,1200); context.fillStyle='black'; context.font='26px Arial';
  lines.forEach((line,i)=>context.fillText(line,60,100+i*60));
  const image=await pdf.embedPng(canvas.toBuffer('image/png'));
  pdf.addPage([600,800]).drawImage(image,{x:0,y:0,width:600,height:800});
}
writeFileSync('dist/structure-smoke/reader-fixture.pdf',await pdf.save());
const browser=await chromium.launch({headless:true});
let page;
try {
  page=await browser.newPage({viewport:{width:1400,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(pathToFileURL(process.cwd()+'/dist/legal-browser-ocr-structure.html').href);
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Model ready'),{},{timeout:90000});
  await page.locator('#file').setInputFiles('dist/structure-smoke/reader-fixture.pdf');
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='Page 1 ready.');
  await page.locator('#segmentation').selectOption('fast');
  await page.locator('#all').click();
  await page.waitForFunction(()=>!document.querySelector('#download').disabled,{},{timeout:90000});
  assert.equal(await page.locator('#structure-profile').inputValue(),'0');
  await page.locator('#detect-structure').click();
  await page.waitForFunction(()=>document.querySelectorAll('.contents nav button').length >= 2,{},{timeout:90000});
  await page.waitForFunction(()=>document.querySelector('.pdfViewer .textLayer .endOfContent'));
  assert.ok(await page.locator('.pdfViewer .page canvas').first().evaluate(canvas=>Math.abs(canvas.clientWidth/canvas.clientHeight-canvas.width/canvas.height)<.01),'PDF page must retain its aspect ratio');
  const titles=await page.locator('.contents nav button').allTextContents();
  console.log('CONTENTS',titles);
  assert.ok(titles.some(t=>/Definitions|Payment|Termination/.test(t)));
  await page.locator('#toggle-contents').click();
  assert.equal(await page.locator('#contents-dock').isVisible(),false);
  assert.equal(await page.locator('#toggle-contents').getAttribute('aria-expanded'),'false');
  await page.locator('#toggle-contents').click();
  await page.locator('#reader-fullscreen').click();
  await page.waitForFunction(()=>document.fullscreenElement?.id==='structure-reader');
  await page.locator('#reader-fullscreen').click();
  await page.waitForFunction(()=>!document.fullscreenElement);
  await page.locator('#structure-reader').scrollIntoViewIfNeeded();
  await page.screenshot({path:'dist/structure-smoke/reader-desktop.png'});
  for(let repeat=0;repeat<2;repeat++) {
    await page.evaluate(()=>getSelection().removeAllRanges());
    const spans=await page.locator('.pdfViewer .page[data-page-number="1"] .textLayer span').evaluateAll(spans=>spans.filter(s=>s.textContent.trim()).map(s=>{const r=s.getBoundingClientRect();return {text:s.textContent,x:r.x,y:r.y,w:r.width,h:r.height}}));
    const start=spans[0],end=spans[5];assert.ok(end);
    await page.mouse.move(start.x+1,start.y+start.h/2);await page.mouse.down();
    const lengths=[];
    for(let i=1;i<=30;i++) {
      await page.mouse.move(start.x+1+(end.x+end.w-start.x-2)*i/30,start.y+start.h/2+(end.y+end.h/2-start.y-start.h/2)*i/30);
      await page.waitForTimeout(16);lengths.push(await page.evaluate(()=>getSelection().toString().length));
    }
    await page.mouse.up();
    const selected=await page.evaluate(()=>getSelection().toString());
    assert.ok(selected.includes('good faith'),selected);
    assert.ok(!selected.includes('Payment'),selected);
    assert.equal(lengths.filter((length,i)=>i&&length<lengths[i-1]).length,0,JSON.stringify(lengths));
    console.log('SELECTION',repeat,selected.length,'characters; no backwards jumps');
  }
  await page.screenshot({path:'dist/structure-smoke/reader-selection.png'});
  await page.locator('#reader-page').fill('2'); await page.locator('#reader-page').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#reader-page').value==='2');
  assert.equal(await page.locator('#ocr-preview').getAttribute('open'),null);
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#reader-page')?.value==='2' && document.querySelectorAll('.contents nav button').length >= 2,{},{timeout:15000});
  assert.equal(await page.locator('.recent-pdf').count(),1);
  assert.equal(await page.locator('#file').inputValue(),'');
  console.log('RESTORED: PDF, contents and page 2 after reload without OCR');
  const savedBytes = await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const request=indexedDB.open('legal-ocr-recent-pdfs');request.onsuccess=()=>resolve(request.result)});
    const saved=await new Promise(resolve=>{const request=db.transaction('documents').objectStore('documents').getAll();request.onsuccess=()=>resolve(request.result)});
    db.close();return Array.from(new Uint8Array(await saved[0].blob.arrayBuffer()));
  });
  const original=await PDFDocument.load(Uint8Array.from(savedBytes)), longPdf=await PDFDocument.create();
  for(const copy of await longPdf.copyPages(original,Array(40).fill(0)))longPdf.addPage(copy);
  await page.evaluate(async bytes=>{
    const db=await new Promise(resolve=>{const request=indexedDB.open('legal-ocr-recent-pdfs');request.onsuccess=()=>resolve(request.result)});
    await new Promise((resolve,reject)=>{const tx=db.transaction('documents','readwrite');tx.objectStore('documents').put({id:'long-fixture',name:'Long fixture.pdf',blob:new Blob([Uint8Array.from(bytes)],{type:'application/pdf'}),entries:[],page:1,profile:'2'});tx.oncomplete=resolve;tx.onerror=reject});db.close();
  },Array.from(await longPdf.save()));
  await page.reload();
  await page.locator('.recent-pdf').filter({hasText:'Long fixture.pdf'}).click();
  await page.waitForFunction(()=>document.querySelector('#reader-total').textContent==='of 40');
  await page.locator('#reader-page').fill('40');await page.locator('#reader-page').press('Enter');
  await page.waitForSelector('.pdfViewer .page[data-page-number="40"] .textLayer .endOfContent',{state:'attached'});
  const canvases=await page.locator('.pdfViewer canvas').count();
  assert.ok(canvases<=12,`Too many live canvases: ${canvases}`);
  console.log('PERFORMANCE: 40-page PDF,',canvases,'live canvases after jump to page 40');
  await page.locator('.recent-pdf').filter({hasText:'reader-fixture.pdf'}).click();
  await page.waitForFunction(()=>document.querySelector('#reader-total').textContent==='of 2' && document.querySelector('#reader-page').value==='2');
  assert.ok(await page.locator('.contents nav button').count()>=2);
  await page.locator('#reader-page').fill('1');await page.locator('#reader-page').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#reader-page').value==='1');
  await page.locator('.reader-scroll').evaluate(element=>element.scrollTop=element.scrollHeight);
  await page.waitForFunction(()=>document.querySelector('#reader-page').value==='2');
  await page.setViewportSize({width:390,height:844});
  await page.locator('#reader-zoom').selectOption('page-fit');
  await page.screenshot({path:'dist/structure-smoke/reader-mobile.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#clear').click();
  assert.equal(await page.locator('.reader-body').isVisible(),true);
  assert.equal(await page.locator('#detect-structure').isDisabled(),false);
  await page.locator('#forget-pdf').click();
  assert.equal(await page.locator('#remove-dialog').isVisible(),true);
  await page.locator('#remove-dialog button[value="cancel"]').click();
  assert.equal(await page.locator('.recent-pdf').count(),2);
  await page.locator('#forget-pdf').click();
  await page.locator('#remove-dialog button[value="confirm"]').click();
  await page.waitForFunction(()=>document.querySelector('#reader-total').textContent==='of 40');
  await page.locator('#forget-pdf').click();
  await page.locator('#remove-dialog button[value="confirm"]').click();
  await page.waitForFunction(()=>document.querySelector('.reader-body').hidden);
  await page.reload();await page.waitForSelector('#structure-reader');
  assert.equal(await page.locator('.recent-pdf').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: real OCR, PDF structure detection, selection, dock, fullscreen, history, restore, mobile and confirmed removal');
} catch (error) {
  console.log('FAILURE STATE',await page?.evaluate(()=>({status:document.querySelector('#structure-status')?.textContent,page:document.querySelector('#reader-page')?.value,total:document.querySelector('#reader-total')?.textContent,contents:document.querySelector('.contents nav')?.textContent})));
  await page?.screenshot({path:'dist/structure-smoke/failure.png'});
  throw error;
} finally { await browser.close(); }
