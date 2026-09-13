import test from 'node:test';
import assert from 'node:assert/strict';
import { structureInput, outlineEntries } from './mapping.js';

test('outline offsets retain blank pages, Unicode, repeated headings and rotated crop coordinates', () => {
  const line = text => ({ text, x: 10, y: 20, width: 150, height: 20 });
  const input = structureInput([
    { lines: [line('😀 Introduction')], transform: [1,0,0,-1,0,800] },
    { lines: [], transform: [1,0,0,-1,0,800] },
    { lines: [line('😀 Introduction')], transform: [0,0.5,0.5,0,40,60] },
  ]);
  const nodes = input.lines.map((line, i) => ({ id: String(i), kind: 'section', range: { start: line.start, end: line.end }, parent_id: i ? '0' : null }));
  assert.equal(input.text.slice(nodes[1].range.start, nodes[1].range.end), '😀 Introduction');
  assert.deepEqual(outlineEntries(nodes, input.lines).map(({ page, point, depth }) => ({ page, point, depth })), [
    { page: 1, point: [10,780], depth: 0 }, { page: 3, point: [50,65], depth: 1 },
  ]);
  assert.deepEqual(outlineEntries([{ id: 'bad', kind: 'heading', range: { start: 999 } }], input.lines), []);
  assert.deepEqual(outlineEntries(nodes, input.lines, true), [], 'General contents must not turn parser list sections into headings');
});

test('OCR crop coordinates become page coordinates without size heuristics', () => {
  const input = structureInput([{ width: 400, height: 600, transform: [.5,0,0,-.5,20,700],
    lines: [{ text: 'Heading', x: 40, y: 80, width: 200, height: 32 }] }],
    [{ width: 600, height: 800, transform: [1,0,0,-1,0,800] }]);
  assert.deepEqual(input.pages[0].lines[0], { text:'Heading', x:40, y:140, width:100, height:16 });
  assert.equal(input.pages[0].height, 800);
  assert.deepEqual(outlineEntries([], input.lines, true)
    .map(({title, point})=>({title,point})), [], 'raw model headings must not bypass the final graph');
});


test('contents use only final headings, preserving native IDs and hierarchy',()=>{
  const input=structureInput([{transform:[1,0,0,-1,0,800],lines:[
    {id:'native-heading',text:'Introduction',x:50,y:80,width:200,height:20},
    {id:'native-subheading',text:'Definitions',x:50,y:150,width:200,height:16},
    {id:'native-note',text:'1 A footnote citation',x:50,y:750,width:300,height:8},
  ]}]);
  const nodes=[
    {id:'h1',kind:'heading',label:'Introduction',line_ids:['native-heading'],range:{start:0,end:12}},
    {id:'h2',kind:'heading',label:'Definitions',parent_id:'h1',line_ids:['native-subheading'],range:{start:13,end:24}},
    {id:'n1',kind:'footnote',line_ids:['native-note'],range:{start:25,end:45}},
  ];
  assert.deepEqual(outlineEntries(nodes,input.lines,true).map(({title,depth,point})=>({title,depth,point})),[
    {title:'Introduction',depth:0,point:[50,720]}, {title:'Definitions',depth:1,point:[50,650]},
  ]);
  nodes[0].parent_id='s1';nodes[1].parent_id='s2';
  nodes.push({id:'s1',kind:'section'},{id:'s2',kind:'section',parent_id:'s1'});
  assert.deepEqual(outlineEntries(nodes,input.lines,true).map(entry=>entry.depth),[0,1]);
});
