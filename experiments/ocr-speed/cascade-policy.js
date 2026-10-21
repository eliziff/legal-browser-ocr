export function emissionMargins(ids, margins, offset, length) {
  const values = []; let previous = 0;
  for (let t = 0; t < length; t++) {
    const id = ids[offset + t];
    if (id && id !== previous) values.push(margins[offset + t]);
    previous = id;
  }
  values.sort((a, b) => a - b);
  return {emissions: values.length, minimum: values[0] || 0,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
    lowerQuartile: values.length ? values[Math.floor((values.length - 1) / 4)] : 0};
}

export function needsTeacher(score, policy) { return !score.emissions || score[policy.metric] < policy.threshold; }
