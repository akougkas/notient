import { runCommand } from '../lib/command.mjs';
import { dataDirectory, selectVault } from '../lib/config.mjs';
import { searchIndex } from '../lib/index.mjs';

await runCommand('search', input => {
  const directory = dataDirectory();
  return searchIndex(selectVault(input.vault, directory), directory, input);
});
