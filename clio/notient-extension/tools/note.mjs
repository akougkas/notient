import { runCommand } from '../lib/command.mjs';
import { dataDirectory, selectVault } from '../lib/config.mjs';
import { inspectNote } from '../lib/note.mjs';

await runCommand('note', input => {
  const directory = dataDirectory();
  return inspectNote(selectVault(input.vault, directory), directory, input);
});
