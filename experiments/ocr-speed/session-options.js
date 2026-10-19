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
