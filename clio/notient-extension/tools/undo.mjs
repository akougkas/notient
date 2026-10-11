import { runCommand } from '../lib/command.mjs';
import { writeOperation } from '../lib/write.mjs';

await runCommand('undo', input => writeOperation('undo', input));
