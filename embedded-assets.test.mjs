import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createEmbeddedAssets } from './embedded-assets.js';

test('packaged bytes survive native and JavaScript decompression exactly', async t => {
  const source = Buffer.from('Juniper inventory 482\nMaple balance 716');
  const values = { compressed: gzipSync(source).toString('base64'), raw: source.toString('base64') };
  const assets = createEmbeddedAssets(values, ['compressed']);
  assert.deepEqual(Buffer.from(await assets.bytes('compressed')), source);
  assert.deepEqual(Buffer.from(await assets.bytes('raw')), source);
  const previous = globalThis.DecompressionStream;
  t.after(() => { globalThis.DecompressionStream = previous; });
  globalThis.DecompressionStream = undefined;
  assert.deepEqual(Buffer.from(await assets.bytes('compressed')), source);
});

test('shared asset URLs contain decoded bytes and are released by their owner', async () => {
  const source = Buffer.from('Independently invented archive contents');
  const assets = createEmbeddedAssets({ fixture: gzipSync(source).toString('base64') }, ['fixture']);
  const [first, second] = await Promise.all([assets.url('fixture', 'application/octet-stream'), assets.url('fixture', 'application/octet-stream')]);
  assert.equal(first, second);
  assert.deepEqual(Buffer.from(await (await fetch(first)).arrayBuffer()), source);
  await assets.dispose();
  await assert.rejects(fetch(first));
});

test('damaged compressed bytes fail with the owning asset name', async () => {
  const assets = createEmbeddedAssets({ fixture: Buffer.from('not a gzip stream').toString('base64') }, ['fixture']);
  await assert.rejects(assets.bytes('fixture'), /Could not decompress packaged asset fixture/);
});

test('file-origin worker URLs carry complete binary assets without cross-origin blob fetches', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'file:' } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; });
  const source = Buffer.from(Uint8Array.from({ length: 100_000 }, (_, index) => index % 256));
  const assets = createEmbeddedAssets({ fixture: gzipSync(source).toString('base64') }, ['fixture']);
  const url = await assets.url('fixture', 'application/wasm');
  assert.ok(url.startsWith('data:application/wasm;base64,'));
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), source);
  await assets.dispose();
});
