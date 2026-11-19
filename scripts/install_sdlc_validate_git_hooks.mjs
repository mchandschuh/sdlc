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
const SEMVER_TAG = /^\d+\.\d+\.\d+$/u;
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
  const remoteName = process.argv[process.argv.indexOf('--pre-push') + 1] || '';
  const updates = readFileSync(0, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/u);
    return { localRef, localSha, remoteRef, remoteSha };
  });
  const pushedTags = updates.filter((update) => update.remoteRef?.startsWith('refs/tags/'));
  if (!/^(?:main|master)$/u.test(branch)) {
    if (pushedTags.some((update) => SEMVER_TAG.test(update.remoteRef.slice('refs/tags/'.length)))) {
      console.error(`Release tags are only allowed on the primary branch; current branch is ${branch || 'detached HEAD'}.`);
      return 1;
    }
    return 0;
  }

  const branchUpdate = updates.find((update) => update.localRef === `refs/heads/${branch}`);
  const localSha = branchUpdate?.localSha || git(root, ['rev-parse', 'HEAD']);
  const previousSha = branchUpdate?.remoteSha || '0000000000000000000000000000000000000000';
  const baseSha = previousSha === '0000000000000000000000000000000000000000' ? localSha : previousSha;
  const completed = changedCompletedWorkItems(root, baseSha, localSha);
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const packageChanged = git(root, ['diff', '--name-only', `${baseSha}..${localSha}`]).split('\n').includes('package.json');
  if (completed.length === 0 && !packageChanged) return validatePrimaryTagUpdates(root, updates, remoteName, localSha, null);
  const impact = completed.reduce((highest, item) => Math.max(highest, { revision: 1, minor: 2, major: 3 }[item.impact] || 0), 0);
  const baseline = highestAnnotatedSemverTag(root, baseSha);
  const expected = completed.length > 0 ? nextVersion(baseline || '0.0.0', impact) : packageJson.version;
  if (packageJson.version !== expected) {
    console.error(`Primary release version mismatch: completed work items require ${expected}, but package.json contains ${packageJson.version}. Human intervention is required; the hook will not rewrite the version.`);
    return 1;
  }
  return validatePrimaryTagUpdates(root, updates, remoteName, localSha, expected);
}

function changedCompletedWorkItems(root, oldSha, newSha) {
  const base = /^0+$/.test(oldSha) ? git(root, ['rev-list', '--max-parents=0', newSha]).split('\n')[0] : oldSha;
  const names = git(root, ['diff', '--name-only', `${base}..${newSha}`]).split('\n').filter(Boolean);
  const ids = new Set(names.map((name) => /^\.docs\/work-items\/([A-Z]{1,10}-[0-9]+)\//u.exec(name)?.[1]).filter(Boolean));
  const result = [];
  for (const id of ids) {
    try {
      const value = JSON.parse(spawnSync('git', ['-C', root, 'show', `${newSha}:.docs/work-items/${id}/work-item.json`], { encoding: 'utf8' }).stdout);
      const previous = /^0+$/.test(oldSha)
        ? null
        : JSON.parse(spawnSync('git', ['-C', root, 'show', `${oldSha}:.docs/work-items/${id}/work-item.json`], { encoding: 'utf8' }).stdout || 'null');
      if (value.status === 'complete' && previous?.status !== 'complete' && value.versionSuggestion?.impact) result.push({ id, impact: value.versionSuggestion.impact });
    } catch {
      // The normal work-item validation path reports malformed records; pre-push only skips unreadable candidates.
    }
  }
  return result;
}

function highestAnnotatedSemverTag(root, sha) {
  const tags = git(root, ['tag', '--merged', sha, '--list']).split('\n').filter((tag) => /^\d+\.\d+\.\d+$/u.test(tag));
  const valid = tags.filter((tag) => {
    const type = spawnSync('git', ['-C', root, 'cat-file', '-t', `refs/tags/${tag}`], { encoding: 'utf8' });
    const ancestor = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', `${tag}^{}`, sha]);
    return type.status === 0 && type.stdout.trim() === 'tag' && ancestor.status === 0;
  });
  return valid.sort((left, right) => compareVersions(left, right)).at(-1) || null;
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function nextVersion(base, impact) {
  const [major, minor, patch] = base.split('.').map(Number);
  if (impact >= 3) return `${major + 1}.0.0`;
  if (impact === 2) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function validatePrimaryTagUpdates(root, updates, remoteName, localSha, expected) {
  const semverTagUpdates = updates.filter((update) => update.remoteRef?.startsWith('refs/tags/') && SEMVER_TAG.test(update.remoteRef.slice('refs/tags/'.length)));
  if (!expected) {
    if (semverTagUpdates.some((update) => update.localSha === '0000000000000000000000000000000000000000')) {
      console.error('Deleting a primary-branch SemVer release tag is not allowed.');
      return 1;
    }
    return 0;
  }
  const tagUpdate = semverTagUpdates.find((update) => update.remoteRef === `refs/tags/${expected}`);
  const tagObject = spawnSync('git', ['-C', root, 'rev-parse', `refs/tags/${expected}`], { encoding: 'utf8' });
  const tagType = spawnSync('git', ['-C', root, 'cat-file', '-t', `refs/tags/${expected}`], { encoding: 'utf8' });
  const tagCommit = spawnSync('git', ['-C', root, 'rev-parse', `refs/tags/${expected}^{}`], { encoding: 'utf8' });
  if (tagType.status !== 0 || tagType.stdout.trim() !== 'tag' || tagCommit.stdout.trim() !== localSha || !tagUpdate || tagUpdate.localSha !== tagObject.stdout.trim()) {
    console.error(`Primary release requires annotated tag ${expected} at the primary branch tip ${localSha}, and that exact tag must be included in the push.`);
    return 1;
  }
  for (const update of semverTagUpdates) {
    const name = update.remoteRef.slice('refs/tags/'.length);
    if (name !== expected || update.localSha === '0000000000000000000000000000000000000000' || (update.remoteSha !== '0000000000000000000000000000000000000000' && update.remoteSha !== update.localSha)) {
      console.error(`SemVer tag update ${name} is not the required immutable primary release tag ${expected}.`);
      return 1;
    }
  }
  if (remoteName) {
    const remote = spawnSync('git', ['-C', root, 'ls-remote', '--tags', remoteName, `refs/tags/${expected}`], { encoding: 'utf8' });
    if (remote.status !== 0) return 0;
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