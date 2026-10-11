import { runCommand } from '../lib/command.mjs';
import { dataDirectory } from '../lib/config.mjs';
import { commandStatusSnapshot } from '../lib/write.mjs';

await runCommand('status', input => commandStatusSnapshot(dataDirectory(), input));
