export function structureInput(pages, viewports) {
  let text = '', offset = 0;
  const lines = [];
  pages.forEach((page, index) => {
    for (const [lineIndex, line] of page.lines.entries()) {
      const length = line.text.length; // The shared engine publishes UTF-16 offsets.
      lines.push({ id: `p${index + 1}-l${lineIndex + 1}`, start: offset, end: offset + length, page: index + 1, line, transform: page.transform });
      text += line.text + '\n'; offset += length + 1;
    }
    text += '\n'; offset++;
  });
  return { text, lines, pages: pages.map((page, index) => ({
    width: viewports?.[index].width || page.width || Math.max(1, ...page.lines.map(line => line.x + line.width)),
    height: viewports?.[index].height || page.height || Math.max(1, ...page.lines.map(line => line.y + line.height)),
    lines: viewports ? page.lines.map(line => {
      const point = (x, y) => {
        const [a,b,c,d,e,f] = page.transform, [g,h,i,j,k,l] = viewports[index].transform;
        const px = a*x+c*y+e, py = b*x+d*y+f;
        return [g*px+i*py+k, h*px+j*py+l];
      };
      const corners = [point(line.x,line.y), point(line.x+line.width,line.y), point(line.x,line.y+line.height), point(line.x+line.width,line.y+line.height)];
      const xs = corners.map(p=>p[0]), ys = corners.map(p=>p[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { ...line, x, y, width: Math.max(...xs)-x, height: Math.max(...ys)-y };
    }) : page.lines,
    layout: page.layout,
  })) };
}

export function outlineEntries(nodes, lines, layoutLines, headingLevels = {}) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const byLineId = new Map(lines.map(line => [line.id, line]));
  // General navigation follows visual heading regions. Legal profiles use the
  // parser's sections; list items in a general document are not ToC headings.
  const candidates = layoutLines ? [] : [...nodes.filter(node => node.kind === 'heading'), ...nodes.filter(node => node.kind === 'section')];
  const seen = new Set();
  const regions = new Map();
  for (const assignment of layoutLines || []) {
    const hit = byLineId.get(assignment.id);
    if (!hit || !['paragraph_title','heading','doc_title'].includes(assignment.region_type)) continue;
    seen.add(hit.id);
    const region = regions.get(assignment.region_id) || { hit, titles: [] };
    region.titles.push(hit.line.text); regions.set(assignment.region_id, region);
  }
  const entries = [...regions].map(([id, { hit, titles }]) => {
    const [a,b,c,d,e,f] = hit.transform, { x,y } = hit.line;
    return { id, title: titles.join(' '), page: hit.page, depth: headingLevels[id] ?? 0, order: hit.start,
      point: [a*x+c*y+e, b*x+d*y+f] };
  });
  entries.push(...candidates.flatMap(node => {
    const hit = byLineId.get(node.line_ids?.[0]) || lines.find(line => line.start <= node.range.start && node.range.start < line.end);
    if (!hit || seen.has(hit.id)) return [];
    seen.add(hit.id);
    const [a,b,c,d,e,f] = hit.transform, { x,y } = hit.line;
    let depth = 0, parent = node.parent_id;
    const ancestors = new Set([node.id]);
    while (parent && !ancestors.has(parent)) {
      ancestors.add(parent); const ancestor = byId.get(parent);
      if (!ancestor) break;
      if (['heading','section'].includes(ancestor.kind)) depth++;
      parent = ancestor.parent_id;
    }
    return [{ id: node.id, title: node.kind === 'heading' ? node.label || hit.line.text : hit.line.text, page: hit.page, depth, order: hit.start,
      point: [a*x+c*y+e, b*x+d*y+f] }];
  }));
  return entries.sort((a,b) => a.page-b.page || a.order-b.order);
}
