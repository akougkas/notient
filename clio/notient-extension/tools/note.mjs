import { runCommand } from '../lib/command.mjs';
import { withReadVault } from '../lib/read-command.mjs';
import { inspectNote } from '../lib/note.mjs';

await runCommand('note', input => withReadVault('note', input, inspectNote));
