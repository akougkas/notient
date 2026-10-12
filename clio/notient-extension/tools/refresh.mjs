import { runCommand } from '../lib/command.mjs';
import { withReadVault } from '../lib/read-command.mjs';
import { refreshVectors } from '../lib/embed-refresh.mjs';

await runCommand('refresh', input => withReadVault('refresh', input, refreshVectors));
