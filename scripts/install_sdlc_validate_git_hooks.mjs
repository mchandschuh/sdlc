#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'install_sdlc_validate_git_hooks.mjs';
const HOOK_NAME = 'pre-commit';
const HOOK_NAMES = ['pre-commit', 'post-merge', 'pre-push'];
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

function hookFilePath(root, name) {
  return resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']), name);
}

function managedHook(name) {
  if (name === 'post-merge') return [
    '# >>> sdlc work-item completion reminder >>>',
    'node "$(git rev-parse --show-toplevel)/scripts/install_sdlc_validate_git_hooks.mjs" --post-merge-reminder || exit 0',
    '# <<< sdlc work-item completion reminder <<<',
  ].join('\n');
  if (name === 'pre-push') return [
    '# >>> sdlc primary release validation >>>',
    'node "$(git rev-parse --show-toplevel)/scripts/install_sdlc_validate_git_hooks.mjs" --pre-push "$@"',
    '# <<< sdlc primary release validation <<<',
  ].join('\n');
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

function managedMarkers(name) {
  if (name === 'post-merge') return ['# >>> sdlc work-item completion reminder >>>', '# <<< sdlc work-item completion reminder <<<'];
  if (name === 'pre-push') return ['# >>> sdlc primary release validation >>>', '# <<< sdlc primary release validation <<<'];
  return [START_MARKER, END_MARKER];
}

function removeManagedHook(content, name) {
  const [startMarker, endMarker] = managedMarkers(name);
  const start = content.indexOf(startMarker);
  if (start < 0) return content;
  const end = content.indexOf(endMarker, start);
  if (end < 0) return content;
  const lineStart = content.lastIndexOf('\n', start - 1) + 1;
  let after = end + endMarker.length;
  while (content[after] === '\n' || content[after] === '\r') after += 1;
  return content.slice(0, lineStart) + content.slice(after);
}

function addManagedHook(content, name) {
  const normalized = removeManagedHook(content, name);
  const lines = normalized.split('\n');
  const exitIndex = lines.findLastIndex((line) => line.trim() === 'exit 0');
  const block = managedHook(name).split('\n');
  if (exitIndex >= 0) lines.splice(exitIndex, 0, ...block, '');
  else {
    if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
    lines.push(...block, '');
  }
  return lines.join('\n');
}

async function install() {
  const root = repositoryRoot();
  for (const name of HOOK_NAMES) {
    const target = hookFilePath(root, name);
    await mkdir(dirname(target), { recursive: true });
    const existing = existsSync(target) ? await readFile(target, 'utf8') : '#!/bin/sh\n';
    await writeFile(target, addManagedHook(existing, name), 'utf8');
    await chmod(target, 0o755);
    console.log(`Installed ${name} hook at ${target}`);
  }
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

function stagedEntries(root) {
  const output = git(root, ['diff', '--cached', '--name-status', '-z']);
  const parts = output.split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < parts.length; index += 2) {
    entries.push({ status: parts[index] ?? '', path: parts[index + 1] ?? '' });
  }
  return entries;
}

function output(result, stream) {
  const value = typeof result === 'string' ? result : result ? result.toString() : '';
  if (value) stream.write(value);
}

function runHook() {
  const root = repositoryRoot();
  const workItems = stagedWorkItems(root);
  const taskProcessing = new Map();
  for (const entry of stagedEntries(root)) {
    if (!/^[AMDR]/u.test(entry.status) || !/\.docs\/work-items\/([A-Z]{1,10}-[0-9]+)\/steps\/.*\.(?:yaml|yml|json)$/u.test(entry.path)) continue;
    if (entry.status.startsWith('A')) continue;
    const match = /\.docs\/work-items\/([A-Z]{1,10}-[0-9]+)\/steps\//u.exec(entry.path);
    if (match?.[1]) taskProcessing.set(match[1], true);
  }
  const current = currentBranch(root);
  for (const workItemId of taskProcessing.keys()) {
    const workItem = JSON.parse(readFileSync(resolve(root, `.docs/work-items/${workItemId}/work-item.json`), 'utf8'));
    const expected = workItem.context?.branch?.name;
    if (current !== expected) {
      console.error(`Task processing for ${workItemId} is staged on ${current || 'detached HEAD'}, but must be committed on ${expected}. Switch branches and retry.`);
      return 1;
    }
  }
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

function currentBranch(root) {
  return git(root, ['branch', '--show-current']);
}

function stagedTaskProcessingPaths(root) {
  return git(root, ['diff', '--cached', '--name-only', '-z']).split('\0').filter((path) => /\.docs\/work-items\/[A-Z]{1,10}-[0-9]+\/steps\/.*\.(?:yaml|yml|json)$/u.test(path));
}

function runPrePush() {
  const root = repositoryRoot();
  const branch = currentBranch(root);
  if (!/^(?:main|master)$/u.test(branch)) return 0;
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const tag = spawnSync('git', ['-C', root, 'describe', '--exact-match', '--match', '[0-9]*.[0-9]*.[0-9]*', 'HEAD'], { encoding: 'utf8' });
  if (tag.status !== 0 || !tag.stdout.trim()) {
    console.error(`Primary branch ${branch} is missing an annotated SemVer tag for package.json version ${packageJson.version}. Create the tag on the primary branch before pushing.`);
    return 1;
  }
  return 0;
}

function runPostMergeReminder() {
  const root = repositoryRoot();
  const branch = currentBranch(root);
  console.error(`Post-merge reminder for ${branch}: verify completed work items, calculate the required SemVer impact, create the annotated release tag only on main/master, and push the primary branch and tag when a remote exists.`);
  return 0;
}

try {
  if (process.argv.includes('--run-hook')) process.exitCode = runHook();
  else if (process.argv.includes('--pre-push')) process.exitCode = runPrePush();
  else if (process.argv.includes('--post-merge-reminder')) process.exitCode = runPostMergeReminder();
  else await install();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Git hook installation failed');
  process.exitCode = 1;
}