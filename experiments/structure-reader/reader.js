import { getDocument } from 'pdfjs-dist/build/pdf.mjs';
import { EventBus, PDFViewer, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import pdfStyles from 'pdfjs-dist/web/pdf_viewer.css';
import { getOcrState, searchablePdf } from '../../app.js';
import { structureInput, outlineEntries } from './mapping.js';
import { recentDocuments, rememberDocument, forgetDocument, activeDocument, rememberActive, rememberPage } from './recent.js';
import styles from './reader.css';

const style = document.createElement('style');
style.textContent = pdfStyles + styles; document.head.append(style);
document.body.classList.add('structure-app');
const panel = document.createElement('section'); panel.id = 'structure-reader';
panel.innerHTML = `<nav class="recent-pdfs" aria-label="Recent PDFs"></nav>
<p id="structure-status" role="status">Processed PDFs will appear here and be remembered in this browser.</p>
<p id="storage-status" role="status"></p>
<div class="reader-body" hidden>
  <details class="contents" open><summary>Contents</summary><nav aria-label="Document contents"></nav></details>
  <div class="reader-main"><div class="reader-toolbar">
    <label>Page <input id="reader-page" type="number" min="1" value="1" aria-label="Page number"> <span id="reader-total"></span></label>
    <label>Zoom <select id="reader-zoom"><option value="page-width">Fit width</option><option value="page-fit">Fit page</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select></label>
    <button type="button" id="forget-pdf" class="secondary">Remove from recents</button>
  </div><div class="reader-viewport"><div class="reader-scroll" tabindex="0" aria-label="PDF pages"><div class="pdfViewer"></div></div></div></div>
</div>`;
const form = document.getElementById('form'); form.after(panel);
const options = document.createElement('div'); options.className = 'processing-options';
for (const id of ['file','segmentation','mode']) options.append(document.getElementById(id).closest('label'));
const profileLabel = document.createElement('label');
profileLabel.innerHTML = `Document type<select id="structure-profile"><option value="0">Case</option><option value="1">Legislation</option><option value="2">Agreement</option></select>`;
options.append(profileLabel);
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
const eventBus = new EventBus(), linkService = new PDFLinkService({ eventBus });
const viewer = new PDFViewer({ container: scroll, eventBus, linkService, maxCanvasPixels: 8_000_000 });
linkService.setViewer(viewer);
let records = [], active = null, pdfTask, worker, opening = false, generation = 0, lastOcrPages;
const storageError = () => { storageMessage.textContent = 'Could not remember PDFs in this browser. You can still read and download them in this session.'; };
const persist = record => rememberDocument(record).catch(storageError);

function controls() {
  button.disabled = opening || Boolean(worker) || !active?.ocrPages;
  profile.disabled = opening || Boolean(worker);
  download.disabled = opening || !active;
  $('#forget-pdf').disabled = opening || Boolean(worker) || !active;
}
function drawTabs() {
  tabs.replaceChildren();
  for (const record of records) {
    const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'recent-pdf';
    tab.textContent = record.name; tab.title = record.name;
    if (record === active) tab.setAttribute('aria-current', 'page');
    tab.onclick = () => { if (record !== active) void openRecord(record); };
    tabs.append(tab);
  }
}
function drawContents() {
  nav.replaceChildren();
  if (!active?.entries.length) { nav.textContent = 'Detect structure to find sections.'; return; }
  for (const entry of active.entries) {
    const link = document.createElement('button'); link.type = 'button'; link.className = 'contents-entry';
    link.textContent = `${entry.title} · ${entry.page}`;
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

async function openRecord(record) {
  const token = ++generation; worker?.terminate(); worker = null;
  opening = true; active = record; controls(); drawTabs(); drawContents();
  profile.value = record.profile || '0'; preview.open = false;
  viewer.setDocument(null); linkService.setDocument(null);
  const previous = pdfTask; pdfTask = null;
  await previous?.destroy();
  if (token !== generation) return;
  try {
    const bytes = await record.blob.arrayBuffer();
    if (token !== generation) return;
    pdfTask = getDocument({ data: bytes });
    const pdf = await pdfTask.promise;
    if (token !== generation) return;
    body.hidden = false; linkService.setDocument(pdf); viewer.setDocument(pdf);
    message.textContent = record.entries.length ? `${record.entries.length} sections remembered in this browser` : 'PDF ready. Detect structure to add a contents list.';
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
          ocrPages: state.pages, entries: [], profile: profile.value, page: 1 };
        records.push(record); await persist(record); await openRecord(record);
      } catch (error) { message.textContent = `Could not open searchable PDF: ${error.message}`; }
    })();
  }
});
button.onclick = async () => {
  if (!active?.ocrPages || worker || opening) return;
  const record = active, token = generation;
  message.textContent = 'Detecting sections…';
  const input = structureInput(record.ocrPages), assets = globalThis.LEGAL_STRUCTURE_ASSETS;
  try {
    const wasm = Uint8Array.from(atob(assets.wasm), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([assets.worker], { type: 'text/javascript' }));
    worker = new Worker(url); URL.revokeObjectURL(url); controls();
    const result = await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
      worker.onerror = event => reject(new Error(event.message || 'Structure detection failed'));
      worker.postMessage({ text: input.text, profile: Number(profile.value), wasm }, [wasm.buffer]);
    });
    if (token !== generation) return;
    if (result.offset_unit !== 'utf16') throw new Error('Unsupported structure coordinates');
    record.entries = outlineEntries(result.nodes, input.lines); record.profile = profile.value;
    await persist(record);
    if (token !== generation) return;
    drawContents(); preview.open = false;
    message.textContent = record.entries.length ? `${record.entries.length} sections detected. Review against the PDF.` : 'No sections detected. You can still scroll and read the PDF.';
  } catch (error) { if (token === generation) message.textContent = `Could not detect structure: ${error.message}. Try again.`; }
  finally { if (token === generation) { worker?.terminate(); worker = null; controls(); } }
};
download.onclick = () => {
  if (!active) return;
  const url = URL.createObjectURL(active.blob), link = document.createElement('a');
  link.href = url; link.download = active.name.replace(/\.[^.]+$/, '') + '-searchable.pdf';
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
};
$('#forget-pdf').onclick = async () => {
  if (!active) return;
  const record = active;
  try { await forgetDocument(record.id); } catch { storageError(); return; }
  records = records.filter(item => item !== record);
  if (records.length) await openRecord(records.at(-1));
  else {
    generation++; viewer.setDocument(null); linkService.setDocument(null); await pdfTask?.destroy(); pdfTask = null;
    active = null; body.hidden = true; drawTabs(); controls(); await rememberActive(null).catch(storageError);
    message.textContent = 'No recent PDFs. Recognize a document to start reading.';
  }
};
controls();
try {
  const [saved, id] = await Promise.all([recentDocuments(), activeDocument()]);
  records = saved; drawTabs();
  if (records.length && !active) await openRecord(records.find(record => record.id === id) || records.at(-1));
} catch { storageError(); }
