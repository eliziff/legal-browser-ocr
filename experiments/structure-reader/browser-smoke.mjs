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
try {
  const page=await browser.newPage({viewport:{width:1400,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(pathToFileURL(process.cwd()+'/dist/legal-browser-ocr-structure.html').href);
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Model ready'),{},{timeout:90000});
  await page.locator('#file').setInputFiles('dist/structure-smoke/reader-fixture.pdf');
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='Page 1 ready.');
  await page.locator('#segmentation').selectOption('fast');
  await page.locator('#all').click();
  await page.waitForFunction(()=>!document.querySelector('#download').disabled,{},{timeout:90000});
  await page.locator('#structure-profile').selectOption('2');
  await page.locator('#detect-structure').click();
  await page.waitForFunction(()=>document.querySelector('#reader-page').textContent==='Page 1 of 2',{},{timeout:90000});
  const titles=await page.locator('#structure-reader nav button').allTextContents();
  console.log('CONTENTS',titles);
  assert.ok(titles.some(t=>t.includes('Termination')));
  await page.locator('#structure-reader').scrollIntoViewIfNeeded();
  await page.screenshot({path:'dist/structure-smoke/reader-desktop.png'});
  for(let repeat=0;repeat<2;repeat++) {
    await page.evaluate(()=>getSelection().removeAllRanges());
    const spans=await page.locator('.reader-sheet .textLayer span').evaluateAll(spans=>spans.filter(s=>s.textContent.trim()).map(s=>{const r=s.getBoundingClientRect();return {text:s.textContent,x:r.x,y:r.y,w:r.width,h:r.height}}));
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
  const target=page.locator('#structure-reader nav button').filter({hasText:'Termination'}).first();
  await target.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#reader-page').textContent==='Page 2 of 2');
  await page.locator('#reader-previous').click();
  await page.waitForFunction(()=>document.querySelector('#reader-page').textContent==='Page 1 of 2');
  await page.setViewportSize({width:390,height:844});
  await page.locator('#reader-next').click();
  await page.waitForFunction(()=>document.querySelector('#reader-page').textContent==='Page 2 of 2');
  await page.screenshot({path:'dist/structure-smoke/reader-mobile.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#clear').click();
  assert.equal(await page.locator('.reader-body').isVisible(),false);
  assert.equal(await page.locator('#detect-structure').isDisabled(),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: real OCR, WASM detection, repeated selection, keyboard navigation, mobile reflow and crop invalidation');
} finally { await browser.close(); }
