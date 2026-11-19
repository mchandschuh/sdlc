#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'install_sdlc_validate_git_hooks.mjs';
const HOOK_NAME = 'pre-commit';
const START_MARKER = '# >>> sdlc work-item validation >>>';
const END_MARKER = '# <<< sdlc work-item validation <<<';
const WORK_ITEM_PATH = /^\.docs\/work-items\/([A-Z]{1,10}-[0-9]+)(?:\/|$)/u;
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), SCRIPT_NAME);

function git(repositoryRoot, args) {
  return execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' }).trim();
}

function repositoryRoot() {
  return git(process.cwd(), ['rev-parse', '--show-toplevel']);
}

function hookPath(root) {
  return resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']), HOOK_NAME);
}

function managedHook() {
  return [
    START_MARKER,
    'sdlc_hook_status=0',
    `node "$(git rev-parse --show-toplevel)/scripts/${SCRIPT_NAME}" --run-hook || sdlc_hook_status=$?`,
    'if [ "$sdlc_hook_status" -ne 0 ]; then',
    '  exit "$sdlc_hook_status"',
    'fi',
    END_MARKER,
  ].join('\n');
}

function removeManagedHook(content) {
  const start = content.indexOf(START_MARKER);
  if (start < 0) return content;
  const end = content.indexOf(END_MARKER, start);
  if (end < 0) return content;
  const lineStart = content.lastIndexOf('\n', start - 1) + 1;
  let after = end + END_MARKER.length;
  while (content[after] === '\n' || content[after] === '\r') after += 1;
  return content.slice(0, lineStart) + content.slice(after);
}

function addManagedHook(content) {
  const normalized = removeManagedHook(content);
  const lines = normalized.split('\n');
  const exitIndex = lines.findLastIndex((line) => line.trim() === 'exit 0');
  const block = managedHook().split('\n');
  if (exitIndex >= 0) lines.splice(exitIndex, 0, ...block, '');
  else {
    if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
    lines.push(...block, '');
  }
  return lines.join('\n');
}

async function install() {
  const root = repositoryRoot();
  const target = hookPath(root);
  await mkdir(dirname(target), { recursive: true });
  const existing = existsSync(target) ? await readFile(target, 'utf8') : '#!/bin/sh\n';
  await writeFile(target, addManagedHook(existing), 'utf8');
  await chmod(target, 0o755);
  console.log(`Installed ${HOOK_NAME} hook at ${target}`);
}

function stagedWorkItems(root) {
  const staged = git(root, ['diff', '--cached', '--name-only', '-z']);
  const ids = new Set();
  for (const path of staged.split('\0')) {
    const match = WORK_ITEM_PATH.exec(path);
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids].sort();
}

function output(result, stream) {
  const value = typeof result === 'string' ? result : result ? result.toString() : '';
  if (value) stream.write(value);
}

function runHook() {
  const root = repositoryRoot();
  const workItems = stagedWorkItems(root);
  const cliPath = resolve(root, 'bin/cli.js');
  let status = 0;
  for (const workItemId of workItems) {
    const result = spawnSync(process.execPath, [cliPath, 'work-item', 'validate', '--work-item', workItemId, '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    output(result.stdout, process.stdout);
    output(result.stderr, process.stderr);
    if (result.error) {
      console.error(`Unable to run work-item validation for ${workItemId}: ${result.error.message}`);
      status = status || 1;
    } else if (result.status !== 0) {
      console.error(`Work-item validation failed for ${workItemId}. Commit blocked.`);
      status = status || (result.status ?? 1);
    }
  }
  return status;
}

try {
  if (process.argv.includes('--run-hook')) process.exitCode = runHook();
  else await install();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Git hook installation failed');
  process.exitCode = 1;
}