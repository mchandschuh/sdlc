import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { discoverTasks, DiscoveryError } from './discovery.js';
import { validateReference } from './reference.js';

export const REFERENCE_RESOLUTION_SCHEMA = 'https://schemas.handschuh.dev/sdlc/ref/resolution/v2';

export interface ReferenceResolution {
  readonly fullPath: string;
  readonly repositoryPath: string;
  readonly format: 'json' | 'yaml';
  readonly data: unknown;
}

export interface ExpandedReferenceResolution extends ReferenceResolution {
  readonly references: Readonly<Record<string, ReferenceResolution>>;
}

export interface ReferenceResolutionReport {
  readonly schema: typeof REFERENCE_RESOLUTION_SCHEMA;
  readonly ref: string;
  readonly valid: boolean;
  readonly resolution: ExpandedReferenceResolution | null;
  readonly findings: readonly string[];
}

interface ParsedDocument {
  readonly fullPath: string;
  readonly repositoryPath: string;
  readonly format: 'json' | 'yaml';
  readonly value: unknown;
}

type Selector = { readonly root: 'intent' | 'result'; readonly path: readonly string[]; readonly id: string; readonly legacy?: boolean };

function report(ref: string, findings: readonly string[], resolution: ReferenceResolution | null = null, references: Readonly<Record<string, ReferenceResolution>> = {}): ReferenceResolutionReport {
  return {
    schema: REFERENCE_RESOLUTION_SCHEMA,
    ref,
    valid: findings.length === 0 && resolution !== null,
    resolution: resolution ? { ...resolution, references } : null,
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

function parseSelector(root: 'intent' | 'result', path: readonly string[], id: string, legacy = false): Selector {
  return { root, path, id, legacy };
}

function selectorReference(ref: string): { readonly workItemId: string; readonly filename: string; readonly selector: Selector } | undefined {
  const explicit = /^([A-Z]{1,10}-[0-9]+)#([^#]+)#(intent|result)\/(.+)$/u.exec(ref);
  if (explicit) {
    const segments = explicit[4]!.split('/');
    const id = segments.pop();
    if (!id || segments.length === 0 || segments.some((segment) => !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(segment))) return undefined;
    return { workItemId: explicit[1]!, filename: explicit[2]!, selector: parseSelector(explicit[3] as 'intent' | 'result', segments, id) };
  }
  const match = /^([A-Z]{1,10}-[0-9]+)#([^#]+)#([a-z][a-z0-9]*(?:-[a-z0-9]*)*)\/([A-Za-z][A-Za-z0-9._:-]*)$/u.exec(ref);
  if (!match) return undefined;
  return { workItemId: match[1]!, filename: match[2]!, selector: parseSelector('result', [match[3]!], match[4]!, true) };
}

function taskLocalReference(ref: string): Selector | undefined {
  const match = /^#(intent|result)\/(.+)$/u.exec(ref);
  if (!match) return undefined;
  const segments = match[2]!.split('/');
  const id = segments.pop();
  if (!id || segments.length === 0 || segments.some((segment) => !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(segment))) return undefined;
  return parseSelector(match[1] as 'intent' | 'result', segments, id);
}

function taskQualifiedReference(ref: string): { readonly workItemId: string; readonly orderKey: string; readonly selector: Selector } | undefined {
  const explicit = /^([A-Z]{1,10}-[0-9]+)[|]([0-9]{2,8})#(intent|result)\/(.+)$/u.exec(ref);
  if (explicit) {
    const segments = explicit[4]!.split('/');
    const id = segments.pop();
    if (!id || segments.length === 0 || segments.some((segment) => !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(segment))) return undefined;
    return { workItemId: explicit[1]!, orderKey: explicit[2]!, selector: parseSelector(explicit[3] as 'intent' | 'result', segments, id) };
  }
  const match = /^([A-Z]{1,10}-[0-9]+)[|]([0-9]{2,8})#([a-z][a-z0-9]*(?:-[a-z0-9]*)*)\/([A-Za-z][A-Za-z0-9._:-]*)$/u.exec(ref);
  if (!match) return undefined;
  return { workItemId: match[1]!, orderKey: match[2]!, selector: parseSelector('result', [match[3]!], match[4]!, true) };
}

function legacyTaskLocalReference(ref: string): Selector | undefined {
  const match = /^#([a-z][a-z0-9]*(?:-[a-z0-9]*)*)\/([A-Za-z][A-Za-z0-9._:-]*)$/u.exec(ref);
  if (!match) return undefined;
  return parseSelector('result', [match[1]!], match[2]!);
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
  if (selector.legacy) {
    if (selector.path[0] === 'result' && object?.task && objectValue(object.task)?.result !== undefined) return objectValue(object.task)!.result;
    if (selector.path[0] === 'task' && taskUid !== undefined && selector.id === taskUid) return document;
    return findById(document, selector.id);
  }
  if (selector.root === 'intent' || selector.root === 'result') {
    const task = objectValue(object?.task);
    let current: unknown = task?.[selector.root];
    for (const segment of selector.path) {
      const currentObject = objectValue(current);
      if (!currentObject || !(segment in currentObject)) return undefined;
      current = currentObject[segment];
    }
    return findById(current, selector.id);
  }
  return undefined;
}

function success(ref: string, document: ParsedDocument, data: unknown): ReferenceResolutionReport {
  return report(ref, [], {
    fullPath: document.fullPath,
    repositoryPath: document.repositoryPath,
    format: document.format,
    data,
  });
}

function withoutReferences(resolution: ExpandedReferenceResolution): ReferenceResolution {
  const { references: _references, ...document } = resolution;
  return document;
}

async function referenceStrings(value: unknown, schemaRoot: string, cache: Map<string, boolean>, output: string[]): Promise<void> {
  if (typeof value === 'string') {
    let valid = cache.get(value);
    if (valid === undefined) {
      valid = (await validateReference(schemaRoot, value)).valid;
      cache.set(value, valid);
    }
    if (valid) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) await referenceStrings(item, schemaRoot, cache, output);
    return;
  }
  const object = objectValue(value);
  if (!object) return;
  for (const child of Object.values(object)) await referenceStrings(child, schemaRoot, cache, output);
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
    if (data === undefined) return report(ref, [`Selector not found in ${document.repositoryPath}: ${local.selector.root}/${local.selector.path.join('/')}/${local.selector.id}`]);
    return success(ref, document, data);
  }

  const localTask = taskLocalReference(ref);
  if (localTask) return report(ref, ['Task-local references require an explicit current-task document context and cannot be resolved by this command root alone.']);

  const legacyLocalTask = legacyTaskLocalReference(ref);
  if (legacyLocalTask) return report(ref, ['Legacy task-local references require migration to an explicit intent/result path before resolution.']);

  const qualified = taskQualifiedReference(ref);
  if (qualified) {
    const resolved = await taskDocument(repositoryRoot, qualified.workItemId, qualified.orderKey);
    if (!resolved) return report(ref, [`Task document not found for task reference: ${ref}`]);
    const data = selectData(resolved.document.value, qualified.selector, qualified.workItemId, resolved.taskUid);
    if (data === undefined) return report(ref, [`Selector not found in ${resolved.document.repositoryPath}: ${qualified.selector.root}/${qualified.selector.path.join('/')}/${qualified.selector.id}`]);
    return success(ref, resolved.document, data);
  }

  const legacyQualified = ref.match(/^([A-Z]{1,10}-[0-9]+)[|]([0-9]{2,8})#result\/([A-Za-z][A-Za-z0-9._:-]*)$/u);
  if (legacyQualified) {
    const resolved = await taskDocument(repositoryRoot, legacyQualified[1]!, legacyQualified[2]!);
    if (!resolved) return report(ref, [`Task document not found for task reference: ${ref}`]);
    return success(ref, resolved.document, objectValue(resolved.document.value)?.task && objectValue(objectValue(resolved.document.value)!.task)?.result);
  }

  if (ref.startsWith('#')) return report(ref, ['Task-local references require an explicit current-task context and cannot be resolved by this command.']);
  if (ref.startsWith('sdlc://repo/')) return report(ref, ['Global references require a repository identity that is not resolved by this local command.']);
  return report(ref, [`Reference form is not supported for local resolution: ${ref}`]);
}

export async function resolveReference(repositoryRoot: string, schemaRoot: string, ref: string, depth = 1): Promise<ReferenceResolutionReport> {
  const syntax = await validateReference(schemaRoot, ref);
  if (!syntax.valid) return report(ref, syntax.findings);
  try {
    const root = await resolveLocal(repositoryRoot, ref);
    if (!root.resolution || depth <= 1 || !root.valid) return root;

    const references: Record<string, ReferenceResolution> = {};
    const seen = new Set<string>([ref]);
    const syntaxCache = new Map<string, boolean>([[ref, true]]);
    const findings = [...root.findings];
    let frontier: unknown[] = [root.resolution.data];

    for (let round = 1; round < depth; round += 1) {
      const candidates: string[] = [];
      for (const value of frontier) await referenceStrings(value, schemaRoot, syntaxCache, candidates);
      const next: unknown[] = [];
      for (const candidate of candidates) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const child = await resolveReference(repositoryRoot, schemaRoot, candidate, 1);
        if (!child.resolution) {
          findings.push(...child.findings.map((finding) => `Referenced ${candidate}: ${finding}`));
          continue;
        }
        references[candidate] = withoutReferences(child.resolution);
        next.push(child.resolution.data);
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return report(ref, findings, root.resolution, references);
  } catch (error) {
    return report(ref, [error instanceof Error ? error.message : `Unable to resolve reference: ${ref}`]);
  }
}