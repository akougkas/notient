import { runCommand } from '../lib/command.mjs';
import { withReadVault } from '../lib/read-command.mjs';
import { searchHybrid } from '../lib/hybrid-search.mjs';

await runCommand('search', input => withReadVault('search', input, searchHybrid));
