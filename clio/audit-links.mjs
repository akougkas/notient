import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listNotes } from './notient-extension/lib/vault.mjs';
import { readNote, vaultId, contained } from './notient-extension/lib/paths.mjs';
import { parseMarkdown, resolveLink } from './notient-extension/lib/markdown.mjs';

const requested = process.argv[2];
if (!requested || process.argv.length !== 3) throw new Error('Usage: node clio/audit-links.mjs <vault-path>');
const started = performance.now();
const root = realpathSync(requested);
const local = fileURLToPath(new URL('.local/', import.meta.url));
if (contained(root, local)) throw new Error('Audit output must be outside the vault.');
mkdirSync(local, { recursive: true, mode: 0o700 });
if (contained(root, realpathSync(local))) throw new Error('Audit output must be outside the vault.');
const scan = listNotes(root);
const notes = [];
const errors = [];
let bytesRead = 0;
for (const entry of scan.notes) {
  try {
    const content = readNote(root, entry.path);
    const parsed = parseMarkdown(content.text, entry.path);
    bytesRead += content.bytes.length;
    notes.push({ path: entry.path, aliases: parsed.aliases, revision: content.revision, links: parsed.links.map(link => ({ ...link, raw: content.bytes.subarray(link.source.startByte, link.source.endByte).toString('utf8').slice(0, 500) })) });
  } catch (error) {
    errors.push({ path: entry.path, reason: error.message });
  }
}

