import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = new URL('../../', import.meta.url);
const metadata = spawnSync('cargo', ['metadata', '--manifest-path', 'experiments/structure-reader/Cargo.toml', '--format-version', '1', '--offline', '--locked'], { cwd: root, encoding: 'utf8' });
if (metadata.status) throw new Error(metadata.stderr);
const upstream = JSON.parse(metadata.stdout).packages.find(pkg => pkg.name === 'legal-pdf-support');
if (!upstream) throw new Error('Pinned legal-pdf-support source is missing');
const upstreamLock = readFileSync(join(dirname(upstream.manifest_path), '..', 'Cargo.lock'), 'utf8');
for (const name of ['pdf-inspector', 'legal-structure']) {
  const block = upstreamLock.split('[[package]]').find(block => block.includes(`name = "${name}"`));
  const source = block?.match(/source = "([^"]+)"/)?.[1];
  if (!source || JSON.parse(metadata.stdout).packages.find(pkg => pkg.name === name)?.source !== source)
    throw new Error(`${name} must match the pinned upstream lockfile revision`);
}
const env = { ...process.env };
// These pure functions currently share a file with the native session loader.
// Select verbatim pinned source at build time; never maintain another port.
const native = readFileSync(join(dirname(upstream.manifest_path), 'src', 'ppdoc.rs'), 'utf8').replaceAll('\r\n', '\n');
const section = (start, end) => {
  const a = native.indexOf(start), b = native.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error('Upstream layout API changed; review the pinned source');
  return native.slice(a, b);
};
const pure = section('const INTER_RESIZE_COEF_SCALE:', '\n') +
  '\n' + section('#[derive(Clone, Copy)]\nstruct CubicSample', 'fn resize_bilinear_nchw(') +
  section('fn cubic_samples(', 'fn required_path(');
