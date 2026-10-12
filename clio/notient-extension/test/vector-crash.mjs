import { readConfig } from '../lib/config.mjs';
import { openIndex } from '../lib/index.mjs';
import { vectorChunks, publishVectors, rebuildVectorGeneration } from '../lib/vector-store.mjs';
import { refreshVectors } from '../lib/embed-refresh.mjs';

const [operation, point, directory, id] = process.argv.slice(2);
const config = readConfig(directory); const vault = config.vaults.find(value => value.id === id);
const barrier = name => { if (name === point) process.kill(process.pid, 'SIGKILL'); };
if (operation === 'force') await refreshVectors(vault, directory, { tier: 'embed', force: true }, { barrier });
else if (operation === 'rebuild') rebuildVectorGeneration(vault, directory, config.embeddings, { barrier });
else {
  const db = openIndex(directory, vault);
  const chunks = [...vectorChunks(db, config.embeddings)].filter(chunk => chunk.eligible).slice(0, 1); db.close();
  publishVectors(vault, directory, config.embeddings, chunks, [[0, 0, 1]], { barrier });
}
