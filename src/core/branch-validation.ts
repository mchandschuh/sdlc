import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WORK_ITEM_ID = /^[A-Z]{1,10}-[0-9]+$/u;
const PRIMARY_BRANCH = /^(?:main|master)$/u;

export interface BranchValidationReport {
  readonly valid: boolean;
  readonly currentBranch: string | null;
  readonly detachedHead: boolean;
  readonly mergeTargetBranch: string | null;
  readonly contextBranch: string | null;
  readonly mergeTargetLocal: boolean;
  readonly mergeTargetRemote: boolean;
  readonly remotes: readonly string[];
  readonly findings: readonly string[];
}

interface WorkItemContextValue {
  readonly workItemId: string;
  readonly context?: {
    readonly mergeTarget?: { readonly branch?: unknown };
    readonly branch?: { readonly name?: unknown };
  };
}

async function git(repositoryRoot: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' });
  return result.stdout.trim();
}

async function gitOptional(repositoryRoot: string, args: readonly string[]): Promise<string | null> {
  try {
    return await git(repositoryRoot, args);
  } catch {
    return null;
  }
}

async function gitSucceeds(repositoryRoot: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export async function validateBranchContext(repositoryRoot: string, workItem: WorkItemContextValue): Promise<BranchValidationReport> {
  const findings: string[] = [];
  const current = await gitOptional(repositoryRoot, ['branch', '--show-current']);
  const currentBranch = current || null;
  const detachedHead = currentBranch === null;
  const mergeTarget = typeof workItem.context?.mergeTarget?.branch === 'string' ? workItem.context.mergeTarget.branch : null;
  const contextBranch = typeof workItem.context?.branch?.name === 'string' ? workItem.context.branch.name : null;
  const remotes = (await gitOptional(repositoryRoot, ['remote']))?.split('\n').filter(Boolean) ?? [];
  const mergeTargetLocal = mergeTarget ? await gitSucceeds(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${mergeTarget}`]) : false;
  let mergeTargetRemote = false;
  if (mergeTarget) {
    for (const remote of remotes) {
      if (await gitOptional(repositoryRoot, ['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${mergeTarget}`]) !== null) {
        mergeTargetRemote = true;
        break;
      }
    }
  }

  if (!mergeTarget || !PRIMARY_BRANCH.test(mergeTarget)) findings.push(`mergeTarget.branch must be exactly main or master; received ${mergeTarget ?? 'missing'}.`);
  if (remotes.length > 0 && !mergeTargetRemote) findings.push(`Merge target ${mergeTarget ?? 'missing'} is not available on any configured remote (${remotes.join(', ')}). Fetch or create the target branch before continuing.`);
  if (remotes.length === 0 && !mergeTargetLocal) findings.push(`Merge target ${mergeTarget ?? 'missing'} does not exist locally and no remote is configured. Create the local branch before continuing.`);
  if (!contextBranch || !WORK_ITEM_ID.test(workItem.workItemId) || !new RegExp(`^${escapeRegExp(workItem.workItemId)}-[a-z0-9]+(?:-[a-z0-9]+)*$`, 'u').test(contextBranch)) {
    findings.push(`context.branch.name must match ${workItem.workItemId}-<lowercase-kebab-case-slug>; received ${contextBranch ?? 'missing'}.`);
  }
  if (detachedHead) findings.push('Repository is in detached HEAD; switch to mergeTarget.branch or context.branch.name before validating or committing this work item.');
  else if (currentBranch !== mergeTarget && currentBranch !== contextBranch) findings.push(`Current branch ${currentBranch} is not allowed. Switch to ${mergeTarget ?? '<mergeTarget.branch>'} for planning/merge work or ${contextBranch ?? '<context.branch.name>'} for task processing.`);

  return {
    valid: findings.length === 0,
    currentBranch,
    detachedHead,
    mergeTargetBranch: mergeTarget,
    contextBranch,
    mergeTargetLocal,
    mergeTargetRemote,
    remotes,
    findings,
  };
}