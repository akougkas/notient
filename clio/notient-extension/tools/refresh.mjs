import { runCommand } from '../lib/command.mjs';
import { dataDirectory, selectVault } from '../lib/config.mjs';
import { refreshIndex } from '../lib/index.mjs';

await runCommand('refresh', input => {
  const directory = dataDirectory();
  return refreshIndex(selectVault(input.vault, directory), directory, input);
});
