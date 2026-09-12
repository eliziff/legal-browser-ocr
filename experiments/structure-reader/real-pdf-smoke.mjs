// Public source PDFs are downloaded separately; no private documents or network inference.
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const fixtures = [
  { name: 'guidelines', pages: [3,4], headings: ['Priorities', 'Transform Gracefully', 'Provide alternative text'] },
  { name: 'contract', pages: [11], headings: ['DESCRIPTION OF THE STANDING OFFER', 'Number and types', 'Duration and Extension', 'Future Adjustment', 'Replenishment', 'Evaluation of Consultants'] },
  { name: 'legislation', pages: [70], headings: ['Short Title', 'Interpretation'] },
];
const server = spawn(process.execPath, ['dist/legal-browser-ocr-structure/serve.mjs','8798'], {stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(Error('Server exited: '+code)));});
const browser = await chromium.launch({headless:true});
const results = [];
try {
  for (const fixture of fixtures) {
    const source = await PDFDocument.load(readFileSync(`dist/structure-smoke/public-${fixture.name}.pdf`));
    const subset = await PDFDocument.create();
    for (const p of await subset.copyPages(source,fixture.pages)) subset.addPage(p);
    const path = `dist/structure-smoke/${fixture.name}-sample.pdf`;
    writeFileSync(path,await subset.save());
    const page = await browser.newPage({viewport:{width:1400,height:1000}});
    const errors = []; page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:8798/');
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Model ready'),{},{timeout:90000});
    await page.locator('#file').setInputFiles(path);
    await page.waitForFunction(()=>document.querySelector('#status').textContent==='Page 1 ready.');
    await page.locator('#segmentation').selectOption('tesseract');
    await page.locator('#all').click();
    await page.waitForFunction(()=>!document.querySelector('#download').disabled,{},{timeout:180000});
    for (const regioning of ['accurate','fast']) {
      await page.locator('#regioning').selectOption(regioning);
      const started = performance.now();
      await page.locator('#detect-structure').click();
      await page.waitForFunction(()=>!document.querySelector('#detect-structure').disabled,{},{timeout:90000});
      const titles = await page.locator('.contents nav button').allTextContents();
      const status = await page.locator('#structure-status').textContent();
      const missing = fixture.headings.filter(expected=>!titles.some(title=>title.toLowerCase().includes(expected.toLowerCase())));
      const result = {name:fixture.name,sourcePages:fixture.pages.map(i=>i+1),regioning,ms:Math.round(performance.now()-started),titles,status,missing};
      results.push(result); console.log(JSON.stringify(result));
      const evidence = await page.evaluate(async()=>{
        const db=await new Promise(resolve=>{const request=indexedDB.open('legal-ocr-recent-pdfs');request.onsuccess=()=>resolve(request.result)});
        const records=await new Promise(resolve=>{const request=db.transaction('documents').objectStore('documents').getAll();request.onsuccess=()=>resolve(request.result)});
        db.close();return records.map(({blob,...record})=>record);
      });
      writeFileSync(`dist/structure-smoke/${fixture.name}-${regioning}-evidence.json`,JSON.stringify(evidence,null,2));
      assert.ok(!status.includes('Could not detect'),status);
      await page.locator('#structure-reader').scrollIntoViewIfNeeded();
      await page.screenshot({path:`dist/structure-smoke/${fixture.name}-${regioning}.png`});
    }
    assert.deepEqual(errors,[]);
    await page.close();
  }
  writeFileSync('dist/structure-smoke/real-pdf-results.json',JSON.stringify(results,null,2));
  // Independent heading labels above remain visible in every result, including
  // misses. The two supplied variants must collectively cover these labels.
  for (const fixture of fixtures) {
    const runs = results.filter(result=>result.name===fixture.name);
    assert.deepEqual(fixture.headings.filter(heading=>runs.every(run=>run.missing.includes(heading))),[],fixture.name);
  }
} finally { await browser.close(); server.kill(); }
