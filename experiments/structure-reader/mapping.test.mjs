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
});

test('the pinned WASM engine detects actual agreement sections', async () => {
  const wasm = readFileSync(new URL('./target/wasm32-unknown-unknown/release/browser_structure.wasm', import.meta.url));
  const { instance: { exports: api } } = await WebAssembly.instantiate(wasm);
  const text = '1. Definitions\nThis agreement defines the terms.\n2. Payment\nThe buyer shall pay the price.\n3. Termination\nEither party may terminate.\n';
  const bytes = new TextEncoder().encode(text), ptr = api.allocate(bytes.length);
  new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
  const packed = api.detect(ptr, bytes.length, 2);
  const output = Number(packed & 0xffffffffn), length = Number(packed >> 32n);
  const result = JSON.parse(new TextDecoder().decode(new Uint8Array(api.memory.buffer, output, length)));
  api.release(output, length); api.release(ptr, bytes.length);
  assert.equal(result.error, undefined);
  assert.equal(result.offset_unit, 'utf16');
  const sections = result.nodes.filter(node => ['heading','section'].includes(node.kind));
  assert.ok(sections.some(node => text.slice(node.range.start).startsWith('2. Payment')), JSON.stringify(sections));
});
