import { PDFDocument, PDFName, PDFNumber, PDFArray, PDFRawStream, decodePDFRawStream, StandardFonts } from 'pdf-lib';
import { lineTextMatrix, unicodeHex } from './text-layer.js';

const hexByte = value => value.toString(16).padStart(2, '0').toUpperCase();

// Re-export our own generated layer, never stack another copy on top of it.
function removeGeneratedText(document) {
  let removed = false;
  for (const page of document.getPages()) {
    const contents = page.node.Contents();
    if (!(contents instanceof PDFArray)) continue;
    for (let i = contents.size() - 1; i >= 0; i--) {
      const stream = contents.lookup(i);
      if (!(stream instanceof PDFRawStream)) continue;
      const text = new TextDecoder().decode(decodePDFRawStream(stream).decode());
      if (text.startsWith('q\nBT\n3 Tr\n0 Tc\n0 Tw\n100 Tz\n0 Ts\n/LegalOCR-')) {
        contents.remove(i); removed = true;
      }
    }
  }
  return removed;
}

async function existingTextPages(bytes, pages) {
  const { getDocument, Util } = await import('pdfjs-dist/build/pdf.mjs');
  const task = getDocument({ ...globalThis.LEGAL_PDF_OPTIONS, data: new Uint8Array(bytes).slice() });
  try {
    const pdf = await task.promise, result = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), text = await page.getTextContent();
      const inverse = Util.inverseTransform(pages[i-1].transform);
      result.push(text.items.filter(item=>item.str?.trim()).map(item=>{
        const [a,b,c,d,x,y]=item.transform, length=Math.hypot(a,b);
        const ascent=text.styles[item.fontName]?.ascent ?? 0.8;
        const descent=text.styles[item.fontName]?.descent ?? -0.2;
        const points=[0,item.width].flatMap(w=>[descent,ascent].map(h=>{
          const point=[x+a*w/length+c*h,y+b*w/length+d*h];Util.applyTransform(point,inverse);return point;
        }));
        const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
        return {x:Math.min(...xs),right:Math.max(...xs),y:Math.min(...ys),bottom:Math.max(...ys)};
      }));
      page.cleanup();
    }
    return result;
  } finally { await task.destroy(); }
}

function coveredByExistingText(line, boxes) {
  const intervals=boxes.filter(box=>Math.min(line.y+line.height,box.bottom)-Math.max(line.y,box.y)>=Math.min(line.height,box.bottom-box.y)/2)
    .map(box=>[Math.max(line.x,box.x),Math.min(line.x+line.width,box.right)])
    .filter(([start,end])=>end>start).sort((a,b)=>a[0]-b[0]);
  let covered=0,end=-Infinity;
  for(const [start,right] of intervals){covered+=Math.max(0,right-Math.max(start,end));end=Math.max(end,right);}
  // Match a line, not a page: a native page stamp must not suppress scanned body text.
  return covered >= line.width * 0.75;
}

// Self-contained Type 3 fonts with empty glyph programs: no system font or
// network asset is needed, and arbitrary OCR Unicode survives copy/search.
// ToUnicode is required; WinAnsi drawText would reject or corrupt non-Latin text.
async function createTextFonts(document, pages) {
  const { context } = document;
  const unique = new Set();
  for (const page of pages) for (const line of page.lines) for (const character of line.text) unique.add(character);
  const characters = [...unique];
  const metrics = await document.embedFont(StandardFonts.TimesRoman);
  const supported = new Set(metrics.getCharacterSet());
  const glyphs = new Map(), programs = new Map();
  for (let start = 0; start < characters.length; start += 255) {
    const alphabet = characters.slice(start, start + 255), widths = [], procs = {}, mappings = [];
    for (const [index, character] of alphabet.entries()) {
      const code = index + 1;
      const width = supported.has(character.codePointAt(0))
        ? Math.round(metrics.widthOfTextAtSize(character, 1000)) : /\p{Mark}/u.test(character) ? 0 : 500;
      widths.push(width);
      if (!programs.has(width)) programs.set(width, context.register(context.flateStream(
        `${width} 0 0 -200 ${width} 800 d1\n`,
      )));
      procs[`g${code}`] = programs.get(width);
      mappings.push(`<${hexByte(code)}> <${unicodeHex(character)}>`);
    }
    const cmap = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /LegalOCR def', '/CMapType 2 def', '1 begincodespacerange', '<00> <FF>', 'endcodespacerange'];
    for (let i = 0; i < mappings.length; i += 100) {
      const group = mappings.slice(i, i + 100);
      cmap.push(`${group.length} beginbfchar`, ...group, 'endbfchar');
    }
    cmap.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
    const font = context.register(context.obj({
      Type: 'Font', Subtype: 'Type3', FontBBox: [0, -200, 1000, 800],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      FirstChar: 1, LastChar: alphabet.length, Widths: widths,
      CharProcs: procs, Resources: {},
      Encoding: { Type: 'Encoding', Differences: [1, ...alphabet.map((_, index) => PDFName.of(`g${index + 1}`))] },
      ToUnicode: context.register(context.flateStream(cmap.join('\n'))),
    }));
    alphabet.forEach((character, index) => glyphs.set(character, {
      font, code: hexByte(index + 1), advance: widths[index] / 1000,
    }));
  }
  return glyphs;
}

