import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planMove, guardInverseReferences } from '../lib/move.mjs';
import { revision } from '../lib/paths.mjs';

const scan = text => ({ inventory: ['From.md', 'old/One.md'], notes: [{ path: 'From.md', bytes: Buffer.from(text), revision: revision(text), mode: 0o644 }, { path: 'old/One.md', bytes: Buffer.from('Source\n'), revision: revision('Source\n'), mode: 0o644 }], blockers: [] });

test('T1 root mixed-tab code and even-backslash inline code retain all their bytes', () => {
  for (const text of [' \t[[One]]\n\n[[One]]\n', '\\\\`[[One]]`\n[[One]]\n']) {
    const result = planMove(scan(text), 'old/One.md', 'new/Two.md');
    assert.equal(result.ok, true, JSON.stringify(result.blockers));
    assert.equal(result.files.find(file => file.path === 'From.md').after.toString(), text.slice(0, text.lastIndexOf('[[One]]')) + '[[Two]]\n');
  }
});

test('T1 unmatched inline code never hides live references across a blank paragraph', () => {
  for (const text of ['unmatched `\n\n[[One]]\n\n`\n', 'unmatched `\n \t\n[[One]]\n\n`\n', '\\` [[One]]\n']) {
    const result = planMove(scan(text), 'old/One.md', 'new/Two.md');
    assert.equal(result.ok, true, JSON.stringify(result.blockers));
    assert.equal(result.files.find(file => file.path === 'From.md').after.toString(), text.replace('[[One]]', '[[Two]]'));
    assert.ok(guardInverseReferences(scan(text), [{ path: 'old/One.md', before: Buffer.from('Source\n'), after: null }]).blockerCount);
  }
});

for (const [name, before, expected] of [
  ['blockquote fence', '> ~~~\n> [[One]]\n> ~~~\n[[One]]\n', '> ~~~\n> [[One]]\n> ~~~\n[[Two]]\n'],
  ['Obsidian comments', '%% [[One]] %%\n%%\n![[One]]\n%%\n[[One]]\n', '%% [[One]] %%\n%%\n![[One]]\n%%\n[[Two]]\n'],
  ['nested list live reference', '- parent\n    - [[One]]\n', '- parent\n    - [[Two]]\n'],
  ['list continuation live reference', '- parent\n    [[One]]\n', '- parent\n    [[Two]]\n'],
  ['list fence beyond three spaces', '- parent\n    ~~~\n    [[One]]\n    ~~~\n[[One]]\n', '- parent\n    ~~~\n    [[One]]\n    ~~~\n[[Two]]\n'],
  ['deep quoted list fence', '> - parent\n>     - child\n>         ```md\n>         [[One]]\n>         ```\n[[One]]\n', '> - parent\n>     - child\n>         ```md\n>         [[One]]\n>         ```\n[[Two]]\n'],
  ['multiline reference definition', '[go][ref]\n\n[ref]:\n  old/One.md\n', '[go][ref]\n\n[ref]:\n  new/Two.md\n'],
  ['multiline angle and title', '[go][ref]\r\n\r\n[ref]:\r\n  <old/One.md#Heading>\r\n  "Exact title"\r\n', '[go][ref]\r\n\r\n[ref]:\r\n  <new/Two.md#Heading>\r\n  "Exact title"\r\n'],
  ['HTML comment with fence', '<!--\n~~~\n-->\n[[One]]\n', '<!--\n~~~\n-->\n[[Two]]\n'],
  ['unclosed container fence ends at dedent', '- parent\n    ~~~\n    [[One]]\n\n[[One]]\n', '- parent\n    ~~~\n    [[One]]\n\n[[Two]]\n'],
]) test(`S1 ${name} preserves ignored bytes and repairs every live reference`, () => {
  const result = planMove(scan(before), 'old/One.md', 'new/Two.md');
  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  assert.equal(result.files.find(file => file.path === 'From.md')?.after.toString(), expected);
});

test('S1 undecidable tab-container reference refuses with its line and no proposed bytes', () => {
  const result = planMove(scan('- parent\n \t[[One]]\n'), 'old/One.md', 'new/Two.md');
  assert.equal(result.ok, false);
  assert.equal(result.blockers[0].code, 'AMBIGUOUS_REFERENCE');
  assert.equal(result.blockers[0].line, 2);
  assert.deepEqual(result.files, []);
});

test('S1 inverse guard sees nested-list and multiline-definition references', () => {
  for (const text of ['- parent\n    - [[One]]\n', '[go][ref]\n\n[ref]:\n  old/One.md\n']) {
    const result = guardInverseReferences(scan(text), [{ path: 'old/One.md', before: Buffer.from('Source\n'), after: null }]);
    assert.ok(result.blockerCount > 0, text);
    assert.equal(result.blockers[0].path, 'From.md');
  }
});
