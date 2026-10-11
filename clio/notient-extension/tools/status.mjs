import { runCommand } from '../lib/command.mjs';
import { dataDirectory } from '../lib/config.mjs';
import { statusSnapshot } from '../lib/status.mjs';

await runCommand('status', input => statusSnapshot(dataDirectory(), input));
