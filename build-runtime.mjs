import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, sep } from 'node:path';
import { packageAssets } from './package-assets.mjs';

const root = import.meta.dirname;
if (process.argv.length > 2) throw new Error('The release packages all five Indra tiers; no model flags are required.');
const assets = packageAssets();
const dist = resolve(root, 'dist'), output = resolve(dist, 'legal-browser-ocr-runtime');
assert.ok(output.startsWith(dist+sep));
const archive = output+'.tar.gz';
rmSync(output, { recursive: true, force: true });
rmSync(archive, { force: true });
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'index.html'), readFileSync(resolve(root, 'index.html')));
for (const asset of assets) {
  const path = resolve(output, asset.target);
  assert.ok(path.startsWith(output+sep));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, asset.bytes);
}
cpSync(resolve(dist, 'app.js'), resolve(output, 'dist/app.js'));
const result = spawnSync('tar', ['-czf', archive, '-C', output, '.'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status) process.exit(result.status);
process.stdout.write(archive+'\n');

// Native readers share the exact tier manifest and weights, without browser assets.
const modelOutput = resolve(dist, 'legal-ocr-models');
assert.ok(modelOutput.startsWith(dist+sep));
rmSync(modelOutput, { recursive: true, force: true });
mkdirSync(modelOutput, { recursive: true });
const manifest = JSON.parse(assets.find(asset => asset.key === 'packageNotice').bytes);
const modelPaths = new Set([manifest.detector.path, ...Object.values(manifest.models).flatMap(model => Object.values(model).map(asset => asset.path))]);
manifest.assets = Object.fromEntries(Object.entries(manifest.assets).filter(([path]) => modelPaths.has(path)));
for (const asset of assets.filter(asset => modelPaths.has(asset.target))) {
  const path = resolve(modelOutput, asset.target);
  assert.ok(path.startsWith(modelOutput+sep));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, asset.bytes);
}
writeFileSync(resolve(modelOutput, 'manifest.json'), JSON.stringify(manifest, null, 2)+'\n');
const modelArchive = modelOutput+'.tar.gz';
rmSync(modelArchive, { force: true });
const packed = spawnSync('tar', ['-czf', modelArchive, '-C', modelOutput, '.'], { stdio: 'inherit' });
if (packed.error) throw packed.error;
if (packed.status) process.exit(packed.status);
process.stdout.write(modelArchive+'\n');
