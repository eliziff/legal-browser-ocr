import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFNumber, PDFString, degrees } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createSearchablePdf } from './pdf-export.js';
import { cropToPdfTransform } from './text-layer.js';

const load = bytes => getDocument({data:Uint8Array.from(bytes)}).promise;
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-6, `${a} != ${b}`);
const allText = async page => (await page.getTextContent({disableNormalization:true})).items.filter(item => 'str' in item);
async function pixels(page) {
  const viewport=page.getViewport({scale:1}), canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
  const context=canvas.getContext('2d');
  await page.render({canvasContext:context,viewport}).promise;
  return Buffer.from(context.getImageData(0,0,canvas.width,canvas.height).data);
}
function scanPng() {
  const canvas=createCanvas(600,800), context=canvas.getContext('2d');
  context.fillStyle='#fff';context.fillRect(0,0,600,800);
  context.fillStyle='#222';context.font='24px serif';context.fillText('Legal OCR - original scan',60,110);
  context.strokeRect(40,50,520,680);
  return canvas.toBuffer('image/png');
}

for (const rotation of [0,90,180,270]) {
  test(`export preserves original pixels and aligns cropped text on a ${rotation}-degree page`, async () => {
    const source=await PDFDocument.create(), page=source.addPage([600,800]);
    source.setTitle('Original scan');
    const image=await source.embedPng(scanPng());
    page.drawImage(image,{x:0,y:0,width:600,height:800});
    page.setCropBox(40,50,520,680);page.setRotation(degrees(rotation));
    if(rotation===270)page.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));
    const annotation=source.context.register(source.context.obj({
      Type:'Annot',Subtype:'Text',Rect:[50,70,80,90],Contents:PDFString.of('Keep this annotation'),
    }));
    page.node.set(PDFName.of('Annots'),source.context.obj([annotation]));
    const original=await source.save(), before=await load(original);
    const viewport=(await before.getPage(1)).getViewport({scale:2});
    const area={x:41.25,y:63.75,w:600.4,h:400.2};
    const line={x:20,y:25,width:450,height:24,text:'Québec — § 7; αβ 中文 😀'};
    const pages=[{transform:cropToPdfTransform(viewport.transform,area,600,400),lines:[line]}];
    const exported=await createSearchablePdf({pdfBytes:original,pages}), after=await load(exported);
    try {
      assert.deepEqual(await allText(await before.getPage(1)), []);
      const items=await allText(await after.getPage(1));
      assert.equal(items.map(item=>item.str).join(''),line.text);
      const item=items.find(item=>item.str), matrix=Util.transform(viewport.transform,item.transform);
      close(matrix[4],area.x+line.x*area.w/600);
      close(matrix[5],area.y+(line.y+0.8*line.height)*area.h/400);
      close(Math.hypot(matrix[2],matrix[3]),line.height*area.h/400);
      close(item.width*Math.hypot(matrix[0],matrix[1])/Math.hypot(item.transform[0],item.transform[1]),line.width*area.w/600);
      assert.deepEqual(await pixels(await after.getPage(1)),await pixels(await before.getPage(1)));
      const reopened=await PDFDocument.load(exported);
      assert.equal(reopened.getTitle(),'Original scan');
      assert.deepEqual(reopened.getPage(0).getCropBox(),page.getCropBox());
      assert.equal(reopened.getPage(0).getRotation().angle,rotation);
      assert.equal(reopened.getPage(0).node.Annots().size(),1);
      if(process.env.OCR_TEST_ARTIFACTS){
        mkdirSync(process.env.OCR_TEST_ARTIFACTS,{recursive:true});
        writeFileSync(`${process.env.OCR_TEST_ARTIFACTS}/original-${rotation}.pdf`,original);
        writeFileSync(`${process.env.OCR_TEST_ARTIFACTS}/searchable-${rotation}.pdf`,exported);
      }
    } finally {await before.loadingTask.destroy();await after.loadingTask.destroy()}
  });
}

test('preserves page order, blank pages, and exports afresh without duplicating OCR', async () => {
  const source=await PDFDocument.create();
  for(let i=0;i<3;i++)source.addPage([300,400]);
  const original=await source.save();
  const pages=['First page','','Third page'].map(text=>({transform:[1,0,0,-1,0,400],
    lines:text?[{x:30,y:40,width:200,height:20,text}]:[]}));
  for(let n=0;n<2;n++){
    const pdf=await load(await createSearchablePdf({pdfBytes:original,pages}));
    try{
      assert.equal(pdf.numPages,3);
      for(let i=0;i<3;i++)assert.equal((await allText(await pdf.getPage(i+1))).map(item=>item.str).join(''),['First page','','Third page'][i]);
    }finally{await pdf.loadingTask.destroy()}
  }
  await assert.rejects(createSearchablePdf({pdfBytes:original,pages:pages.slice(1)}),/every page/);
  await assert.rejects(createSearchablePdf({pdfBytes:original,pages:new Array(3)}),/every page/);
});

test('PNG export embeds the original image and keeps all Unicode across font subsets', async () => {
  const png=scanPng(),text=Array.from({length:300},(_,i)=>String.fromCodePoint(0x4e00+i)).join('')+' éﬃ😀';
  const output=await createSearchablePdf({pngBytes:png,pages:[{transform:[1,0,0,-1,0,800],
    lines:[{x:40,y:90,width:500,height:20,text}]}]});
  const pdf=await load(output);
  try{
    assert.equal((await allText(await pdf.getPage(1))).map(item=>item.str).join(''),text);
    const source=await PDFDocument.create(),image=await source.embedPng(png);
    source.addPage([600,800]).drawImage(image,{x:0,y:0,width:600,height:800});
    const before=await load(await source.save());
    try{assert.deepEqual(await pixels(await pdf.getPage(1)),await pixels(await before.getPage(1)))}finally{await before.loadingTask.destroy()}
  }finally{await pdf.loadingTask.destroy()}
});

test('rejects invalid inputs and broken line geometry', async () => {
  await assert.rejects(createSearchablePdf({pages:[]}),/one PDF or PNG/);
  await assert.rejects(createSearchablePdf({pdfBytes:new Uint8Array([1,2]),pages:[]}),/PDF/);
  await assert.rejects(createSearchablePdf({pngBytes:scanPng(),pages:[{
    transform:[1,0,0,-1,0,800],lines:[{x:0,y:0,width:NaN,height:20,text:'broken'}],
  }]}),/Invalid OCR/);
});
