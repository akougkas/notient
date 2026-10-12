import { runCommand } from '../lib/command.mjs';
import { withReadVault } from '../lib/read-command.mjs';
import { refreshWithEmbeddingOff } from '../lib/embedding-off.mjs';

await runCommand('refresh', input => withReadVault('refresh', input, refreshWithEmbeddingOff));
