import { runCommand } from '../lib/command.mjs';
import { withReadVault } from '../lib/read-command.mjs';
import { candidatesOff } from '../lib/embedding-off.mjs';

await runCommand('candidates', input => withReadVault('candidates', input, candidatesOff));
