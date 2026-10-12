export const stopwords = new Set('a an and are as at be been being but by can could did do does for from had has have how i if in into is it its may of on or our should so than that the their them then there these they this those to was we were what when where which who why will with would you your'.split(' '));
export const normalizedTerms = text => [...new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
export const significantTerms = terms => terms.filter(term => [...term].length >= 3 && !stopwords.has(term));
const signal = (state, basis, value, candidates, reason) => ({ state, basis, value, zMin: 2, calibrated: false, candidates, reason });

export function semanticSignal(scores) {
  const values = scores.slice(0, 50);
  if (values.some(value => !Number.isFinite(value))) throw new Error('Separation requires finite scores.');
  if (values.length < 10) return signal('undetermined', 'semantic-z', null, values.length, 'fewer_than_ten');
  const tail = values.slice(1); const mean = tail.reduce((sum, value) => sum + value, 0) / tail.length;
  const deviation = Math.sqrt(tail.reduce((sum, value) => sum + (value - mean) ** 2, 0) / tail.length);
  if (tail.every(value => value === tail[0])) return signal(values[0] > tail[0] ? 'separated' : 'flat', 'semantic-z', values[0] > tail[0] ? null : 0, values.length, values[0] > tail[0] ? 'zero_variance_gap' : 'zero_variance_equal');
  const z = (values[0] - mean) / deviation;
  return signal(z >= 2 ? 'separated' : 'flat', 'semantic-z', Number.isFinite(z) ? z : null, values.length, Number.isFinite(z) ? null : 'numeric_range');
}

export function lexicalSignal(records, significant, fallback) {
  const selected = records.slice(0, 50);
  if (selected.length < 10 || !significant.length) return signal('undetermined', 'lexical-terms', null, selected.length, !significant.length ? 'no_significant_terms' : 'fewer_than_ten');
  const complete = selected.some(record => { const terms = new Set(normalizedTerms(record.passage)); return significant.every(term => terms.has(term)); });
  return signal(fallback || !complete ? 'flat' : 'separated', 'lexical-terms', null, selected.length, fallback ? 'term_fallback' : !complete ? 'no_complete_match' : null);
}

export function combinedSeparation(semantic = null, lexical = null) {
  const available = [semantic, lexical].filter(Boolean);
  return { state: available.some(arm => arm.state === 'separated') ? 'separated' : available.length && available.every(arm => arm.state === 'flat') ? 'flat' : 'undetermined', semantic, lexical };
}

export const rankOrder = (a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.ordinal - b.ordinal;
export function retainBest(rows, row, limit, compare = rankOrder) {
  if (rows.length >= limit && compare(row, rows.at(-1)) >= 0) return;
  rows.push(row); rows.sort(compare); if (rows.length > limit) rows.pop();
}
