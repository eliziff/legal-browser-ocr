import { OPS, ImageKind, Util } from 'pdfjs-dist/build/pdf.mjs';

// Only one image and ordinary affine transforms: all painting, clipping,
// optional content and graphics-state changes stay with the PDF.js renderer.
export function scanImagePlan(list) {
  let matrix = [1, 0, 0, 1, 0, 0], image;
  const stack = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const op = list.fnArray[i], args = list.argsArray[i];
    if (op === OPS.save) stack.push(matrix);
    else if (op === OPS.restore) { if (!stack.length) return null; matrix = stack.pop(); }
    else if (op === OPS.transform) matrix = Util.transform(matrix, args);
    else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) {
      if (image) return null;
      image = { matrix, id: op === OPS.paintImageXObject ? args[0] : null, inline: op === OPS.paintInlineImageXObject ? args[0] : null };
    } else if (op !== OPS.dependency) return null;
  }
  return stack.length ? null : image || null;
}

function imageSource(image) {
  if (image.bitmap) return { source: image.bitmap };
  if (![ImageKind.GRAYSCALE_1BPP, ImageKind.RGB_24BPP, ImageKind.RGBA_32BPP].includes(image.kind)) return null;
  const { width, height, data } = image, pixels = new Uint8ClampedArray(width * height * 4);
  if (image.kind === ImageKind.RGBA_32BPP) pixels.set(data);
  else for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, target = i * 4;
    if (image.kind === ImageKind.RGB_24BPP) pixels.set(data.subarray(i * 3, i * 3 + 3), target);
    else pixels.fill((data[y * Math.ceil(width / 8) + (x >> 3)] & (128 >> (x & 7))) ? 255 : 0, target, target + 3);
    pixels[target + 3] = 255;
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  return { source: canvas, owned: canvas };
}

export async function drawScanPage(page, viewport, canvas) {
  try { return await drawScanImage(page, viewport, canvas); }
  catch { return false; } // The normal PDF renderer owns failures of this optional path.
}

async function drawScanImage(page, viewport, canvas) {
  const list = await page.getOperatorList(), plan = scanImagePlan(list);
  if (!plan || (await page.getAnnotations({ intent: 'display' })).length) return false;
  const image = plan.inline || await new Promise(resolve => {
    (plan.id.startsWith('g_') ? page.commonObjs : page.objs).get(plan.id, resolve);
  });
  if (!image) return false;
  const { width, height } = image;
  const matrix = Util.transform(Util.transform(viewport.transform, plan.matrix), [1 / width, 0, 0, -1 / height, 0, 1]);
  const [a, b, c, d, tx, ty] = matrix;
  if (!(b === 0 && c === 0 || a === 0 && d === 0)) return false;
  const corners = [[tx, ty], [tx + a * width + c * height, ty + b * width + d * height]];
  if (Math.abs(Math.min(...corners.map(p => p[0]))) > .5 || Math.abs(Math.min(...corners.map(p => p[1]))) > .5 ||
      Math.abs(Math.max(...corners.map(p => p[0])) - canvas.width) > .5 || Math.abs(Math.max(...corners.map(p => p[1])) - canvas.height) > .5) return false;
  const decoded = imageSource(image);
  if (!decoded) return false;
  const temporary = [], context = canvas.getContext('2d');
  context.save();
  try {
    let source = decoded.source, paintWidth = width, paintHeight = height;
    let scaleX = 1 / Math.hypot(a, b), scaleY = 1 / Math.hypot(c, d);
    // Match PDF.js's staged reduction before the final image draw.
    while (scaleX > 2 && paintWidth > 1 || scaleY > 2 && paintHeight > 1) {
      const w = scaleX > 2 && paintWidth > 1 ? (paintWidth >= 16384 ? Math.floor(paintWidth / 2) - 1 || 1 : Math.ceil(paintWidth / 2)) : paintWidth;
      const h = scaleY > 2 && paintHeight > 1 ? (paintHeight >= 16384 ? Math.floor(paintHeight / 2) - 1 || 1 : Math.ceil(paintHeight) / 2) : paintHeight;
      const reduced = new OffscreenCanvas(w, h); temporary.push(reduced);
      reduced.getContext('2d').drawImage(source, 0, 0, paintWidth, paintHeight, 0, 0, w, h);
      scaleX /= paintWidth / w; scaleY /= paintHeight / h;
      paintWidth = w; paintHeight = h; source = reduced;
    }
    context.resetTransform(); context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    const smoothLimit = Math.fround((globalThis.devicePixelRatio || 1) * 4 / 3);
    context.imageSmoothingEnabled = image.interpolate || Math.fround(Math.hypot(a, b)) <= smoothLimit && Math.fround(Math.hypot(c, d)) <= smoothLimit;
    const x = Math.round(tx), y = Math.round(ty);
    if (b === 0 && c === 0) {
      context.setTransform(Math.sign(a), 0, 0, Math.sign(d), x, y);
      context.drawImage(source, 0, 0, paintWidth, paintHeight, 0, 0, Math.abs(Math.round(tx + a * width) - x) || 1, Math.abs(Math.round(ty + d * height) - y) || 1);
    } else {
      context.setTransform(0, Math.sign(b), Math.sign(c), 0, x, y);
      context.drawImage(source, 0, 0, paintWidth, paintHeight, 0, 0, Math.abs(Math.round(ty + b * width) - y) || 1, Math.abs(Math.round(tx + c * height) - x) || 1);
    }
    return true;
  } finally {
    context.restore();
    for (const source of [...temporary, decoded.owned].filter(Boolean)) source.width = source.height = 1;
  }
}
