import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.deepEqual(outlineEntries(nodes, input.lines, []), [], 'General contents must not turn parser list sections into headings');
});

test('the pinned WASM engine detects actual agreement sections', async () => {
  const wasm = readFileSync(new URL('./target/wasm32-unknown-unknown/release/browser_structure.wasm', import.meta.url));
  const { instance: { exports: api } } = await WebAssembly.instantiate(wasm);
  const text = '1. Definitions\nThis agreement defines the terms.\n2. Payment\nThe buyer shall pay the price.\n3. Termination\nEither party may terminate.\n';
  const line = (text, y, height = 20) => ({ text, x: 50, y, width: 400, height });
  const payload = { text, pages: [{ width: 600, height: 800, lines: [
    line('1. Definitions', 80, 32), line('This agreement defines the terms.', 130),
    line('2. Payment', 180, 32), line('The buyer shall pay the price.', 230),
    line('3. Termination', 280, 32), line('Either party may terminate.', 330),
  ] }] };
  const bytes = new TextEncoder().encode(JSON.stringify(payload)), ptr = api.allocate(bytes.length);
  new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
  const packed = api.detect(ptr, bytes.length, 0);
  const output = Number(packed & 0xffffffffn), length = Number(packed >> 32n);
  const result = JSON.parse(new TextDecoder().decode(new Uint8Array(api.memory.buffer, output, length)));
  api.release(output, length); api.release(ptr, bytes.length);
  assert.equal(result.error, undefined);
  assert.equal(result.offset_unit, 'utf16');
  const sections = result.nodes.filter(node => ['heading','section'].includes(node.kind));
  assert.ok(sections.some(node => text.slice(node.range.start).startsWith('2. Payment')), JSON.stringify(sections));
});

test('OCR crop coordinates become page coordinates without size heuristics', () => {
  const input = structureInput([{ width: 400, height: 600, transform: [.5,0,0,-.5,20,700],
    lines: [{ text: 'Heading', x: 40, y: 80, width: 200, height: 32 }] }],
    [{ width: 600, height: 800, transform: [1,0,0,-1,0,800] }]);
  assert.deepEqual(input.pages[0].lines[0], { text:'Heading', x:40, y:140, width:100, height:16 });
  assert.equal(input.pages[0].height, 800);
  assert.deepEqual(outlineEntries([], input.lines, [{ id:'p1-l1',region_id:'r1',region_type:'paragraph_title' }])
    .map(({title, point})=>({title,point})), [{title:'Heading',point:[40,660]}]);
});

test('upstream region assignments survive derivation and require complete coverage', async () => {
  const wasm = readFileSync(new URL('./target/wasm32-unknown-unknown/release/browser_structure.wasm', import.meta.url));
  const { instance: { exports: api } } = await WebAssembly.instantiate(wasm);
  const lines = ['Introduction', 'This is ordinary body text with a complete sentence.', 'Background', 'Another ordinary sentence describes the background.']
    .map((text, i) => ({ text, x: 50, y: 80 + i * 60, width: 450, height: 20 }));
  const payload = { text: lines.map(line => line.text).join('\n'), pages: [{ width: 600, height: 800, lines,
    layout: { width: 600, height: 800, detections: lines.map((line, i) => ({
      label: i % 2 ? 'text' : 'paragraph_title', score: .95,
      bbox: [40, line.y - 5, 520, line.y + 30],
    })) },
  }] };
  function detect() {
    const bytes = new TextEncoder().encode(JSON.stringify(payload)), ptr = api.allocate(bytes.length);
    new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
    const packed = api.detect(ptr, bytes.length, 0), output = Number(packed & 0xffffffffn), length = Number(packed >> 32n);
    const result = JSON.parse(new TextDecoder().decode(new Uint8Array(api.memory.buffer, output, length)));
    api.release(output, length); api.release(ptr, bytes.length);
    return result;
  }
  const result = detect();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.layout_lines.map(line => line.region_type), ['paragraph_title', 'text', 'paragraph_title', 'text']);
  // This pinned parser drops equal-size unnumbered headings during classify.
  // Preserve the model's evidence separately rather than inventing font sizes.
  assert.deepEqual(result.nodes.filter(node => node.kind === 'heading'), []);
  payload.pages[0].layout.detections = [];
  const incomplete = detect();
  assert.equal(incomplete.layout_complete, false);
  assert.equal(incomplete.unclassified_lines.length, 4);
  assert.deepEqual(incomplete.layout_lines, []);
  assert.deepEqual(incomplete.nodes.filter(node => node.kind === 'heading'), []);
});