const generated = fileURLToPath(new URL('target/upstream-inference.rs', import.meta.url));
mkdirSync(dirname(generated), { recursive: true });
if (!existsSync(generated) || readFileSync(generated, 'utf8') !== pure) writeFileSync(generated, pure);
env.LEGAL_BROWSER_INFERENCE = generated;
const checking = process.argv.includes('--check');
const result = spawnSync('cargo', [checking ? 'check' : 'build', '--lib', '--manifest-path', 'experiments/structure-reader/Cargo.toml', '--target', 'wasm32-unknown-unknown', ...checking ? [] : ['--release'], '--locked'], { cwd: root, stdio: 'inherit', env });
if (result.error) throw result.error;
if (result.status) process.exit(result.status);
if (checking) process.exit(0);
const bindgenVersion=JSON.parse(metadata.stdout).packages.find(pkg=>pkg.name==='wasm-bindgen').version;
const localBindgen=fileURLToPath(new URL(`target/tools/wasm-bindgen-${bindgenVersion}-x86_64-pc-windows-msvc/wasm-bindgen.exe`,import.meta.url));
const bindgen=process.env.WASM_BINDGEN || (existsSync(localBindgen)?localBindgen:'wasm-bindgen');
const binding=spawnSync(bindgen,['--target','web','--omit-default-module-path','--keep-lld-exports','--out-dir','experiments/structure-reader/target/bindgen','experiments/structure-reader/target/wasm32-unknown-unknown/release/browser_structure.wasm'],{cwd:root,stdio:'inherit'});
if(binding.error)throw binding.error;
if(binding.status)process.exit(binding.status);
const worker = await build({ entryPoints: [fileURLToPath(new URL('worker.js', import.meta.url))], bundle: true, format: 'iife', write: false, minify: true });
await build({ absWorkingDir: fileURLToPath(root), entryPoints: ['experiments/structure-reader/reader.js'], bundle: true, format: 'esm', minify: true, loader: { '.css': 'text' }, outfile: 'dist/structure-reader.js' });
const assets = { worker: worker.outputFiles[0].text, wasm: readFileSync(new URL('target/bindgen/browser_structure_bg.wasm', import.meta.url)).toString('base64') };
assets.revision = createHash('sha256').update(assets.wasm).update(assets.worker).digest('hex');
const source = readFileSync(new URL('dist/legal-browser-ocr.html', root), 'utf8');
const app = readFileSync(new URL('dist/structure-reader.js', root), 'utf8').replaceAll('</script', '<\\/script');
assets.models = {};
assets.runtime = {};
const pdfData = {};
for (const [kind, directory] of Object.entries({wasmUrl:'wasm',cMapUrl:'cmaps',standardFontDataUrl:'standard_fonts'})) {
  pdfData[kind] = {};
  const path = new URL('node_modules/pdfjs-dist/' + directory + '/', root);
  for (const file of readdirSync(path).filter(name=>!name.startsWith('LICENSE')))
    pdfData[kind][file] = readFileSync(new URL(file,path)).toString('base64');
}
const pdfOptions = `const pdfData=${JSON.stringify(pdfData)};globalThis.LEGAL_PDF_OPTIONS={useWorkerFetch:false,cMapPacked:true,BinaryDataFactory:class{async fetch({kind,filename}){const data=pdfData[kind]?.[filename];if(!data)throw Error('Missing packaged PDF asset: '+filename);return Uint8Array.fromBase64(data);}}};`;
const packageDir = fileURLToPath(new URL('dist/legal-browser-ocr-structure/', root));
mkdirSync(packageDir, { recursive: true });
for (const manifest of ['layout-model.json', 'layout-fast-model.json']) {
  const model = JSON.parse(readFileSync(new URL('assets/' + manifest, import.meta.url), 'utf8'));
  const modelBytes = readFileSync(new URL('assets/' + model.localFile, import.meta.url));
  if (createHash('sha256').update(modelBytes).digest('hex') !== model.sha256) throw new Error('Layout model SHA-256 mismatch: ' + manifest);
  assets.models[model.variant === 0 ? 'accurate' : 'fast'] = modelBytes.toString('base64');
}
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  assets.runtime[name.endsWith('.mjs') ? 'mjs' : 'wasm'] = 'data:' + (name.endsWith('.mjs') ? 'application/javascript' : 'application/wasm') + ';base64,' + readFileSync(new URL('node_modules/onnxruntime-web/dist/' + name, root)).toString('base64');
}
const html = source.replace(/<script type="module">[\s\S]*?<\/script>/, () => `<script>${pdfOptions}globalThis.LEGAL_STRUCTURE_ASSETS=${JSON.stringify(assets)}</script><script type="module">${app}</script>`);
writeFileSync(join(packageDir, 'index.html'), html);
for (const name of ['Start.ps1', 'README.md']) copyFileSync(new URL(name, import.meta.url), join(packageDir, name));
cpSync(new URL('licenses/', import.meta.url), join(packageDir, 'licenses'), { recursive: true });
copyFileSync(new URL('LICENSE', root), join(packageDir, 'LICENSE'));
copyFileSync(new URL('README.md', root), join(packageDir, 'OCR-README.md'));
for (const name of ['pdfjs-dist', 'pdf-lib', '@pdf-lib/standard-fonts', '@pdf-lib/upng', 'pako']) {
  const directory = fileURLToPath(new URL('node_modules/' + name + '/', root));
  for (const file of readdirSync(directory).filter(file => /^(LICENSE|NOTICE)/i.test(file)))
    copyFileSync(join(directory, file), join(packageDir, 'licenses', name.replaceAll('/', '-') + '-' + file));
}
for (const pkg of JSON.parse(metadata.stdout).packages) {
  const directory = dirname(pkg.manifest_path);
  for (const file of readdirSync(directory).filter(file => /^(LICENSE|NOTICE)(\.|$|-)/i.test(file))) {
    try { copyFileSync(join(directory, file), join(packageDir, 'licenses', pkg.name + '-' + pkg.version + '-' + file)); }
    catch (error) { if (error.code !== 'EISDIR') throw error; }
  }
}
console.log('dist/legal-browser-ocr-structure/');
