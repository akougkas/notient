import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';

export function git(root, args) {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function initializeGit(root) {
  const gitPath = path.join(root, '.git');
  if (existsSync(gitPath)) {
    if (!lstatSync(gitPath).isDirectory() || lstatSync(gitPath).isSymbolicLink()) throw new Error('The vault must have its own .git directory.');
    if (git(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('Git root differs from the vault.');
    return false;
  }
  git(root, ['init', '-q', '-b', 'main']);
  return true;
}

export function lastCommit(root) {
  if (!existsSync(path.join(root, '.git'))) return null;
  try {
    const [hash, time, ...subject] = git(root, ['log', '-1', '--format=%H%n%cI%n%s']).split('\n');
    return { hash, time, subject: subject.join('\n') };
  } catch {
    return null;
  }
}
