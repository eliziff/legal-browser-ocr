import { getDocument } from 'pdfjs-dist/build/pdf.mjs';
import { TextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs';
import pdfStyles from 'pdfjs-dist/web/pdf_viewer.css';
import { getOcrState, searchablePdf } from '../../app.js';
import { structureInput, outlineEntries } from './mapping.js';
import styles from './reader.css';

const style = document.createElement('style');
style.textContent = pdfStyles + styles; document.head.append(style);
const panel = document.createElement('section');
panel.id = 'structure-reader';
panel.innerHTML = `<div class="reader-actions">
  <label>Document type<select id="structure-profile"><option value="0">Case</option><option value="1">Legislation</option><option value="2">Agreement</option></select></label>
  <button type="button" id="detect-structure" disabled>Detect document structure</button>
</div><p id="structure-status" role="status">Recognize every page to open a PDF with section navigation.</p>
<div class="reader-body" hidden>
  <details open><summary>Contents</summary><nav aria-label="Document contents"></nav></details>
  <div class="reader-main"><div class="reader-actions">
    <button type="button" id="reader-previous" class="secondary">Previous page</button>
    <span id="reader-page" role="status"></span>
    <button type="button" id="reader-next" class="secondary">Next page</button>
  </div><div class="reader-scroll" tabindex="0" aria-label="Searchable PDF page"><div class="reader-sheet"><canvas></canvas><div class="textLayer"></div></div></div></div>
</div>`;
document.getElementById('form').after(panel);
const $ = selector => panel.querySelector(selector);
const button = $('#detect-structure'), profile = $('#structure-profile'), message = $('#structure-status');
const body = $('.reader-body'), nav = $('nav'), scroll = $('.reader-scroll'), sheet = $('.reader-sheet');
const canvas = $('canvas');
let sourcePages, documentPdf, worker, renderTask, textLayer, generation = 0, pageNumber = 1, rendering = false;

function controls() {
  $('#reader-previous').disabled = rendering || pageNumber <= 1;
  $('#reader-next').disabled = rendering || !documentPdf || pageNumber >= documentPdf.numPages;
}
function reset() {
  generation++; worker?.terminate(); worker = null;
  renderTask?.cancel(); textLayer?.cancel();
  documentPdf?.destroy(); documentPdf = null;
  nav.replaceChildren(); body.hidden = true; sourcePages = null;
  message.textContent = 'Recognize every page to open a PDF with section navigation.';
}
window.addEventListener('ocr-state-change', () => {
  const { pages, busy } = getOcrState();
  if (sourcePages && sourcePages !== pages) reset();
  button.disabled = busy || !pages || Boolean(worker);
  profile.disabled = busy || Boolean(worker);
});

async function showPage(number, point) {
  const token = generation, current = documentPdf;
  if (!current || rendering) return;
  rendering = true; controls();
  try {
    const page = await current.getPage(number);
    if (token !== generation) return;
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(1.5, Math.max(0.2, (scroll.clientWidth - 20) / base.width)) });
    sheet.style.width = `${viewport.width}px`; sheet.style.height = `${viewport.height}px`;
    sheet.style.setProperty('--scale-factor', viewport.scale);
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    textLayer?.cancel(); sheet.querySelector('.textLayer')?.remove();
    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
    await renderTask.promise;
    if (token !== generation) return;
    textLayer = new TextLayerBuilder({ pdfPage: page, onAppend: div => sheet.append(div) });
    await textLayer.render(viewport);
    if (token !== generation) return;
    pageNumber = number; $('#reader-page').textContent = `Page ${number} of ${current.numPages}`;
    const destination = point ? viewport.convertToViewportPoint(...point) : [0,0];
    scroll.scrollTo({ top: Math.max(0, destination[1] - 24), left: Math.max(0, destination[0] - 24) });
  } catch (error) {
    if (token === generation) message.textContent = `Could not display page: ${error.message}`;
  } finally { rendering = false; controls(); }
}
$('#reader-previous').onclick = () => showPage(pageNumber - 1);
$('#reader-next').onclick = () => showPage(pageNumber + 1);
profile.onchange = () => { reset(); button.disabled = !getOcrState().pages; };

button.onclick = async () => {
  const { pages, busy } = getOcrState();
  if (!pages || busy || worker) return;
  reset(); sourcePages = pages;
  const token = generation;
  button.disabled = profile.disabled = true;
  message.textContent = 'Adding the text layer and detecting sections…';
  try {
    const input = structureInput(pages);
    const assets = globalThis.LEGAL_STRUCTURE_ASSETS;
    const wasm = Uint8Array.from(atob(assets.wasm), c => c.charCodeAt(0));
    const workerUrl = URL.createObjectURL(new Blob([assets.worker], { type: 'text/javascript' }));
    worker = new Worker(workerUrl); URL.revokeObjectURL(workerUrl);
    const detection = new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
      worker.onerror = event => reject(new Error(event.message || 'Structure detection failed'));
      worker.postMessage({ text: input.text, profile: Number(profile.value), wasm }, [wasm.buffer]);
    });
    // Observe both promises immediately so an export failure cannot leave an
    // unhandled worker rejection behind.
    const [output, result] = await Promise.all([searchablePdf(), detection]);
    if (token !== generation) return;
    if (result.offset_unit !== 'utf16') throw new Error('Unsupported structure coordinates');
    const loaded = await getDocument({ data: output }).promise;
    if (token !== generation) { await loaded.destroy(); return; }
    documentPdf = loaded;
    const entries = outlineEntries(result.nodes, input.lines);
    for (const entry of entries) {
      const link = document.createElement('button'); link.type = 'button'; link.className = 'secondary';
      link.textContent = `${entry.title} · ${entry.page}`;
      link.style.paddingInlineStart = `${0.5 + Math.min(entry.depth, 5)}rem`;
      link.onclick = async () => {
        if (rendering) return;
        nav.querySelector('[aria-current]')?.removeAttribute('aria-current');
        link.setAttribute('aria-current', 'location');
        await showPage(entry.page, entry.point);
      };
      nav.append(link);
    }
    body.hidden = false;
    message.textContent = entries.length ? `${entries.length} sections detected. Review the inferred structure against the PDF.`
      : 'No sections detected. You can still read the PDF using the page controls.';
    await showPage(1);
  } catch (error) {
    if (token === generation) message.textContent = `Could not detect structure: ${error.message}. You can retry or download the searchable PDF.`;
  } finally {
    if (token === generation) {
      worker?.terminate(); worker = null;
      button.disabled = getOcrState().busy || !getOcrState().pages; profile.disabled = getOcrState().busy;
    }
  }
};
