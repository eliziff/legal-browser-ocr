import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, degrees, rgb, PDFName, PDFString, PDFNumber } from 'pdf-lib';
import { drawScanPage } from './experiments/ocr-speed/scan-pages.js';

test('scan image path matches rendered pixels and defers overlays, annotations and cropping', async () => {
  const previousCanvas=globalThis.OffscreenCanvas,previousData=globalThis.ImageData;
  globalThis.OffscreenCanvas=class {constructor(w,h){return createCanvas(w,h)}};
  globalThis.ImageData=ImageData;
  let pdf;
  try {
    const source=await PDFDocument.create();
    for(const [width,height,rotation]of [[1200,1600,0],[1200,1600,90],[1200,1600,180],[1200,1600,270],[2480,3300,0],[1201,1601,0]]){
      const image=createCanvas(width,height),ctx=image.getContext('2d');
      ctx.fillStyle='white';ctx.fillRect(0,0,width,height);ctx.fillStyle='#1b3b62';ctx.font='40px serif';ctx.fillText('Juniper receipts 482',70,150);
      ctx.fillStyle='#772022';ctx.fillRect(width-110,height-170,47,63);
      const embedded=await source.embedPng(image.toBuffer('image/png'));
      const page=source.addPage([600,800]);page.drawImage(embedded,{x:0,y:0,width:600,height:800});page.setRotation(degrees(rotation));
      if(rotation===270)page.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));
    }
    const image=await source.embedPng(createCanvas(120,160).toBuffer('image/png'));
    for(const kind of ['overlay','annotation','crop','blank','multiple']){
      const page=source.addPage([600,800]);
      if(kind!=='blank')page.drawImage(image,{x:0,y:0,width:600,height:800});
      if(kind==='overlay')page.drawRectangle({x:10,y:20,width:30,height:40,color:rgb(1,0,0)});
      if(kind==='annotation')page.node.set(PDFName.of('Annots'),source.context.obj([source.context.register(source.context.obj({Type:'Annot',Subtype:'Text',Rect:[40,40,60,60],Contents:PDFString.of('Review scan')}))]));
      if(kind==='crop')page.setCropBox(50,50,500,700);
      if(kind==='multiple')page.drawImage(image,{x:5,y:5,width:60,height:80});
    }
    pdf=await getDocument({data:await source.save()}).promise;
    for(let n=1;n<=pdf.numPages;n++){
      const page=await pdf.getPage(n),viewport=page.getViewport({scale:2});
      const candidate=createCanvas(Math.round(viewport.width),Math.round(viewport.height));
      const accepted=await drawScanPage(page,viewport,candidate);
      assert.equal(accepted,n<=6,`page ${n} eligibility`);
      if(!accepted)continue;
      const control=createCanvas(candidate.width,candidate.height);
      await page.render({canvasContext:control.getContext('2d'),viewport}).promise;
      const pixels=canvas=>Buffer.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);
      assert.equal(pixels(candidate).equals(pixels(control)),true,`page ${n} pixels`);
      if(n===1){
        const fallback=createCanvas(candidate.width,candidate.height),context=fallback.getContext('2d'),draw=context.drawImage;
        context.drawImage=()=>{throw Error('Invented accelerated image-draw failure')};
        try{assert.equal(await drawScanPage(page,viewport,fallback),false)}
        finally{context.drawImage=draw}
        await page.render({canvasContext:context,viewport}).promise;
        assert.equal(pixels(fallback).equals(pixels(control)),true,'ordinary rendering recovers after the fast path fails');
      }
    }
  }finally{
    await pdf?.destroy();globalThis.OffscreenCanvas=previousCanvas;globalThis.ImageData=previousData;
  }
});
