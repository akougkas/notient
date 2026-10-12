import { runCommand } from '../lib/command.mjs';
import { withReadVault } from '../lib/read-command.mjs';
import { readVitals } from '../lib/vitals-read.mjs';

await runCommand('vitals', input => withReadVault('vitals', input, readVitals));
