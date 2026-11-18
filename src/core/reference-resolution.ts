import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { discoverTasks, DiscoveryError } from './discovery.js';
import { validateReference } from './reference.js';

export const REFERENCE_RESOLUTION_SCHEMA = 'https://schemas.handschuh.dev/sdlc/ref/resolution/v1';

export interface ReferenceResolution {
  readonly fullPath: string;
  readonly repositoryPath: string;
  readonly format: 'json' | 'yaml';
  readonly data: unknown;
}

export interface ReferenceResolutionReport {
  readonly schema: typeof REFERENCE_RESOLUTION_SCHEMA;
  readonly ref: string;
  readonly valid: boolean;
  readonly resolution: ReferenceResolution | null;
  readonly findings: readonly string[];
}

interface ParsedDocument {
  readonly fullPath: string;
  readonly repositoryPath: string;
  readonly format: 'json' | 'yaml';
  readonly value: unknown;
}

type Selector = { readonly kind: string; readonly id: string };

function report(ref: string, findings: readonly string[], resolution: ReferenceResolution | null = null): ReferenceResolutionReport {
  return {
    schema: REFERENCE_RESOLUTION_SCHEMA,
    ref,
    valid: findings.length === 0 && resolution !== null,
    resolution,
    findings,
  };
}

function repositoryPath(repositoryRoot: string, fullPath: string): string {
  return relative(repositoryRoot, fullPath).split(sep).join('/');
}

function containedPath(repositoryRoot: string, requestedPath: string): string {
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, requestedPath);
  const remainder = relative(root, candidate);
  if (!remainder || remainder === '..' || remainder.startsWith(`..${sep}`) || !candidate.startsWith(`${root}${sep}`)) {
    throw new DiscoveryError(`Reference path escapes the repository: ${requestedPath}`);
  }
  return candidate;
}

function parseSelector(kind: string, id: string): Selector {
  return { kind, id };
}

function selectorReference(ref: string): { readonly workItemId: string; readonly filename: string; readonly selector: Selector } | undefined {
  const match = /^([A-Z]{1,10}-[0-9]+)#([^#]+)#([a-z][a-z0-9]*(?:-[a-z0-9]*)*)\/([A-Za-z][A-Za-z0-9._:-]*)$/u.exec(ref);
  if (!match) return undefined;
  return { workItemId: match[1]!, filename: match[2]!, selector: parseSelector(match[3]!, match[4]!) };
}

function taskQualifiedReference(ref: string): { readonly workItemId: string; readonly orderKey: string; readonly selector: Selector } | undefined {
  const match = /^([A-Z]{1,10}-[0-9]+)\|([0-9]{2,8})#([a-z][a-z0-9]*(?:-[a-z0-9]*)*)\/([A-Za-z][A-Za-z0-9._:-]*)$/u.exec(ref);
  if (!match) return undefined;
  return { workItemId: match[1]!, orderKey: match[2]!, selector: parseSelector(match[3]!, match[4]!) };
}

function taskUidReference(ref: string): { readonly workItemId: string; readonly orderKey: string } | undefined {
  const match = /^([A-Z]{1,10}-[0-9]+)-([0-9]{8})$/u.exec(ref);
  if (!match) return undefined;
  return { workItemId: match[1]!, orderKey: match[2]! };
}

function workItemReference(ref: string): string | undefined {
  return /^[A-Z]{1,10}-[0-9]+$/u.test(ref) ? ref : undefined;
}

