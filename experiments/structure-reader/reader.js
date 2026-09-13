import { getDocument } from 'pdfjs-dist/build/pdf.mjs';
import { EventBus, PDFViewer, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import pdfStyles from 'pdfjs-dist/web/pdf_viewer.css';
import { getOcrState, searchablePdf, pdfOptions, setPdfTextProvider } from '../../app.js';
import { createSearchablePdf, sourcePdfBytes } from '../../pdf-export.js';
import { cropToPdfTransform } from '../../text-layer.js';
import { structureInput, outlineEntries } from './mapping.js';
import { recentDocuments, rememberDocument, forgetDocument, activeDocument, rememberActive, rememberPage } from './recent.js';
import styles from './reader.css';
import layoutModel from './assets/layout-model.json';
import fastLayoutModel from './assets/layout-fast-model.json';

const style = document.createElement('style');
style.textContent = pdfStyles + styles; document.head.append(style);
document.body.classList.add('structure-app');
const panel = document.createElement('section'); panel.id = 'structure-reader';
panel.innerHTML = `<div class="reader-tabs"><nav class="recent-pdfs" aria-label="Open PDFs"></nav>
<button type="button" id="open-history" class="secondary compact">History</button></div>
<p id="structure-status" role="status">Processed PDFs will appear here and be remembered in this browser.</p>
<p id="storage-status" role="status"></p>
<div class="reader-body" hidden>
  <aside class="contents" id="contents-dock"><h2>Contents</h2><nav aria-label="Document contents"></nav></aside>
  <div class="reader-main"><div class="reader-toolbar">
    <button type="button" id="toggle-contents" class="secondary" aria-controls="contents-dock" aria-expanded="true">Contents</button>
    <span class="toolbar-separator" aria-hidden="true"></span>
    <label>Page <input id="reader-page" type="number" min="1" value="1" aria-label="Page number"> <span id="reader-total"></span></label>
    <label>Zoom <select id="reader-zoom"><option value="page-width">Fit width</option><option value="page-fit">Fit page</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select></label>
    <button type="button" id="reader-fullscreen" class="secondary">Full screen</button>
  </div><div class="reader-viewport"><div class="reader-scroll" tabindex="0" aria-label="PDF pages"><div class="pdfViewer"></div></div></div></div>
</div>`;
panel.insertAdjacentHTML('beforeend', `<dialog id="history-dialog" aria-labelledby="history-title"><form method="dialog"><header><h2 id="history-title">Recent PDFs</h2><button value="close" class="secondary compact">Close</button></header><div class="history-list"></div></form></dialog>
<dialog id="remove-dialog" aria-labelledby="remove-title"><form method="dialog"><h2 id="remove-title">Remove PDF?</h2><p class="remove-message"></p><div class="dialog-actions"><button value="cancel" class="secondary">Cancel</button><button value="confirm" class="danger">Remove PDF</button></div></form></dialog>`);
const form = document.getElementById('form'); form.after(panel);
const options = document.createElement('div'); options.className = 'processing-options';
for (const id of ['file','segmentation','mode']) options.append(document.getElementById(id).closest('label'));
const profileLabel = document.createElement('label');
profileLabel.innerHTML = `Document type<select id="structure-profile"><option value="0">General</option><option value="1">Legislation</option><option value="2">Contract</option></select>`;
options.append(profileLabel);
const regioningLabel = document.createElement('label');
regioningLabel.innerHTML = 'Regioning<select id="regioning"><option value="accurate">Accurate</option><option value="fast">Fast</option></select>';
options.append(regioningLabel);
const regioning = regioningLabel.querySelector('select');
const actions = document.createElement('div'); actions.className = 'processing-actions';
const button = document.createElement('button'); button.id = 'detect-structure'; button.type = 'button'; button.className = 'secondary'; button.textContent = 'Detect structure';
actions.append(document.getElementById('all'), button, document.getElementById('download'), document.getElementById('clear'));
form.append(options, actions);
const preview = document.createElement('details'); preview.id = 'ocr-preview'; preview.open = true;
preview.innerHTML = '<summary>OCR preview and text</summary>';
document.querySelector('.workspace').before(preview);
preview.append(document.querySelector('.workspace'), document.getElementById('document'));

const $ = selector => panel.querySelector(selector);
const profile = document.getElementById('structure-profile'), message = $('#structure-status'), storageMessage = $('#storage-status');
const body = $('.reader-body'), nav = $('.contents nav'), tabs = $('.recent-pdfs'), scroll = $('.reader-scroll');
const pageInput = $('#reader-page'), zoom = $('#reader-zoom'), download = document.getElementById('download');
const historyDialog = $('#history-dialog'), removeDialog = $('#remove-dialog');
const dockButton = $('#toggle-contents'), fullscreenButton = $('#reader-fullscreen');
const eventBus = new EventBus(), linkService = new PDFLinkService({ eventBus });
const viewer = new PDFViewer({ container: scroll, eventBus, linkService, maxCanvasPixels: 8_000_000, enableSelectionRendering: false });
linkService.setViewer(viewer);
let records = [], active = null, pdfTask, worker, opening = false, generation = 0, lastOcrPages;
let wasmModule;
function pageEvidence(page,viewport) {
  return {source:page.source,width:page.width,height:page.height,transform:cropToPdfTransform(viewport.transform,{x:0,y:0,w:viewport.width,h:viewport.height},page.width,page.height),
    lines:page.lines.map(line=>({id:line.id,text:line.text,x:line.bbox[0],y:line.bbox[1],width:line.bbox[2]-line.bbox[0],height:line.bbox[3]-line.bbox[1]}))};
}
setPdfTextProvider(async (file,pdf)=>{
  const assets=globalThis.LEGAL_STRUCTURE_ASSETS,bytes=new Uint8Array(await file.arrayBuffer());
  const wasm=wasmModule ? null : Uint8Array.fromBase64(assets.wasm);
  const url=URL.createObjectURL(new Blob([assets.worker],{type:'text/javascript'}));
  const extractor=new Worker(url);URL.revokeObjectURL(url);
  try {
    const result=await new Promise((resolve,reject)=>{
      extractor.onmessage=({data})=>data.error?reject(Error(data.error)):resolve(data);
      extractor.onerror=event=>reject(Error(event.message));
      extractor.postMessage({extract:bytes,wasm,module:wasmModule},[bytes.buffer,...wasm?[wasm.buffer]:[]]);
    });
    wasmModule=result.module;
    const needsOcr=new Set(result.extracted.metadata.pages_needing_ocr);
    return Promise.all(result.extracted.pages.map(async (page,index)=>needsOcr.has(index)?null:pageEvidence(page,(await pdf.getPage(index+1)).getViewport({scale:1}))));
  } finally {extractor.terminate();}
});
const preparedText = new WeakSet();
const storageError = () => { storageMessage.textContent = 'Could not remember PDFs in this browser. You can still read and download them in this session.'; };
const persist = record => rememberDocument(record).catch(storageError);

profile.addEventListener('change', controls);
function controls() {
  button.disabled = opening || Boolean(worker) || !active?.ocrPages;
  profile.disabled = opening || Boolean(worker);
  regioning.disabled = opening || Boolean(worker) || profile.value !== '0' || active?.ocrPages?.every(page => page.source === 'native');
  download.disabled = opening || !active;
}
function drawTabs() {
  tabs.replaceChildren();
  for (const record of records) {
    const item = document.createElement('span'), tab = document.createElement('button'), close = document.createElement('button');
    item.className = 'recent-tab'; tab.type = close.type = 'button'; tab.className = 'recent-pdf';
    tab.textContent = record.name; tab.title = record.name;
    close.className = 'close-tab'; close.textContent = '×'; close.setAttribute('aria-label', `Remove ${record.name} from recents`);
    close.onclick = () => confirmRemoval(record);
    if (record === active) { tab.setAttribute('aria-current', 'page'); item.classList.add('active'); }
    tab.onclick = () => { if (record !== active) void openRecord(record); };
    item.append(tab, close); tabs.append(item);
  }
}
function drawHistory() {
  const list = $('.history-list'); list.replaceChildren();
  if (!records.length) { list.textContent = 'No recent PDFs.'; return; }
  for (const record of records.slice().reverse()) {
    const row = document.createElement('div'), open = document.createElement('button'), remove = document.createElement('button');
    row.className = 'history-row'; open.type = remove.type = 'button';
    open.className = 'history-open secondary'; open.textContent = record.name;
    open.onclick = () => { historyDialog.close(); if (record !== active) void openRecord(record); };
    remove.className = 'history-remove secondary compact'; remove.textContent = 'Remove';
    remove.onclick = () => confirmRemoval(record);
    row.append(open, remove); list.append(row);
  }
}
function drawContents() {
  nav.replaceChildren();
  if (!active?.entries.length) { nav.textContent = 'Detect structure to find sections.'; return; }
  for (const entry of active.entries) {
    const link = document.createElement('button'); link.type = 'button'; link.className = 'contents-entry';
    link.textContent = entry.title;
    link.style.paddingInlineStart = `${0.5 + Math.min(entry.depth, 5)}rem`;
    link.onclick = () => {
      nav.querySelector('[aria-current]')?.removeAttribute('aria-current'); link.setAttribute('aria-current', 'location');
      viewer.scrollPageIntoView({ pageNumber: entry.page, destArray: [null, { name: 'XYZ' }, ...entry.point, null] });
    };
    nav.append(link);
  }
}
eventBus.on('pagesinit', () => {
  if (!active) return;
  viewer.currentScaleValue = zoom.value;
  viewer.currentPageNumber = Math.min(active.page || 1, viewer.pagesCount);
  pageInput.max = viewer.pagesCount; $('#reader-total').textContent = `of ${viewer.pagesCount}`;
  opening = false; controls();
});
eventBus.on('pagechanging', ({ pageNumber }) => {
  pageInput.value = pageNumber;
  if (!opening && active) { active.page = pageNumber; rememberPage(active.id, pageNumber).catch(storageError); }
});
pageInput.onchange = () => {
  const number = Number(pageInput.value);
  if (Number.isInteger(number) && number >= 1 && number <= viewer.pagesCount) viewer.currentPageNumber = number;
  else pageInput.value = viewer.currentPageNumber;
};
pageInput.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); pageInput.onchange(); } };
zoom.onchange = () => { viewer.currentScaleValue = zoom.value; };
$('#open-history').onclick = () => { drawHistory(); historyDialog.showModal(); };
dockButton.onclick = () => {
  const collapsed = body.classList.toggle('dock-collapsed');
  dockButton.setAttribute('aria-expanded', String(!collapsed));
  dockButton.classList.toggle('active', !collapsed);
  requestAnimationFrame(() => { if (viewer.pdfDocument) viewer.currentScaleValue = zoom.value; });
};
fullscreenButton.onclick = () => document.fullscreenElement ? document.exitFullscreen() : panel.requestFullscreen();
document.addEventListener('fullscreenchange', () => {
  fullscreenButton.textContent = document.fullscreenElement === panel ? 'Exit full screen' : 'Full screen';
});