function addTextLayer(document, page, result, glyphs) {
  if (!result.lines.length) return;
  const fonts = new Map(), operators = ['q', 'BT', '3 Tr', '0 Tc', '0 Tw', '100 Tz', '0 Ts'];
  for (const line of result.lines) {
    if (!line.text.trim()) continue;
    const characters = Array.from(line.text, character => glyphs.get(character));
    const matrix = lineTextMatrix(line, result.transform, characters.reduce((sum, glyph) => sum + glyph.advance, 0));
    let advance = 0;
    for (let offset = 0; offset < characters.length;) {
      const { font } = characters[offset];
      if (!fonts.has(font)) fonts.set(font, page.node.newFontDictionary('LegalOCR', font));
      let encoded = '', runAdvance = 0;
      while (offset < characters.length && characters[offset].font === font) {
        encoded += characters[offset].code;
        runAdvance += characters[offset++].advance;
      }
      const [a, b, c, d, e, f] = matrix;
      operators.push(`${fonts.get(font)} 1 Tf`,
        `${[a, b, c, d, e + advance * a, f + advance * b].map(n => PDFNumber.of(n).toString()).join(' ')} Tm`,
        `<${encoded}> Tj`);
      advance += runAdvance;
    }
  }
  operators.push('ET', 'Q');
  // newFontDictionary normalizes the page and isolates its original content's
  // graphics state before we append our independent text stream.
  page.node.addContentStream(document.context.register(document.context.flateStream(operators.join('\n'))));
}

/** Add OCR to the original PDF, or put the original PNG on a new PDF page.
 * pages is in source-page order and contains { lines, transform } for EVERY
 * page, including blank pages. Failed/partial OCR is deliberately not exported.
 */
export async function createSearchablePdf({ pdfBytes, pngBytes, pages }) {
  if ((!pdfBytes && !pngBytes) || (pdfBytes && pngBytes)) throw new Error('Provide one PDF or PNG source');
  const document = pdfBytes
    ? await PDFDocument.load(pdfBytes, { updateMetadata: false }) : await PDFDocument.create();
  if (pngBytes) {
    const image = await document.embedPng(pngBytes);
    document.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  if (!Array.isArray(pages) || pages.length !== document.getPageCount() ||
      Array.from(pages).some(page => !page || !Array.isArray(page.lines))) {
    throw new Error('Recognize every page successfully before exporting');
  }
  const removed = removeGeneratedText(document);
  const existing = pdfBytes ? await existingTextPages(removed ? await document.save() : pdfBytes, pages) : [];
  const additions = pages.map((page, index) => ({...page,lines:page.lines.filter(line=>!coveredByExistingText(line,existing[index] || []))}));
  const glyphs = await createTextFonts(document, additions);
  document.getPages().forEach((page, index) => addTextLayer(document, page, additions[index], glyphs));
  // Do not flatten, rasterize, resize, rotate, or otherwise rebuild source PDFs.
  return document.save({ updateFieldAppearances: false });
}
