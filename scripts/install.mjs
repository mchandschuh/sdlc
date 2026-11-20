#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ALL_GIT_HOOKS } from './git_hooks.mjs';

const START = '# >>> sdlc managed hook >>>';
const END = '# <<< sdlc managed hook <<<';
const LEGACY_BLOCKS = {
  'pre-commit': ['# >>> sdlc work-item validation >>>', '# <<< sdlc work-item validation <<<'],
  'post-merge': ['# >>> sdlc work-item completion reminder >>>', '# <<< sdlc work-item completion reminder <<<'],
  'pre-push': ['# >>> sdlc primary release validation >>>', '# <<< sdlc primary release validation <<<'],
};

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function repositoryRoot() {
  return git(process.cwd(), ['rev-parse', '--show-toplevel']);
}

function hooksDirectory(root) {
  return resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']));
}

function removeBlock(content, [startMarker, endMarker]) {
  let result = content;
  while (true) {
    const start = result.indexOf(startMarker);
    if (start < 0) return result;
    const end = result.indexOf(endMarker, start);
    if (end < 0) return result;
    const lineStart = result.lastIndexOf('\n', start - 1) + 1;
    const prefix = result.slice(0, lineStart);
    const normalizedPrefix = prefix.endsWith('\n\n') ? prefix.slice(0, -1) : prefix;
    let after = end + endMarker.length;
    while (result[after] === '\n' || result[after] === '\r') after += 1;
    result = normalizedPrefix + result.slice(after);
  }
}

function removeManaged(content, name) {
  let result = removeBlock(content, [START, END]);
  const legacy = LEGACY_BLOCKS[name];
  if (legacy) result = removeBlock(result, legacy);
  return result;
}

function managedBlock(root, name) {
  return [
    START,
    `node "${resolve(root, 'scripts/git_hooks.mjs')}" dispatch "${name}" "$@"`,
    'status=$?',
    'if [ "$status" -ne 0 ]; then exit "$status"; fi',
    END,
  ].join('\n');
}

function withManagedBlock(content, root, name) {
  const base = removeManaged(content, name);
  const lines = base.split('\n');
  const exitIndex = lines.findLastIndex((line) => line.trim() === 'exit 0');
  const block = managedBlock(root, name).split('\n');
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
  for (const name of ALL_GIT_HOOKS) {
    const path = resolve(directory, name);
    const existing = existsSync(path) ? await readFile(path, 'utf8') : '#!/bin/sh\n';
    await writeFile(path, withManagedBlock(existing, root, name), 'utf8');
    await chmod(path, 0o755);
  }
  return ALL_GIT_HOOKS.map((name) => resolve(directory, name));
}

try {
  const root = repositoryRoot();
  const config = await installConfig(root);
  const hooks = process.argv.includes('--hooks') ? await installHooks(root) : [];
  console.log(JSON.stringify({ repositoryRoot: root, config, hooks }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'SDLC installation failed');
  process.exitCode = 1;
}