async function removeRecord(record) {
  try { await forgetDocument(record.id); } catch { storageError(); return; }
  records = records.filter(item => item !== record); drawHistory();
  if (record !== active) { drawTabs(); return; }
  if (records.length) await openRecord(records.at(-1));
  else {
    generation++; worker?.terminate(); worker = null;
    viewer.setDocument(null); linkService.setDocument(null); await pdfTask?.destroy(); pdfTask = null;
    active = null; body.hidden = true; drawTabs(); controls(); await rememberActive(null).catch(storageError);
    message.textContent = 'No recent PDFs. Recognize a document to start reading.';
  }
}
function confirmRemoval(record) {
  $('.remove-message').textContent = `Remove “${record.name}” from this browser? The downloaded or original file is not affected.`;
  removeDialog.returnValue = '';
  removeDialog.onclose = () => { if (removeDialog.returnValue === 'confirm') void removeRecord(record); };
  removeDialog.showModal();
}

async function openRecord(record) {
  const token = ++generation; worker?.terminate(); worker = null;
  if (record.structureRevision !== globalThis.LEGAL_STRUCTURE_ASSETS.revision) {
    record.entries = []; record.structureStatus = '';
  }
  opening = true; active = record; controls(); drawTabs(); drawContents();
  profile.value = record.profile || '0'; preview.open = false;
  regioning.value = record.regioning || 'accurate';
  viewer.setDocument(null); linkService.setDocument(null);
  const previous = pdfTask; pdfTask = null;
  await previous?.destroy();
  if (token !== generation) return;
  try {
    let bytes = await record.blob.arrayBuffer();
    if (record.ocrPages?.length && !record.ocrPages.every(page=>page.source==='native') && !preparedText.has(record)) {
      bytes = await createSearchablePdf({pdfBytes:bytes,pages:record.ocrPages});
      record.blob = new Blob([bytes], {type:'application/pdf'}); await persist(record); preparedText.add(record);
    }
    if (token !== generation) return;
    pdfTask = getDocument({ ...pdfOptions, data: bytes });
    const pdf = await pdfTask.promise;
    if (token !== generation) return;
    body.hidden = false; linkService.setDocument(pdf); viewer.setDocument(pdf);
    message.textContent = record.structureStatus || (record.entries.length ? `${record.entries.length} sections remembered in this browser` : 'PDF ready. Detect structure to add a contents list.');
    rememberActive(record.id).catch(storageError);
  } catch (error) {
    if (token === generation) { opening = false; controls(); message.textContent = `Could not open PDF: ${error.message}`; }
  }
}

