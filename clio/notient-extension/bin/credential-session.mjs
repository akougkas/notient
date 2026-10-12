import { chmodSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';

async function main() {
  if (Object.hasOwn(process.env, 'AI_AGENT')) throw new Error('Notient credential setup is an operator act and refuses AI_AGENT.');
  const [flag, filename, ...extra] = process.argv.slice(2);
  if (flag !== '--socket' || !filename || extra.length || !path.isAbsolute(filename)) throw new Error('Usage: credential-session.mjs --socket <absolute-private-path>, with one secret line on stdin.');
  const parent = path.dirname(filename);
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077 || realpathSync(parent) !== parent) throw new Error('The credential socket requires a private directory owned by the operator.');
  let bytes = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 8194) throw new Error('Credential stdin exceeds its byte bound.');
  }
  const key = bytes.toString('utf8').replace(/\r?\n$/, '');
  bytes.fill(0);
  if (!key.length || /[\r\n\0]/.test(key)) throw new Error('Credential stdin requires one nonempty secret line.');
  process.umask(0o077);
  const server = createServer(socket => { socket.on('error', () => {}); socket.end(key + '\n'); });
  server.listen(filename);
  await once(server, 'listening');
  chmodSync(filename, 0o600);
  const identity = lstatSync(filename);
  const stop = () => server.close(() => {
    try { const current = lstatSync(filename); if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(filename); } catch {}
    process.exit(0);
  });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdout.write(JSON.stringify({ ready: true, socket: filename, persistence: 'memory-only' }) + '\n');
}

try { await main(); }
catch (error) { process.stderr.write(error.message.replace(/[\r\n]+/g, ' ') + '\n'); process.exitCode = 2; }
