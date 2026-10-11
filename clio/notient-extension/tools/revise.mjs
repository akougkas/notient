import { runCommand } from '../lib/command.mjs';
import { writeOperation } from '../lib/write.mjs';

await runCommand('revise', input => writeOperation('revise', input));
