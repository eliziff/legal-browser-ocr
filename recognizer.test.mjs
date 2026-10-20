import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeClassIds, decodeSequence, inkBounds, packLines, recognizerProfile, LineRecognizer } from './recognizer.js';
import {createCanvas} from '@napi-rs/canvas';

test('trained CTC outputs use time before classes, blank zero, and each line length', () => {
  const ids = [[1, 1, 0, 1, 2, 2], [2, 0, 2, 1, 1, 1]];
  const output = { dims: [2, 6, 3], data: Float32Array.from(ids.flatMap(row => row.flatMap(id => [0, 1, 2].map(c => c === id ? 4 : -4)))) };
  assert.equal(decodeSequence(output, 0, 5, ['', 'a', 'b']).text, 'aab');
  const compact = { dims: [2, 6], data: BigInt64Array.from(ids.flat(), BigInt) };
  assert.equal(decodeClassIds(compact, 0, 5, ['', 'a', 'b']).text, 'aab');
  assert.equal(decodeClassIds(compact, 1, 3, ['', 'a', 'b']).text, 'bb');
  const result = decodeSequence(output, 1, 3, ['', 'a', 'b'], true);
  assert.equal(result.text, 'bb');
  assert.ok(result.confidence > .99 && result.confidence <= 1);
});

test('CRNN replicates grayscale into normalized RGB and pads with normalized black', () => {
  const profile = { ...recognizerProfile('crnn'), height: 1 };
  const output = packLines([{ width: 2, gray: Uint8Array.of(0, 255) }], profile, 3);
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(output[c * 3] + profile.mean[c] / profile.std[c]) < 1e-6);
    assert.ok(Math.abs(output[c * 3 + 1] - (1 - profile.mean[c]) / profile.std[c]) < 1e-6);
    assert.equal(output[c * 3 + 2], output[c * 3]);
  }
  assert.deepEqual([...packLines([{ width: 2, gray: Uint8Array.of(0, 255) }], { ...recognizerProfile('indra'), height: 1 }, 3)], [1, 0, 0]);
});

test('Indra finds the ink box before adding margins based on ink height', () => {
  const rgba = new Uint8Array(10 * 10 * 4).fill(255);
  for (let y = 3; y < 7; y++) for (let x = 2; x < 8; x++) rgba.fill(0, (y * 10 + x) * 4, (y * 10 + x) * 4 + 3);
  assert.deepEqual(inkBounds(rgba, 10, 10), { x: 2, y: 3, width: 6, height: 4, px: 2, py: 1 });
  assert.throws(() => recognizerProfile('unknown'), /Unknown recognizer/);
});

test('ink bounds retain isolated, edge and threshold pixels without counting pale colors', () => {
  const rgba = new Uint8Array(11 * 7 * 4).fill(255);
  assert.deepEqual(inkBounds(rgba, 11, 7), { x: 0, y: 0, width: 11, height: 7, px: 0, py: 0 });
  const pixel = (x, y, rgb) => rgba.set([...rgb, 0], (y * 11 + x) * 4);
  pixel(0, 0, [219, 220, 220]); // Rounded mean is 220.
  pixel(10, 6, [219, 219, 221]);
  pixel(3, 2, [219, 219, 220]); // Rounded mean is 219.
  assert.deepEqual(inkBounds(rgba, 11, 7), { x: 3, y: 2, width: 1, height: 1, px: 1, py: 1 });
  pixel(0, 4, [0, 0, 0]);
  pixel(10, 1, [255, 0, 255]);
  assert.deepEqual(inkBounds(rgba, 11, 7), { x: 0, y: 1, width: 11, height: 4, px: 2, py: 1 });
});

test('page preparation preserves fractional crop sampling and resize pixels', () => {
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class {constructor(w,h){return createCanvas(w,h)}};
  try{
    const source=createCanvas(160,130),context=source.getContext('2d');
    context.fillStyle='white';context.fillRect(0,0,160,130);
    context.fillStyle='#193b72';context.font='15px serif';
    context.fillText('Cedar ledger 318',7.3,27.8);context.fillText('April total 629',11.1,62.4);
    context.fillRect(0,99,160,2);
    const lines=[
      {source,x:1.25,y:6.6,width:151.3,height:26.7},
      {source,x:2.8,y:42.25,width:145.7,height:26.2},
      {source,x:0,y:92.5,width:160,height:17.6},
      {source,x:11.1,y:111.2,width:70.3,height:8.1},
    ];
    const control=new LineRecognizer({}, {},recognizerProfile('indra'),{});
    const expected=lines.map(line=>control.prepare(line,1));
    assert.deepEqual(control.preparePage(source,lines.map(({source,...line})=>line),1),expected);
    assert.deepEqual(control.prepareLines([...lines,...lines],1),[...expected,...expected]);
  }finally{globalThis.OffscreenCanvas=previous}
});

test('prepared inference restores line order and releases tensors on success and provider failure', async () => {
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class {constructor(w,h){return createCanvas(w,h)}};
  try{
    for(const separatelyPrepared of [false,true])for(const failure of [false,true]){
      const allocated=[];
      class Tensor {
        constructor(type,data,dims){Object.assign(this,{type,data,dims,disposed:false});allocated.push(this)}
        dispose(){assert.equal(this.disposed,false);this.disposed=true}
      }
      let calls=0;
      const session={outputNames:['class_ids','lengths'],async run(feeds){
        calls++;if(failure&&calls===2)throw Error('deliberate provider failure');
        const ids=new Tensor('int64',BigInt64Array.of(feeds.widths.data[0]/8n),[1,1]);
        return {class_ids:ids,lengths:new Tensor('int64',BigInt64Array.of(1n),[1])};
      }};
      const recognizer=new LineRecognizer({Tensor},session,{...recognizerProfile('indra'),height:1},{1:'a',2:'b',3:'c'});
      recognizer.prepareLines=()=>[24,8,16].map(width=>({width,gray:new Uint8Array(width)}));
      const result=separatelyPrepared
        ?recognizer.recognizePrepared(recognizer.prepareLines(),{batchSize:1,sortedBatches:true})
        :recognizer.recognize([{}, {}, {}],1,{batchSize:1,sortedBatches:true});
      if(failure)await assert.rejects(result,/deliberate/);
      else assert.deepEqual((await result).map(line=>line.text),['c','a','b']);
      assert.ok(allocated.length>0&&allocated.every(value=>value.disposed));
    }
  }finally{globalThis.OffscreenCanvas=previous}
});
