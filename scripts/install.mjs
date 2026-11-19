#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const START = '# >>> sdlc managed hook >>>';
const END = '# <<< sdlc managed hook <<<';
const HOOKS = ['applypatch-msg', 'commit-msg', 'post-update', 'pre-applypatch', 'pre-commit', 'pre-merge-commit', 'pre-push', 'pre-rebase', 'pre-receive', 'prepare-commit-msg', 'push-to-checkout', 'update'];

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function repositoryRoot() {
  return git(process.cwd(), ['rev-parse', '--show-toplevel']);
}

function hooksDirectory(root) {
  return resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']));
}

function removeManaged(content) {
  const start = content.indexOf(START);
  if (start < 0) return content;
  const end = content.indexOf(END, start);
  if (end < 0) return content;
  const lineStart = content.lastIndexOf('\n', start - 1) + 1;
  const prefix = content.slice(0, lineStart);
  const normalizedPrefix = prefix.endsWith('\n\n') ? prefix.slice(0, -1) : prefix;
  let after = end + END.length;
  while (content[after] === '\n' || content[after] === '\r') after += 1;
  return normalizedPrefix + content.slice(after);
}

function managedBlock(root) {
  return [
    START,
    `node "${resolve(root, 'scripts/install.mjs')}" --run-hook`,
    'status=$?',
    'if [ "$status" -ne 0 ]; then exit "$status"; fi',
    END,
  ].join('\n');
}

function withManagedBlock(content, root) {
  const base = removeManaged(content);
  const lines = base.split('\n');
  const exitIndex = lines.findLastIndex((line) => line.trim() === 'exit 0');
  const block = managedBlock(root).split('\n');
  if (exitIndex >= 0) lines.splice(exitIndex, 0, ...block, '');
  else {
    if (lines.at(-1) !== '') lines.push('');
    lines.push(...block, '');
  }
  return lines.join('\n');
}

async function installConfig(root) {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is required to install ~/.sdlc/config.json.');
  const directory = resolve(home, '.sdlc');
  const path = resolve(directory, 'config.json');
  if (existsSync(path)) return { path, created: false };
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify({ schema: 'https://schemas.handschuh.dev/sdlc/config/v1', repositoryRoot: root }, null, 2)}\n`, 'utf8');
  return { path, created: true };
}

async function installHooks(root) {
  const directory = hooksDirectory(root);
  await mkdir(directory, { recursive: true });
  for (const name of HOOKS) {
    const path = resolve(directory, name);
    const existing = existsSync(path) ? await readFile(path, 'utf8') : '#!/bin/sh\n';
    await writeFile(path, withManagedBlock(existing, root), 'utf8');
    await chmod(path, 0o755);
  }
  return HOOKS.map((name) => resolve(directory, name));
}

async function runHook(root) {
  const staged = git(root, ['diff', '--cached', '--name-only', '-z']);
  const ids = [...new Set([...staged.split('\0')].map((path) => /^\.docs\/work-items\/([A-Z]{1,10}-[0-9]+)(?:\/|$)/u.exec(path)?.[1]).filter(Boolean))].sort();
  for (const id of ids) {
    const result = execFileSync(process.execPath, [resolve(root, 'bin/cli.js'), 'work-item', 'validate', '--work-item', id, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(result);
  }
}

try {
  const root = repositoryRoot();
  if (process.argv.includes('--run-hook')) await runHook(root);
  else {
    const config = await installConfig(root);
    const hooks = process.argv.includes('--hooks') ? await installHooks(root) : [];
    console.log(JSON.stringify({ repositoryRoot: root, config, hooks }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'SDLC installation failed');
  process.exitCode = 1;
}