import { refuse } from './paths.mjs';

export function uniqueJson(text) {
  let decoded; try { decoded = JSON.parse(text); } catch { refuse('INVALID_INPUT', 'Supply valid JSON.'); }
  let cursor = 0;
  const space = () => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  const string = () => { const start = cursor++; while (cursor < text.length) { if (text[cursor++] === '"') return JSON.parse(text.slice(start, cursor)); if (text[cursor - 1] === '\\') cursor++; } refuse('INVALID_INPUT', 'Unterminated JSON string.'); };
  const value = depth => {
    if (depth > 32) refuse('INVALID_INPUT', 'JSON nesting exceeds its bound.');
    space(); const token = text[cursor];
    if (token === '"') { string(); return; }
    if (token === '{' || token === '[') {
      cursor++; space(); const keys = new Set(); const close = token === '{' ? '}' : ']';
      while (text[cursor] !== close) {
        if (token === '{') { space(); const key = string(); if (keys.has(key)) refuse('INVALID_INPUT', 'Duplicate JSON keys are refused.'); keys.add(key); space(); cursor++; }
        value(depth + 1); space(); if (text[cursor] !== ',') break; cursor++;
      }
      cursor++; return;
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(cursor)); cursor += match[0].length;
  };
  value(0); return decoded;
}