const withoutExtension = value => value.replace(/\.md$/i, '');
const basenameGroups = new Map();
for (const note of notes) {
  const basename = withoutExtension(path.posix.basename(note.path));
  if (!basenameGroups.has(basename)) basenameGroups.set(basename, []);
  basenameGroups.get(basename).push(note.path);
}
const ambiguousBasenames = [...basenameGroups].filter(([, paths]) => paths.length > 1).map(([basename, paths]) => ({ basename, paths }));
const aliasGroups = new Map();
for (const note of notes) {
  for (const alias of note.aliases) {
    if (!aliasGroups.has(alias)) aliasGroups.set(alias, new Set(basenameGroups.get(alias) ?? []));
    aliasGroups.get(alias).add(note.path);
  }
}
const ambiguousAliases = [...aliasGroups].filter(([, paths]) => paths.size > 1).map(([alias, paths]) => ({ alias, paths: [...paths].sort() }));
const examples = Object.fromEntries(['aliases', 'headings', 'blocks', 'embeds', 'referenceLinks', 'ambiguousBasenames', 'ambiguousAliases', 'ambiguousTargets', 'unresolvedTargets', 'selfFragment', 'shortestUniqueBasename', 'relativePath', 'rootPath', 'frontmatterAlias', 'suffixPath', 'encodedTargets', 'scopedDuplicateBasename', 'unresolvedNonMarkdownExtension'].map(kind => [kind, []]));
function example(kind, value) {
  if (examples[kind].length < 10) examples[kind].push(value);
}
for (const group of ambiguousBasenames) example('ambiguousBasenames', group);
for (const group of ambiguousAliases) example('ambiguousAliases', group);
const distinctTargets = Object.fromEntries(['resolved', 'ambiguous', 'unresolved', 'external'].map(kind => [kind, new Set()]));
const summary = {
  scannedNotes: scan.notes.length, parsedNotes: notes.length, bytesRead,
  skippedNotes: scan.skipped.length, errorCount: errors.length, links: 0,
  kinds: { wikilink: 0, embed: 0, markdownLink: 0, referenceLink: 0 },
  syntax: { wiki: 0, markdown: 0, reference: 0 },
  embedsBySyntax: { wiki: 0, markdown: 0, reference: 0 },
  wikilinks: { total: 0, aliases: 0, headings: 0, blocks: 0, emptyFragments: 0 },
  resolution: { resolved: 0, ambiguous: 0, unresolved: 0, external: 0 },
  resolvedBy: { selfFragment: 0, relativePath: 0, rootPath: 0, shortestUniqueBasename: 0, frontmatterAlias: 0, suffixPath: 0 },
  resolvedBareBasenames: { globallyUnique: 0, scopedDuplicate: 0 },
  ambiguousBasenames: ambiguousBasenames.length,
  ambiguousAliases: ambiguousAliases.length,
  notesWithAmbiguousBasenames: ambiguousBasenames.reduce((total, group) => total + group.paths.length, 0),
  unresolvedWithNonMarkdownExtension: 0,
};
for (const note of notes) {
  for (const link of note.links) {
    summary.links++;
    summary.syntax[link.kind]++;
    const kind = link.embed ? 'embed' : link.kind === 'wiki' ? 'wikilink' : link.kind === 'markdown' ? 'markdownLink' : 'referenceLink';
    summary.kinds[kind]++;
    if (link.embed) summary.embedsBySyntax[link.kind]++;
    const resolved = resolveLink(link, note.path, notes);
    summary.resolution[resolved.resolution]++;
    distinctTargets[resolved.resolution].add(link.target);
    const value = { path: note.path, revision: note.revision, kind: link.kind, embed: link.embed, target: link.target, alias: link.alias, fragment: link.fragment, source: link.source, ...(link.definitionSource ? { definitionSource: link.definitionSource } : {}), raw: link.raw, ...resolved };
    if (link.embed) example('embeds', value);
    if (link.kind === 'reference') example('referenceLinks', value);
    if (link.kind === 'wiki') {
      summary.wikilinks.total++;
      if (link.alias !== null) { summary.wikilinks.aliases++; example('aliases', value); }
      if (link.fragment?.startsWith('^')) { summary.wikilinks.blocks++; example('blocks', value); }
      else if (link.fragment) { summary.wikilinks.headings++; example('headings', value); }
      else if (link.fragment === '') summary.wikilinks.emptyFragments++;
    }
    let target;
    try { target = decodeURIComponent(link.target); } catch { target = null; }
    if (target !== null && target !== link.target) example('encodedTargets', value);
    if (resolved.resolution === 'ambiguous') example('ambiguousTargets', value);
    if (resolved.resolution === 'unresolved') {
      example('unresolvedTargets', value);
      if (target && path.posix.extname(target) && !/\.md$/i.test(target)) {
        summary.unresolvedWithNonMarkdownExtension++;
        example('unresolvedNonMarkdownExtension', value);
      }
    }
    if (resolved.resolution !== 'resolved') continue;
    const destination = resolved.candidates[0];
    const clean = withoutExtension(target);
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(note.path), clean));
    const bare = clean && !clean.includes('/');
    if (bare && withoutExtension(path.posix.basename(destination)) === clean) {
      const unique = basenameGroups.get(clean).length === 1;
      summary.resolvedBareBasenames[unique ? 'globallyUnique' : 'scopedDuplicate']++;
      if (!unique) example('scopedDuplicateBasename', value);
    }
    let route;
    if (!target) route = 'selfFragment';
    else if (withoutExtension(destination) === relative) route = 'relativePath';
    else if (withoutExtension(destination) === clean.replace(/^\//, '')) route = 'rootPath';
    else if (bare && withoutExtension(path.posix.basename(destination)) === clean) route = 'shortestUniqueBasename';
    else if (notes.find(candidate => candidate.path === destination).aliases.includes(clean)) route = 'frontmatterAlias';
    else route = 'suffixPath';
    summary.resolvedBy[route]++;
    if (examples[route]) example(route, value);
  }
}
summary.distinctTargetStrings = Object.fromEntries(Object.entries(distinctTargets).map(([kind, targets]) => [kind, targets.size]));
const filename = path.join(local, `link-audit-${vaultId(root)}.json`);
const report = {
  vault: root, generatedAt: new Date().toISOString(),
  method: 'Read-only walk using listNotes, readNote, parseMarkdown and resolveLink. Resolution follows the stage 1 library and addresses Markdown notes only. Fragments are counted without validating heading or block existence.',
  definitions: {
    kinds: 'Mutually exclusive. Every embed belongs to embed; remaining links belong to their syntax kind.',
    wikilinks: 'All wiki syntax, including embeds. Alias, heading and block counts may overlap.',
    resolvedBy: 'First successful resolver route. Relative path includes a bare target found in the source folder. Root path includes a bare target found at the vault root. Shortest unique basename is the wiki fallback across all folders.',
    resolvedBareBasenames: 'Bare resolved targets that match a note basename, across all resolver routes. Globally unique names and duplicate names scoped by source folder or vault root are counted separately.',
    ambiguousBasenames: 'Case-sensitive Markdown basenames occurring at more than one vault path, whether linked or not.',
    ambiguousAliases: 'Frontmatter alias names matching more than one note through aliases or basenames. A path-scoped match may still take precedence.',
    distinctTargetStrings: 'Distinct raw target strings within each resolution result, excluding fragments. Other link counts count occurrences.',
    unresolved: 'Includes attachment targets and other non-note targets. External URLs are separate. No conclusion is made about attachment existence.',
    examples: 'At most ten occurrences per hard case, in deterministic scan order. Empty lists mean no observed occurrence.',
  },
  summary, ambiguousBasenames, ambiguousAliases, examples, errors, skipped: scan.skipped,
  durationMs: Math.round((performance.now() - started) * 100) / 100,
};
writeFileSync(filename, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ vault: root, report: filename, summary, durationMs: report.durationMs }, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
