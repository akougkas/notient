import { runCommand } from '../lib/command.mjs';
import { writeOperation } from '../lib/write.mjs';

await runCommand('capture', input => writeOperation('capture', input));
