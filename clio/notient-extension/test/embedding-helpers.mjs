import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function embeddingStub(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: request.url, headers: request.headers, body });
    try {
      if (handler) await handler(request, response, body);
      else response.end(JSON.stringify({ model: 'stub-pinned', data: body.input.map((text, index) => ({ index, embedding: [1, 0] })) }));
    } catch { response.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

export function profile(baseUrl, extra = {}) {
  return { baseUrl, model: 'stub-wire', responseModel: 'stub-pinned', dimension: 2, maxInputBytes: 1600, ...extra };
}

export async function setupCommand(f, args, { key, agent, packageRoot } = {}) {
  const env = { ...process.env, XDG_STATE_HOME: path.dirname(f.directory) };
  delete env.AI_AGENT;
  if (agent !== undefined) env.AI_AGENT = agent;
  const child = spawn(process.execPath, [packageRoot ? path.join(packageRoot, 'bin/setup.mjs') : fileURLToPath(new URL('../bin/setup.mjs', import.meta.url)), '--vault', f.vault.path, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(key ?? '');
  const [status] = await once(child, 'exit'); return { status, stdout, stderr };
}
