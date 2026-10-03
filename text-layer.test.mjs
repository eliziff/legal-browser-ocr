import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanModelText, positionedLines, cropToPdfTransform, lineTextMatrix, unicodeHex } from './text-layer.js';

const point = ([a,b,c,d,e,f], x, y) => [a*x+c*y+e,b*x+d*y+f];
const close = (actual, expected) => actual.forEach((value, i) => assert.ok(Math.abs(value-expected[i])<1e-8, `${actual} != ${expected}`));

test('retains unpadded ink geometry and empty-line correspondence', () => {
  assert.deepEqual(positionedLines([
    {x:1,y:2,width:30,height:20,ocrBox:{x:5,y:6,width:22,height:8}},
    {x:10,y:20,width:20,height:10},
    {width:100,height:48},
  ], ['Québec § 7', '', 'no\u00ad segmentation']), [
    {x:5,y:6,width:22,height:8,text:'Québec § 7'},
    {x:0,y:0,width:100,height:48,text:'no segmentation'},
  ]);
  assert.throws(() => positionedLines([{}], []), /count mismatch/);
  assert.equal(cleanModelText('inter\u00ad\nnational\u00ac'), 'international');
});

for (const viewport of [[2,0,0,-2,-40,1600], [0,2,2,0,-100,-40], [-2,0,0,2,1200,-50], [0,-2,-2,0,1600,1200]]) {
  test(`round-trips rotated and translated viewport ${viewport}`, () => {
    const inverse = cropToPdfTransform(viewport);
    close(point(viewport, ...point(inverse, 32, 48)), [32,48]);
    const area = {x:25.75,y:48.25,w:101.4,h:80.6};
    const cropped = cropToPdfTransform(viewport, area, 101, 81);
    close(point(viewport, ...point(cropped, 10,20)), [area.x+10*area.w/101,area.y+20*area.h/81]);
    const matrix = lineTextMatrix({x:10,y:20,width:50,height:10,text:'test'}, cropped);
    close(point(viewport, ...point(matrix, 0,0.8)), [area.x+10*area.w/101,area.y+20*area.h/81]);
    close(point(viewport, ...point(matrix, 4,-0.2)), [area.x+60*area.w/101,area.y+30*area.h/81]);
  });
}

test('rejects invalid geometry rather than exporting unusable text', () => {
  assert.throws(() => cropToPdfTransform([0,0,0,0,0,0]), /Singular/);
  assert.throws(() => cropToPdfTransform([1,0,0,1,0,NaN]), /Invalid/);
  assert.throws(() => cropToPdfTransform([1,0,0,1,0,0], {x:0,y:0,w:1,h:1}, 0, 1), /Invalid/);
  assert.throws(() => lineTextMatrix({x:0,y:0,width:0,height:1,text:'x'}, [1,0,0,1,0,0]), /Invalid/);
});

test('ToUnicode encodes accents, symbols, ligatures and supplementary characters without loss', () => {
  assert.equal(unicodeHex('é§ﬃ😀'), '00E900A7FB03D83DDE00');
});

test('OCR cleanup preserves literal negation, quotations and bilingual citations', () => {
  for (const text of ['« ¬p signifie non p »; 2025 CSC 18', '“¬” and “national¬”',
    '¬(P ∧ Q)', 'P ∧ ¬Q', 'alpha¬beta', 'P¬\nQ', 'p¬\nq', 'a hard-\nhyphen',
    'R. c. Co\u0302té, 2025\u00a0CSC\u00a018; « déjà vu 🧭 »']) {
    assert.equal(cleanModelText(text), text);
  }
  assert.equal(cleanModelText('inter¬\nnational¬'), 'international');
  assert.equal(cleanModelText('national¬  '), 'national  ');
  assert.equal(cleanModelText('ab¬\nc¬\nde'), 'abcde');
  for (const text of ['a'.repeat(30000), '¬ '+ 'a'.repeat(30000)]) {
    assert.equal(cleanModelText(text), text);
  }
});

test('discretionary wraps consume one logical boundary and preserve blank paragraphs', () => {
  for (const boundary of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    const text='e\u0301\u00ad \t'+boundary+'\u202fcole';
    assert.equal(cleanModelText(text), 'e\u0301cole');
    assert.equal(cleanModelText('inter\u00ad'+boundary+boundary+'national'), 'inter'+boundary+boundary+'national');
    assert.equal(cleanModelText('§\u00ad'+boundary+'7'), '§'+boundary+'7');
  }
  assert.equal(cleanModelText('inter\u00ad\nna\u00ad\ntional'), 'international');
});

test('positioned lines fold logical breaks once without changing geometry or source spacing', () => {
  const line={x:3,y:7,width:80,height:12};
  for (const boundary of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    assert.deepEqual(positionedLines([line], ['Québec'+boundary+'« ¬p »\u00a0  CSC']),
      [{...line,text:'Québec « ¬p »\u00a0  CSC'}]);
  }
});
