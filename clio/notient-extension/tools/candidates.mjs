import { runCommand } from '../lib/command.mjs';
import { withReadVault } from '../lib/read-command.mjs';
import { findCandidates } from '../lib/candidates.mjs';

await runCommand('candidates', input => withReadVault('candidates', input, findCandidates));
