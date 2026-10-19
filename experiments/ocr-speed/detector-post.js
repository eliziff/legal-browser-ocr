// Indra decoding/XY-cut follow https://github.com/datalab-to/indra (Apache-2.0).
// Paddle DB geometry follows PaddleOCR's DBPostProcess (Apache-2.0).
function components(mask, width, height, diagonal, visit) {
  const queue = new Int32Array(mask.length);
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed]) continue;
    let head = 0, tail = 1;
    queue[0] = seed; mask[seed] = 0;
    while (head < tail) {
      const index = queue[head++], x = index % width, y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!diagonal && dx && dy)) continue;
        const nx = x + dx, ny = y + dy, next = ny * width + nx;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || !mask[next]) continue;
        mask[next] = 0; queue[tail++] = next;
      }
    }
    visit(queue, tail);
  }
}

export function decodeIndra(data, width, height) {
  const plane = width * height, mask = Uint8Array.from(data.subarray(0, plane), value => Number(value > 0)), boxes = [];
  components(mask, width, height, false, (indices, count) => {
    if (count < 2) return;
    let left = width, right = 0, top = 0, bottom = 0;
    for (let i = 0; i < count; i++) {
      const index = indices[i], x = index % width, y = (Math.floor(index / width) + .5) * 2;
      left = Math.min(left, x); right = Math.max(right, x + 1);
      top += y - data[plane + index]; bottom += y + data[plane * 2 + index];
    }
    top /= count; bottom /= count;
    const extension = .15 * Math.max(1, bottom - top);
    boxes.push({ x0: left * 2 - extension, y0: top, x1: right * 2 + extension, y1: bottom });
  });
  return boxes;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function hull(points) {
  const lower = [], upper = [];
  for (const point of points) { while (lower.length > 1 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop(); lower.push(point); }
  for (let i = points.length - 1; i >= 0; i--) { const point = points[i]; while (upper.length > 1 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop(); upper.push(point); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function minimumRectangle(points) {
  const polygon = hull(points);
  let best;
  for (let i = 0; i < polygon.length; i++) {
    const next = polygon[(i + 1) % polygon.length], dx = next[0] - polygon[i][0], dy = next[1] - polygon[i][1], length = Math.hypot(dx, dy);
    if (!length) continue;
    const ux = dx / length, uy = dy / length;
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const [x, y] of polygon) { const u = x * ux + y * uy, v = -x * uy + y * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { ux, uy, u0, u1, v0, v1, area };
  }
  return best;
}

function corners(rect, grow = 0) {
  const { ux, uy } = rect, u0 = rect.u0 - grow, u1 = rect.u1 + grow, v0 = rect.v0 - grow, v1 = rect.v1 + grow;
  return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => [u * ux - v * uy, u * uy + v * ux]);
}

export function decodePaddle(data, width, height, config) {
  const mask = Uint8Array.from(data, value => Number(value > config.threshold)), boxes = [];
  let candidates = 0;
  components(mask, width, height, true, (indices, count) => {
    if (++candidates > config.maxCandidates || count < 3) return;
    const top = new Int32Array(width).fill(height), bottom = new Int32Array(width).fill(-1);
    let left = width, right = 0;
    for (let i = 0; i < count; i++) { const x = indices[i] % width, y = Math.floor(indices[i] / width); left = Math.min(left, x); right = Math.max(right, x); top[x] = Math.min(top[x], y); bottom[x] = Math.max(bottom[x], y); }
    const points = [];
    for (let x = left; x <= right; x++) if (bottom[x] >= 0) { points.push([x, top[x]]); if (bottom[x] !== top[x]) points.push([x, bottom[x]]); }
    const rect = minimumRectangle(points);
    if (!rect) return;
    const rw = rect.u1 - rect.u0, rh = rect.v1 - rect.v0;
    if (Math.min(rw, rh) < 3) return;
    const quad = corners(rect);
    const x0 = Math.max(0, Math.floor(Math.min(...quad.map(p => p[0])))), x1 = Math.min(width - 1, Math.ceil(Math.max(...quad.map(p => p[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...quad.map(p => p[1])))), y1 = Math.min(height - 1, Math.ceil(Math.max(...quad.map(p => p[1]))));
    let sum = 0, pixels = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const u = x * rect.ux + y * rect.uy, v = -x * rect.uy + y * rect.ux;
      if (u < rect.u0 - .5 || u > rect.u1 + .5 || v < rect.v0 - .5 || v > rect.v1 + .5) continue;
      sum += data[y * width + x]; pixels++;
    }
    if (!pixels || sum / pixels < config.boxThreshold) return;
    // DB unclipping of a rectangular min-area box grows each edge by area*ratio/perimeter.
    const grow = rect.area * config.unclipRatio / (2 * (rw + rh));
    if (Math.min(rw, rh) + grow * 2 < 5) return;
    const expanded = corners(rect, grow);
    boxes.push({ x0: Math.min(...expanded.map(p => p[0])), y0: Math.min(...expanded.map(p => p[1])), x1: Math.max(...expanded.map(p => p[0])), y1: Math.max(...expanded.map(p => p[1])) });
  });
  return boxes;
}

export function xycut(lines) {
  if (lines.length < 2) return lines;
  function cut(axis) {
    const endKey = axis === 'x0' ? 'x1' : 'y1', ordered = lines.slice().sort((a, b) => a[axis] - b[axis]);
    let end = ordered[0][endKey], gap = 0, at = -1;
    for (let i = 1; i < ordered.length; i++) { if (ordered[i][axis] - end > gap) { gap = ordered[i][axis] - end; at = i; } end = Math.max(end, ordered[i][endKey]); }
    return { ordered, gap, at };
  }
  const x = cut('x0'), y = cut('y0'), split = y.gap >= x.gap ? y : x;
  if (split.at < 0) return lines.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return [...xycut(split.ordered.slice(0, split.at)), ...xycut(split.ordered.slice(split.at))];
}
