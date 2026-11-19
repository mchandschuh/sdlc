import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { taskEntityKind, taskOwnedParts } from './identifier.js';

const execFileAsync = promisify(execFile);

export async function repositoryIdentifier(repositoryRoot: string): Promise<string> {
  const origin = await execFileAsync('git', ['-C', repositoryRoot, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' })
    .then((result) => result.stdout.trim())
    .catch(() => '');
  if (origin) {
    const normalized = origin
      .replace(/^[a-z]+:\/\//u, '')
      .replace(/^git@/u, '')
      .replace(/^[^:]+:/u, (prefix) => prefix.slice(0, -1) + '/')
      .replace(/\.git$/u, '')
      .replace(/^\/+|\/+$/gu, '');
    if (normalized) return normalized;
  }
  return `local/${basename(repositoryRoot)}`;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function taskUidFromDocument(document: { readonly repositoryPath: string; readonly value: unknown }): string | undefined {
  const object = document.value && typeof document.value === 'object' && !Array.isArray(document.value)
    ? document.value as Record<string, unknown>
    : undefined;
  return typeof object?.taskUid === 'string' ? object.taskUid : undefined;
}

function workItemIdFromReference(ref: string): string | undefined {
  return /^([A-Z]{1,10}-[0-9]+)/u.exec(ref)?.[1];
}

function globalTaskReference(repository: string, taskUid: string, kind: string, id: string): string {
  return `sdlc://repo/${encoded(repository)}/${taskUid}#${kind}/${id}`;
}

export function globalResourceId(
  repository: string,
  ref: string,
  document: { readonly repositoryPath: string; readonly value: unknown },
  data: unknown,
): string {
  if (ref.startsWith('sdlc://repo/')) return ref;
  const taskUid = taskUidFromDocument(document);
  if (taskUid) {
    if (ref === taskUid) return globalTaskReference(repository, taskUid, 'task', taskUid);
    const id = data && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, unknown>).id === 'string'
      ? (data as Record<string, unknown>).id as string
      : taskOwnedParts(ref)?.localId;
    const taskId = id ?? ref.split('/').at(-1) ?? ref;
    return globalTaskReference(repository, taskUid, taskEntityKind(taskId), taskId);
  }

  const workItemId = workItemIdFromReference(ref) ?? (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, unknown>).workItemId === 'string'
    ? (data as Record<string, unknown>).workItemId as string
    : undefined);
  if (!workItemId) return `sdlc://repo/${encoded(repository)}/${encoded(document.repositoryPath)}%23entity/${encoded(ref)}`;

  const id = data && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, unknown>).id === 'string'
    ? (data as Record<string, unknown>).id as string
    : workItemId;
  const kind = id === workItemId ? 'work-item' : id.includes('_AC_') ? 'acceptance-criterion' : 'requirement';
  return `sdlc://repo/${encoded(repository)}/${workItemId}#work-item.json%23${kind}/${id}`;
}