window.addEventListener('ocr-state-change', () => {
  const state = getOcrState(); controls();
  if (!state.busy && state.pages && state.pages !== lastOcrPages) {
    lastOcrPages = state.pages;
    void (async () => {
      message.textContent = 'Preparing searchable PDF…';
      try {
        const bytes = await searchablePdf();
        const record = { id: crypto.randomUUID(), name: state.name, blob: new Blob([bytes], { type: 'application/pdf' }),
          ocrPages: state.pages, sourceBlob: state.sourceFile?.type==='application/pdf'?state.sourceFile:null, entries: [], profile: profile.value, page: 1 };
        preparedText.add(record); records.push(record); await persist(record); await openRecord(record);
      } catch (error) { message.textContent = `Could not open searchable PDF: ${error.message}`; }
    })();
  }
});
button.onclick = async () => {
  if (!active?.ocrPages || worker || opening) return;
  const record = active, token = generation;
  const selectedModel = regioning.value === 'fast' ? fastLayoutModel : layoutModel;
  message.textContent = 'Detecting sections…';
  const assets = globalThis.LEGAL_STRUCTURE_ASSETS;
  const cacheKey = assets.revision + ':' + selectedModel.sha256;
  try {
    const wasm = wasmModule ? null : Uint8Array.from(atob(assets.wasm), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([assets.worker], { type: 'text/javascript' }));
    worker = new Worker(url); URL.revokeObjectURL(url); controls();
    const pdf = viewer.pdfDocument;
    const viewports = await Promise.all(record.ocrPages.map(async (_, index) => (await pdf.getPage(index + 1)).getViewport({ scale: 1 })));
    if (token !== generation) return;
    const input = structureInput(record.ocrPages, viewports);
    const source = record.sourceBlob ? new Uint8Array(await record.sourceBlob.arrayBuffer()) : await sourcePdfBytes(await record.blob.arrayBuffer());
    const result = await new Promise((resolve, reject) => {
      const currentWorker = worker;
      worker.onmessage = async ({ data }) => {
        if (token !== generation) return;
        if (data.progress) { message.textContent = data.progress; return; }
        if (data.renderPage) {
          try {
            const pdfPage = await pdf.getPage(data.renderPage);
            const viewport = pdfPage.getViewport({ scale: Math.min(1, 4096 / Math.max(viewports[data.renderPage-1].width, viewports[data.renderPage-1].height)) });
            const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            const bitmap = canvas.transferToImageBitmap();
            currentWorker.postMessage({ page: { bitmap, width: canvas.width, height: canvas.height } }, [bitmap]);
            canvas.width = canvas.height = 1;
          } catch (error) { currentWorker.postMessage({ pageError: error.message }); }
          return;
        }
        data.error ? reject(new Error(data.error)) : resolve(data);
      };
      worker.onerror = event => reject(new Error(event.message || 'Structure detection failed'));
      const model = profile.value === '0' && record.ocrPages.some(page => page.source !== 'native') && !record.layoutCache?.[cacheKey] ? Uint8Array.fromBase64(assets.models[regioning.value]) : null;
      worker.postMessage({ pdf:source,input: { text: input.text, pages: input.pages }, profile: Number(profile.value),
        runtime: assets.runtime, model,
        regioning: regioning.value,
        layouts: record.layoutCache?.[cacheKey],
        wasm, module: wasmModule }, [source.buffer,wasm?.buffer,model?.buffer].filter(Boolean));
    });
    if (token !== generation) return;
    wasmModule = result.module;
    if (result.offset_unit !== 'utf16') throw new Error('Unsupported structure coordinates');
    const evidence=structureInput(result.pages.map((page,index)=>pageEvidence(page,viewports[index])));
    record.entries = outlineEntries(result.nodes, evidence.lines, profile.value==='0'); record.profile = profile.value;
    record.structureRevision = assets.revision;
    const missing = result.diagnostics?.find(diagnostic=>diagnostic.code==='PPDOC_LAYOUT_INCOMPLETE')?.line_ids?.length || 0;
    record.structureStatus = missing
      ? `Layout did not cover ${missing} lines, so its regions were discarded. ${record.entries.length} headings found from text. ${regioning.value === 'fast' ? 'Try Accurate for more coverage.' : 'Review the contents against the PDF.'}`
      : record.entries.length ? `${record.entries.length} sections detected. Review against the PDF.` : 'No sections detected. You can still scroll and read the PDF.';
    if (result.layouts) {
      record.layoutCache ??= {};
      record.layoutCache[cacheKey] = result.layouts;
      record.regioning = regioning.value;
    }
    await persist(record);
    if (token !== generation) return;
    drawContents(); preview.open = false;
    message.textContent = record.structureStatus;
  } catch (error) { if (token === generation) message.textContent = `Could not detect structure: ${error.message}. Try again.`; }
  finally { if (token === generation) { worker?.terminate(); worker = null; controls(); } }
};
download.onclick = () => {
  if (!active) return;
  const url = URL.createObjectURL(active.blob), link = document.createElement('a');
  link.href = url; link.download = active.name.replace(/\.[^.]+$/, '') + '-searchable.pdf';
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
};
dockButton.classList.add('active');
controls();
try {
  const [saved, id] = await Promise.all([recentDocuments(), activeDocument()]);
  records = saved; drawTabs();
  if (records.length && !active) await openRecord(records.find(record => record.id === id) || records.at(-1));
} catch { storageError(); }
