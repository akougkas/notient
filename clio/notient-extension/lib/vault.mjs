import { readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { MAX_NOTE_BYTES } from './paths.mjs';

export function listNotes(root) {
  const notes = [];
  const skipped = [];
  function visit(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skipped.push({ path: name, reason: 'symbolic link' });
      } else if (entry.isDirectory()) {
        visit(name);
      } else if (entry.isFile() && /\.md$/i.test(name)) {
        const stat = lstatSync(path.join(root, name));
        if (stat.size > MAX_NOTE_BYTES) skipped.push({ path: name, reason: 'larger than 4 MiB' });
        else notes.push({ path: name, stat });
      }
    }
  }
  visit('');
  return { notes, skipped };
}
