import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { DiscoveryError } from './discovery.js';
import { validateBranchContext } from './branch-validation.js';

const execFileAsync = promisify(execFile);

async function git(repositoryRoot: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' });
  return result.stdout.trim();
}

export interface WorkItemStartReport {
  readonly schema: 'https://schemas.handschuh.dev/sdlc/work-item-start/v1';
  readonly workItemId: string;
  readonly started: boolean;
  readonly branch: string;
  readonly commit: string | null;
  readonly message: string;
}

export async function startWorkItem(repositoryRoot: string, workItemId: string): Promise<WorkItemStartReport> {
  const path = resolve(repositoryRoot, `.docs/work-items/${workItemId}/work-item.json`);
  const workItem = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
  const branch = workItem.context?.branch?.name;
  const mergeTarget = workItem.context?.mergeTarget?.branch;
  if (typeof branch !== 'string' || typeof mergeTarget !== 'string') throw new DiscoveryError('Work item is missing context.mergeTarget.branch or context.branch.name.');
  const context = await validateBranchContext(repositoryRoot, { workItemId, context: workItem.context });
  if (context.currentBranch === branch && workItem.context?.branch?.created === true) {
    return { schema: 'https://schemas.handschuh.dev/sdlc/work-item-start/v1', workItemId, started: false, branch, commit: null, message: `Work item ${workItemId} is already started on ${branch}.` };
  }
  if (context.currentBranch !== mergeTarget) throw new DiscoveryError(`Cannot start ${workItemId} from ${context.currentBranch ?? 'detached HEAD'}. Switch to merge target ${mergeTarget} first.`);
  if (context.findings.some((finding) => finding.includes('Merge target') || finding.includes('mergeTarget.branch'))) throw new DiscoveryError(context.findings.join(' '));
  if ((await git(repositoryRoot, ['status', '--porcelain'])).length > 0) throw new DiscoveryError('Cannot start a work item with a dirty worktree. Commit or stash unrelated changes first.');
  if (await git(repositoryRoot, ['branch', '--list', branch])) throw new DiscoveryError(`Context branch ${branch} already exists. Switch to it and verify context.branch.created before retrying.`);
  await git(repositoryRoot, ['switch', '-c', branch]);
  workItem.context.branch.created = true;
  await writeFile(path, `${JSON.stringify(workItem, null, 2)}\n`);
  await git(repositoryRoot, ['add', '--', `.docs/work-items/${workItemId}/work-item.json`]);
  await git(repositoryRoot, ['commit', '-m', `${workItemId}: chore(work-item): start processing branch`]);
  const commit = await git(repositoryRoot, ['rev-parse', 'HEAD']);
  return { schema: 'https://schemas.handschuh.dev/sdlc/work-item-start/v1', workItemId, started: true, branch, commit, message: `Started ${workItemId} on ${branch} and committed context.branch.created=true.` };
}