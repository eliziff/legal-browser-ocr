export function structureInput(pages) {
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
  return { text, lines, pages: pages.map(page => ({
    width: page.width || Math.max(1, ...page.lines.map(line => line.x + line.width)),
    height: page.height || Math.max(1, ...page.lines.map(line => line.y + line.height)),
    lines: page.lines,
  })) };
}

export function outlineEntries(nodes, lines) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const byLineId = new Map(lines.map(line => [line.id, line]));
  const headings = nodes.filter(node => node.kind === 'heading');
  const candidates = headings.length ? headings : nodes.filter(node => node.kind === 'section');
  const seen = new Set();
  return candidates.filter(node => !seen.has(node.range.start) && seen.add(node.range.start)).flatMap(node => {
    const hit = byLineId.get(node.line_ids?.[0]) || lines.find(line => line.start <= node.range.start && node.range.start < line.end);
    if (!hit) return [];
    const [a,b,c,d,e,f] = hit.transform, { x,y } = hit.line;
    let depth = 0, parent = node.parent_id;
    const seen = new Set([node.id]);
    while (parent && !seen.has(parent)) {
      seen.add(parent); const ancestor = byId.get(parent);
      if (!ancestor) break;
      if (['heading','section'].includes(ancestor.kind)) depth++;
      parent = ancestor.parent_id;
    }
    return [{ id: node.id, title: node.label || hit.line.text, page: hit.page, depth,
      point: [a*x+c*y+e, b*x+d*y+f] }];
  }).sort((a,b) => a.page-b.page);
}
