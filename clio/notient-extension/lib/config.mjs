import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { contained, vaultId } from './paths.mjs';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));

export function dataDirectory(env = process.env) {
  if (env.XDG_STATE_HOME) return path.resolve(env.XDG_STATE_HOME, 'notient');
  const settings = JSON.parse(readFileSync(path.join(packageRoot, 'runtime/settings.json'), 'utf8'));
  return settings.dataDirectory ?? path.join(homedir(), '.local/state/notient');
}

export function readConfig(directory = dataDirectory()) {
  const filename = path.join(directory, 'config.json');
  if (!existsSync(filename)) return { version: 1, vaults: [] };
  const config = JSON.parse(readFileSync(filename, 'utf8'));
  if (config.version !== 1 || !Array.isArray(config.vaults)) throw new Error('Unsupported Notient configuration. Run operator setup.');
  const ids = new Set();
  for (const vault of config.vaults) {
    if (!path.isAbsolute(vault.path) || vault.id !== vaultId(vault.path) || !['operator', 'own'].includes(vault.role) || typeof vault.readOnly !== 'boolean' || ids.has(vault.id)) {
      throw new Error('Invalid registered vault configuration. Run operator setup.');
    }
    ids.add(vault.id);
    if (contained(vault.path, directory)) throw new Error('Notient data must be outside every vault.');
  }
  return config;
}

export function selectVault(selector, directory = dataDirectory()) {
  const config = readConfig(directory);
  let matches;
  if (selector) {
    matches = config.vaults.filter(v => v.id === selector || v.path === selector);
  } else {
    matches = config.vaults;
  }
  if (matches.length !== 1) throw new Error('Name one registered vault by id or absolute path. Use status to list vaults.');
  const vault = matches[0];
  if (realpathSync(vault.path) !== vault.path) throw new Error('Registered vault path changed. Run operator setup.');
  return vault;
}

export function atomicJson(filename, value) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, filename);
  chmodSync(filename, 0o600);
}

export function indexPath(directory, vault) {
  const filename = path.join(directory, 'vaults', vault.id, 'index.db');
  let ancestor = filename;
  while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  const destination = path.join(realpathSync(ancestor), path.relative(ancestor, filename));
  if (vault.id !== vaultId(vault.path) || contained(vault.path, filename) || contained(vault.path, destination)) throw new Error('Invalid external index location.');
  return filename;
}
