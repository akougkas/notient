import { tokenizeMove } from './move.mjs';

export const maturities = ['raw', 'adolescent', 'mature', 'synthesis-ready'];
export const connectivityTiers = ['isolated', 'sparse', 'connected', 'hub'];
const dayMs = 86400000;

export function arithmeticVitals({ words, inbound, outbound, chunkCoverage, lastUserEditMs, maturity = 'raw' }, now, { rebuild = false, advance = false } = {}) {
  if (![words, inbound, outbound].every(value => Number.isSafeInteger(value) && value >= 0) || ![0, 1].includes(chunkCoverage) || ![now, lastUserEditMs].every(value => Number.isFinite(value) && Math.abs(value) <= 8640000000000000) || !maturities.includes(maturity)) throw new Error('Invalid structural vitals inputs.');
  const edges = inbound + outbound;
  if (!Number.isSafeInteger(edges)) throw new Error('Invalid structural edge count.');
  const ageDays = Math.max(0, (now - lastUserEditMs) / dayMs);
  const freshness = Math.exp(-ageDays / 14);
  const wordBand = 1 - Math.exp(-words / 600);
  const hasEdges = edges > 0 ? 1 : 0;
  let level = maturities.indexOf(maturity);
  if (advance || rebuild) for (let pass = 0; pass < (rebuild ? 3 : 1); pass++) {
    if (level === 0 && words > 0 || level === 1 && words >= 200 && edges >= 5 && now - lastUserEditMs > 7 * dayMs || level === 2 && outbound >= 10 && inbound >= 3) level++;
    else break;
  }
  return { freshness, wordBand, chunkCoverage, hasEdges, health: (wordBand + chunkCoverage + hasEdges) / 3, words, inbound, outbound, edges, connectivityTier: edges >= 12 ? 'hub' : edges >= 4 ? 'connected' : edges >= 1 ? 'sparse' : 'isolated', maturity: maturities[level], lastUserEditAt: new Date(lastUserEditMs).toISOString() };
}

export function proseMetrics(bytes, parsed, tokenized = tokenizeMove(bytes, { visibility: true })) {
  const { visible } = tokenized;
  const text = bytes.toString('utf8');
  const links = parsed.links.map(link => ({ ...link, start: bytes.subarray(0, link.source.startByte).toString('utf8').length, end: bytes.subarray(0, link.source.endByte).toString('utf8').length }));
  const wordPattern = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
  let words = 0;
  const eligibleBlocks = new Set();
  for (const [index, block] of parsed.blocks.entries()) {
    if (block.kind !== 'paragraph') continue;
    const start = block.start ?? Buffer.from(bytes.subarray(0, block.source.startByte)).toString('utf8').length;
    const end = block.end ?? Buffer.from(bytes.subarray(0, block.source.endByte)).toString('utf8').length;
    const masked = text.slice(start, end).split('').map((char, offset) => visible[start + offset] ? char : ' ');
    let lineOffset = 0;
    for (const line of masked.join('').match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (/^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:!?\[\[[^\r\n]+?\]\][ \t]*)+\r?\n?$/.test(line)) masked.fill(' ', lineOffset, lineOffset + line.length);
      lineOffset += line.length;
    }
    for (const link of links) {
      if (link.start < start || link.end > end || masked[link.start - start] === ' ') continue;
      const display = link.alias ?? `${link.target}${link.fragment === null ? '' : `#${link.fragment}`}`;
      masked.fill(' ', link.start - start, link.end - start);
      for (let offset = 0; offset < display.length; offset++) masked[link.start - start + offset] = display[offset];
    }
    const prose = masked.join('');
    const count = [...prose.matchAll(wordPattern)].length;
    words += count;
    if (count) eligibleBlocks.add(index);
  }
  return { words, chunkCoverage: parsed.chunks.some(chunk => eligibleBlocks.has(chunk.block)) ? 1 : 0 };
}
