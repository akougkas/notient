import { runCommand } from '../lib/command.mjs';
import { withReadVault } from '../lib/read-command.mjs';
import { searchWithEmbeddingOff } from '../lib/embedding-off.mjs';

await runCommand('search', input => withReadVault('search', input, searchWithEmbeddingOff));
