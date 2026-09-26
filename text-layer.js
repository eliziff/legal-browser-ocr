// OCR geometry is measured in rendered/cropped pixels, not PDF points.
export function cleanModelText(value) {
  return value.replace(/[\u00ad\u00ac]\r?\n/g, '').replace(/[\u00ad\u00ac]/g, '');
}

export function positionedLines(lines, texts) {
  if (lines.length !== texts.length) throw new Error('OCR line/text count mismatch');
  return lines.map((line, index) => {
    const box = line.ocrBox || line;
    return {
      x: box.x ?? 0, y: box.y ?? 0, width: box.width, height: box.height,
      text: cleanModelText(texts[index]).replace(/[\r\n\t]/g, ' '),
    };
  }).filter(line => line.text.trim());
}

// Invert the exact PDF.js viewport, then undo crop translation and resampling.
// This also handles /Rotate, offset CropBoxes, /UserUnit, and rounded canvases.
export function cropToPdfTransform(viewport, area, canvasWidth, canvasHeight) {
  if (!Array.isArray(viewport) || viewport.length !== 6 || !viewport.every(Number.isFinite)) {
    throw new Error('Invalid PDF viewport transform');
  }
  const [a, b, c, d, e, f] = viewport, det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) throw new Error('Singular PDF viewport transform');
  const inverse = [d / det, -b / det, -c / det, a / det,
    (c * f - d * e) / det, (b * e - a * f) / det];
  if (!area) return inverse;
  const { x, y, w, h } = area;
  if (![x, y, w, h, canvasWidth, canvasHeight].every(Number.isFinite) ||
      w <= 0 || h <= 0 || canvasWidth <= 0 || canvasHeight <= 0) {
    throw new Error('Invalid OCR crop');
  }
  const [ia, ib, ic, id, ie, iff] = inverse;
  return [ia * w / canvasWidth, ib * w / canvasWidth,
    ic * h / canvasHeight, id * h / canvasHeight,
    ia * x + ic * y + ie, ib * x + id * y + iff];
}

// The glyphless font has an 0.8-em ascent and 0.2-em descent. Fit a complete
// line into its ink box; advances are estimated from standard font metrics.
export function lineTextMatrix(line, transform, advance = Array.from(line.text).length) {
  const { x, y, width, height } = line;
  if (![x, y, width, height, advance].every(Number.isFinite) ||
      width <= 0 || height <= 0 || advance <= 0 ||
      !Array.isArray(transform) || transform.length !== 6 || !transform.every(Number.isFinite)) {
    throw new Error('Invalid OCR text geometry');
  }
  const [a, b, c, d, e, f] = transform, baseline = y + height * 0.8;
  return [a * width / advance, b * width / advance, -c * height, -d * height,
    a * x + c * baseline + e, b * x + d * baseline + f];
}

// PDF ToUnicode destinations are UTF-16BE, including surrogate pairs.
export function unicodeHex(value) {
  let hex = '';
  for (let i = 0; i < value.length; i++) hex += value.charCodeAt(i).toString(16).padStart(4, '0');
  return hex.toUpperCase();
}