async function parseDocument(repositoryRoot: string, requestedPath: string): Promise<ParsedDocument> {
  const fullPath = containedPath(repositoryRoot, requestedPath);
  const source = await readFile(fullPath, 'utf8');
  const extension = extname(fullPath).toLowerCase();
  if (extension === '.json') {
    return { fullPath, repositoryPath: repositoryPath(repositoryRoot, fullPath), format: 'json', value: JSON.parse(source) };
  }
  if (extension === '.yaml' || extension === '.yml') {
    return { fullPath, repositoryPath: repositoryPath(repositoryRoot, fullPath), format: 'yaml', value: YAML.parse(source) };
  }
  throw new DiscoveryError(`Unsupported reference document format: ${requestedPath}`);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function findById(value: unknown, id: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findById(item, id);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  const object = objectValue(value);
  if (!object) return undefined;
  if (object.id === id) return object;
  for (const child of Object.values(object)) {
    const match = findById(child, id);
    if (match !== undefined) return match;
  }
  return undefined;
}

function selectData(document: unknown, selector: Selector, workItemId: string, taskUid?: string): unknown {
  const object = objectValue(document);
  if (selector.kind === 'work-item' && selector.id === workItemId) return document;
  if (selector.kind === 'task' && taskUid !== undefined && selector.id === taskUid) return document;
  if (selector.kind === 'result' && object?.task && objectValue(object.task)?.result !== undefined && /^R-[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(selector.id)) return objectValue(object.task)!.result;
  return findById(document, selector.id);
}

function success(ref: string, document: ParsedDocument, data: unknown): ReferenceResolutionReport {
  return report(ref, [], {
    fullPath: document.fullPath,
    repositoryPath: document.repositoryPath,
    format: document.format,
    data,
  });
}

async function taskDocument(repositoryRoot: string, workItemId: string, orderKey: string): Promise<{ document: ParsedDocument; taskUid: string } | undefined> {
  const tasks = await discoverTasks(repositoryRoot, workItemId);
  const task = tasks.items.find((candidate) => candidate.taskUid === `${workItemId}-${orderKey}` || candidate.taskUid.endsWith(`-${orderKey}`));
  if (!task) return undefined;
  return { document: await parseDocument(repositoryRoot, task.path), taskUid: task.taskUid };
}

async function resolveLocal(repositoryRoot: string, ref: string): Promise<ReferenceResolutionReport> {
  const bareWorkItem = workItemReference(ref);
  if (bareWorkItem) {
    const document = await parseDocument(repositoryRoot, `.docs/work-items/${bareWorkItem}/work-item.json`);
    return success(ref, document, document.value);
  }

  const bareTask = taskUidReference(ref);
  if (bareTask) {
    const resolved = await taskDocument(repositoryRoot, bareTask.workItemId, bareTask.orderKey);
    if (!resolved) return report(ref, [`Task document not found for task UID: ${ref}`]);
    return success(ref, resolved.document, resolved.document.value);
  }

  const local = selectorReference(ref);
  if (local) {
    const document = await parseDocument(repositoryRoot, `.docs/work-items/${local.workItemId}/${local.filename}`);
    const data = selectData(document.value, local.selector, local.workItemId);
    if (data === undefined) return report(ref, [`Selector not found in ${document.repositoryPath}: ${local.selector.kind}/${local.selector.id}`]);
    return success(ref, document, data);
  }

  const qualified = taskQualifiedReference(ref);
  if (qualified) {
    const resolved = await taskDocument(repositoryRoot, qualified.workItemId, qualified.orderKey);
    if (!resolved) return report(ref, [`Task document not found for task reference: ${ref}`]);
    const data = selectData(resolved.document.value, qualified.selector, qualified.workItemId, resolved.taskUid);
    if (data === undefined) return report(ref, [`Selector not found in ${resolved.document.repositoryPath}: ${qualified.selector.kind}/${qualified.selector.id}`]);
    return success(ref, resolved.document, data);
  }

  if (ref.startsWith('#')) return report(ref, ['Task-local references require an explicit current-task context and cannot be resolved by this command.']);
  if (ref.startsWith('sdlc://repo/')) return report(ref, ['Global references require a repository identity that is not resolved by this local command.']);
  return report(ref, [`Reference form is not supported for local resolution: ${ref}`]);
}

export async function resolveReference(repositoryRoot: string, schemaRoot: string, ref: string): Promise<ReferenceResolutionReport> {
  const syntax = await validateReference(schemaRoot, ref);
  if (!syntax.valid) return report(ref, syntax.findings);
  try {
    return await resolveLocal(repositoryRoot, ref);
  } catch (error) {
    return report(ref, [error instanceof Error ? error.message : `Unable to resolve reference: ${ref}`]);
  }
}