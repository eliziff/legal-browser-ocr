import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

for (const name of ['layout-model.json', 'layout-fast-model.json']) {
  const manifest = JSON.parse(readFileSync(new URL('assets/' + name, import.meta.url), 'utf8'));
  const target = new URL('assets/' + manifest.localFile, import.meta.url);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  if (existsSync(target) && hash(readFileSync(target)) === manifest.sha256) {
    console.log(manifest.localFile + ': verified'); continue;
  }
  const url = 'https://huggingface.co/' + manifest.repository + '/resolve/' + manifest.revision + '/' + manifest.file;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Download failed: ' + response.status + ' ' + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== manifest.sha256) throw new Error('Model checksum mismatch: ' + name);
  writeFileSync(target, bytes);
  console.log(manifest.localFile + ': downloaded and verified');
}
