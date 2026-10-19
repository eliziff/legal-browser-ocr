export function memoryOptions(query) {
  const options = {};
  for (const [flag, option] of [['arena', 'enableCpuMemArena'], ['memPattern', 'enableMemPattern']]) {
    if (!query.has(flag)) continue;
    const value = query.get(flag);
    if (value !== '0' && value !== '1') throw new Error(`${flag} must be 0 or 1`);
    options[option] = value === '1';
  }
  return options;
}

export function tensorWidthMultiple(query) {
  const width = query.has('tensorWidth') ? Number(query.get('tensorWidth')) : 8;
  if (!Number.isInteger(width) || width < 8 || width > 512 || width % 8)
    throw new Error('tensorWidth must be a multiple of 8 between 8 and 512');
  return width;
}
