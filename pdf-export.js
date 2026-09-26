import { PDFDocument, PDFName, PDFNumber, StandardFonts } from 'pdf-lib';
import { lineTextMatrix, unicodeHex } from './text-layer.js';

const hexByte = value => value.toString(16).padStart(2, '0').toUpperCase();

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
  const glyphs = await createTextFonts(document, pages);
  document.getPages().forEach((page, index) => addTextLayer(document, page, pages[index], glyphs));
  // Do not flatten, rasterize, resize, rotate, or otherwise rebuild source PDFs.
  return document.save({ updateFieldAppearances: false });
}
