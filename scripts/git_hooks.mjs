#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const ALL_GIT_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change',
];

const WORK_ITEM_PATH = /^\.docs\/work-items\/([A-Z]{1,10}-[0-9]+)(?:\/|$)/u;
const SEMVER_TAG = /^\d+\.\d+\.\d+$/u;
const ZERO_SHA = '0'.repeat(40);

function git(repositoryRoot, args) {
  return execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' }).trim();
}

function repositoryRoot() {
  return git(process.cwd(), ['rev-parse', '--show-toplevel']);
}

function output(result, stream) {
  const value = typeof result === 'string' ? result : result ? result.toString() : '';
  if (value) stream.write(value);
}

export function applypatchMsg() { return 0; }
export function preApplypatch() { return 0; }
export function postApplypatch() { return 0; }
export function postMerge() {
  const root = repositoryRoot();
  const branch = currentBranch(root);
  console.error(`Post-merge reminder for ${branch}: verify completed work items, calculate the required SemVer impact, create the annotated release tag only on main/master, and push the primary branch and tag when a remote exists.`);
  return 0;
}

export function postUpdate() { return 0; }
export function commitMsg() { return 0; }
export function postCommit() { return 0; }
export function preRebase() { return 0; }
export function postCheckout() { return 0; }

export function preCommit() {
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

export function preMergeCommit() { return 0; }

export function prePush(args = [], stdin = '') {
  const root = repositoryRoot();
  const branch = currentBranch(root);
  const remoteName = args[0] || '';
  const updates = stdin.trim().split('\n').filter(Boolean).map((line) => {
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
  const previousSha = branchUpdate?.remoteSha || ZERO_SHA;
  const baseSha = previousSha === ZERO_SHA ? localSha : previousSha;
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

export function prepareCommitMsg() { return 0; }
export function pushToCheckout() { return 0; }
export function preReceive() { return 0; }
export function update() { return 0; }
export function procReceive() { return 0; }
export function postReceive() { return 0; }
export function referenceTransaction() { return 0; }
export function preAutoGc() { return 0; }
export function postRewrite() { return 0; }
export function sendemailValidate() { return 0; }
export function fsmonitorWatchman() { return 0; }
export function p4Changelist() { return 0; }
export function p4PrepareChangelist() { return 0; }
export function p4PostChangelist() { return 0; }
export function p4PreSubmit() { return 0; }
export function postIndexChange() { return 0; }

const HANDLERS = new Map([
  ['applypatch-msg', applypatchMsg],
  ['pre-applypatch', preApplypatch],
  ['post-applypatch', postApplypatch],
  ['pre-commit', preCommit],
  ['pre-merge-commit', preMergeCommit],
  ['prepare-commit-msg', prepareCommitMsg],
  ['commit-msg', commitMsg],
  ['post-commit', postCommit],
  ['pre-rebase', preRebase],
  ['post-checkout', postCheckout],
  ['post-merge', postMerge],
  ['pre-push', prePush],
  ['pre-receive', preReceive],
  ['update', update],
  ['proc-receive', procReceive],
  ['post-receive', postReceive],
  ['post-update', postUpdate],
  ['reference-transaction', referenceTransaction],
  ['push-to-checkout', pushToCheckout],
  ['pre-auto-gc', preAutoGc],
  ['post-rewrite', postRewrite],
  ['sendemail-validate', sendemailValidate],
  ['fsmonitor-watchman', fsmonitorWatchman],
  ['p4-changelist', p4Changelist],
  ['p4-prepare-changelist', p4PrepareChangelist],
  ['p4-post-changelist', p4PostChangelist],
  ['p4-pre-submit', p4PreSubmit],
  ['post-index-change', postIndexChange],
]);

export function dispatch(args = process.argv.slice(2), stdin = readFileSync(0, 'utf8')) {
  const [hookName, ...hookArgs] = args;
  if (hookName !== 'dispatch') throw new Error('Usage: node scripts/git_hooks.mjs dispatch <hook-name> [args...]');
  const handler = HANDLERS.get(hookArgs[0]);
  if (!handler) {
    const supported = ALL_GIT_HOOKS.join(', ');
    console.error(`Unknown Git hook "${hookArgs[0] ?? ''}". Supported hooks: ${supported}`);
    return 1;
  }
  return handler(hookArgs.slice(1), stdin);
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

function currentBranch(root) {
  return git(root, ['branch', '--show-current']);
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
  const tags = git(root, ['tag', '--merged', sha, '--list']).split('\n').filter((tag) => SEMVER_TAG.test(tag));
  const valid = tags.filter((tag) => {
    const type = spawnSync('git', ['-C', root, 'cat-file', '-t', `refs/tags/${tag}`], { encoding: 'utf8' });
    const ancestor = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', `${tag}^{}`, sha]);
    return type.status === 0 && type.stdout.trim() === 'tag' && ancestor.status === 0;
  });
  return valid.sort(compareVersions).at(-1) || null;
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
    if (semverTagUpdates.some((update) => update.localSha === ZERO_SHA)) {
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
    if (name !== expected || update.localSha === ZERO_SHA || (update.remoteSha !== ZERO_SHA && update.remoteSha !== update.localSha)) {
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

if (process.argv[2] === 'dispatch') {
  process.exitCode = dispatch(process.argv.slice(2));
}