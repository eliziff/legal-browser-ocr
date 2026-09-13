import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const browser=await chromium.launch({headless:true,channel:process.env.SELECTION_BROWSER||'chrome'});
try {
  const page=await browser.newPage();
  await page.addInitScript(()=>{globalThis.layoutRequests=[];const W=Worker;globalThis.Worker=class extends W{constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(data.renderPage)globalThis.layoutRequests.push(data.renderPage)})}};});
  await page.route(/^https?:/,route=>route.abort());
  await page.context().setOffline(true);
  await page.goto(pathToFileURL(resolve('dist/legal-browser-ocr-structure/index.html')).href);
  await page.locator('#file').setInputFiles('dist/pipeline-parity/native.pdf');
  await page.waitForFunction(()=>document.querySelector('#reader-total')?.textContent==='of 2',{},{timeout:90000});
  const saved=await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('legal-ocr-recent-pdfs');r.onsuccess=()=>resolve(r.result);});
    const records=await new Promise(resolve=>{const r=db.transaction('documents').objectStore('documents').getAll();r.onsuccess=()=>resolve(r.result);});
    db.close();return {bytes:Array.from(new Uint8Array(await records[0].blob.arrayBuffer())),sources:records[0].ocrPages.map(page=>page.source)};
  });
  assert.deepEqual(saved.bytes,Array.from(readFileSync('dist/pipeline-parity/native.pdf')));
  assert.deepEqual(saved.sources,['native','native']);
  await page.locator('#detect-structure').click();
  await page.waitForFunction(()=>!document.querySelector('#detect-structure').disabled);
  assert.ok(await page.locator('.contents nav button').count()>0);
  assert.deepEqual(await page.evaluate(()=>globalThis.layoutRequests),[]);
  console.log('PASS: offline native PDF keeps original bytes and uses native structure without model inference');
  const headingCount=await page.locator('.contents nav button').count();
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#reader-total')?.textContent==='of 2',null,{timeout:90000});
  assert.equal(await page.locator('.contents nav button').count(),headingCount);
  await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('legal-ocr-recent-pdfs');r.onsuccess=()=>resolve(r.result)});
    await new Promise(resolve=>{const tx=db.transaction('documents','readwrite'),store=tx.objectStore('documents'),r=store.getAll();r.onsuccess=()=>{for(const record of r.result)store.put({...record,structureRevision:'old-engine'})};tx.oncomplete=resolve});db.close();
  });
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#reader-total')?.textContent==='of 2',null,{timeout:90000});
  assert.equal(await page.locator('.contents nav button').count(),0);
  console.log('PASS: same-engine ToC survives reload; older engine output is invalidated');

  await page.locator('#file').setInputFiles('dist/pipeline-parity/mixed.pdf');
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='Page 1 ready.',{},{timeout:90000});
  await page.locator('#segmentation').selectOption('fast');
  await page.locator('#all').click();
  await page.waitForFunction(()=>document.querySelectorAll('.recent-pdf').length===2,{},{timeout:180000});
  const mixed=await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('legal-ocr-recent-pdfs');r.onsuccess=()=>resolve(r.result);});
    const records=await new Promise(resolve=>{const r=db.transaction('documents').objectStore('documents').getAll();r.onsuccess=()=>resolve(r.result);});
    db.close();const record=records.find(record=>record.name==='mixed.pdf');
    return {sources:record.ocrPages.map(page=>page.source),lines:record.ocrPages.map(page=>page.lines.length),text:record.ocrPages[1].lines.map(line=>line.text).join('\n')};
  });
  assert.equal(mixed.sources[0],'native');assert.notEqual(mixed.sources[1],'native');
  assert.ok(mixed.lines.every(count=>count>0));assert.ok(mixed.text.includes('Payment'));
  console.log('PASS: mixed PDF retains native page evidence and recognizes the scanned page');
} finally {await browser.close();}
