import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createConnection } from 'node:net';
import { refuse } from './paths.mjs';

export async function readCredentialSocket(filename, { signal } = {}) {
  try {
    const stat = lstatSync(filename);
    const parent = path.dirname(filename);
    const directory = lstatSync(parent);
    if (!path.isAbsolute(filename) || !stat.isSocket() || stat.uid !== process.getuid() || stat.mode & 0o077 || !directory.isDirectory() || directory.uid !== process.getuid() || directory.mode & 0o077 || realpathSync(parent) !== parent) throw new Error();
    return await new Promise((resolve, reject) => {
      const socket = createConnection(filename);
      let bytes = Buffer.alloc(0);
      const finish = (error, value) => { signal?.removeEventListener('abort', abort); socket.destroy(); error ? reject(error) : resolve(value); };
      const abort = () => finish(new Error());
      socket.setTimeout(2000, abort);
      socket.once('error', abort);
      socket.on('data', chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 8194) return abort();
      });
      socket.once('end', () => {
        const key = bytes.toString('utf8').replace(/\r?\n$/, '');
        if (!key.length || /[\r\n\0]/.test(key)) return abort();
        finish(null, key);
      });
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  } catch { refuse('EMBEDDING_CREDENTIAL', 'The private in-memory credential session is unavailable or unsafe.', [], true); }
}
