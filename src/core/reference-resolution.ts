import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { discoverTasks, DiscoveryError } from './discovery.js';
import { validateReference } from './reference.js';
import { globalResourceId, repositoryIdentifier } from './global-reference.js';
import { taskEntityKind, taskOwnedParts } from './identifier.js';

export const REFERENCE_RESOLUTION_SCHEMA = 'https://schemas.handschuh.dev/sdlc/ref/resolution/v2';

export interface ReferenceResolution {
  readonly globalResourceId: string;
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

export interface ParsedDocument {
  readonly fullPath: string;
  readonly repositoryPath: string;
  readonly format: 'json' | 'yaml';
  readonly value: unknown;
}

type Selector = { readonly root: 'intent' | 'result'; readonly path: readonly string[]; readonly id: string; readonly legacy?: boolean };
export type TaskContext = { readonly document: ParsedDocument; readonly taskUid: string };

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
  const explicit = /^([A-Z]{1,10}-[0-9]+)-([0-9]{8})#(intent|result)\/(.+)$/u.exec(ref);
  if (explicit) {
    const segments = explicit[4]!.split('/');
    const id = segments.pop();
    if (!id || segments.length === 0 || segments.some((segment) => !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(segment))) return undefined;
    return { workItemId: explicit[1]!, orderKey: explicit[2]!, selector: parseSelector(explicit[3] as 'intent' | 'result', segments, id) };
  }
  const match = /^([A-Z]{1,10}-[0-9]+)-([0-9]{8})#([a-z][a-z0-9]*(?:-[a-z0-9]*)*)\/([A-Za-z][A-Za-z0-9._:-]*)$/u.exec(ref);
  if (!match) return undefined;
  return { workItemId: match[1]!, orderKey: match[2]!, selector: parseSelector('result', [match[3]!], match[4]!, true) };
}

function legacyTaskLocalReference(ref: string): Selector | undefined {
  const match = /^#([a-z][a-z0-9]*(?:-[a-z0-9]*)*)\/([A-Za-z][A-Za-z0-9._:-]*)$/u.exec(ref);
  if (!match) return undefined;
  return parseSelector('result', [match[1]!], match[2]!, true);
}

function taskUidReference(ref: string): { readonly workItemId: string; readonly orderKey: string } | undefined {
  const match = /^([A-Z]{1,10}-[0-9]+)-([0-9]{8})$/u.exec(ref);
  if (!match) return undefined;
  return { workItemId: match[1]!, orderKey: match[2]! };
}

function workItemReference(ref: string): string | undefined {
  return /^[A-Z]{1,10}-[0-9]+$/u.test(ref) ? ref : undefined;
}

function requirementIdentifierReference(ref: string): { readonly workItemId: string; readonly requirementId: string } | undefined {
  const match = /^([A-Z]{1,10}-[0-9]+)_REQ_[0-9]{3}$/u.exec(ref);
  if (!match) return undefined;
  return { workItemId: match[1]!, requirementId: ref };
}

function acceptanceCriterionIdentifierReference(ref: string): { readonly workItemId: string; readonly criterionId: string } | undefined {
  const match = /^([A-Z]{1,10}-[0-9]+)_REQ_[0-9]{3,}_AC_[0-9]{3,}$/u.exec(ref);
  if (!match) return undefined;
  return { workItemId: match[1]!, criterionId: ref };
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
      if (typeof item === 'string' && (item === id || item.endsWith(`/${id}`))) return item;
      const match = findById(item, id);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  const object = objectValue(value);
  if (!object) return undefined;
  if (object.id === id) return object;
  if (typeof object.testCaseRefs === 'object' && Array.isArray(object.testCaseRefs)) {
    const match = object.testCaseRefs.find((item) => typeof item === 'string' && item.endsWith(`/${id}`));
    if (match !== undefined) return match;
  }
  for (const child of Object.values(object)) {
    const match = findById(child, id);
    if (match !== undefined) return match;
  }
  return undefined;
}

function findReferenceString(value: unknown, reference: string): string | undefined {
  if (typeof value === 'string') return value === reference ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findReferenceString(item, reference);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  const object = objectValue(value);
  if (!object) return undefined;
  for (const child of Object.values(object)) {
    const match = findReferenceString(child, reference);
    if (match !== undefined) return match;
  }
  return undefined;
}

function selectData(document: unknown, selector: Selector, workItemId: string, taskUid?: string): unknown {
  const object = objectValue(document);
  if (selector.legacy) {
    if (selector.path[0] === 'result' && object?.task && objectValue(object.task)?.result !== undefined) return objectValue(object.task)!.result;
    if (selector.path[0] === 'task' && taskUid !== undefined && selector.id === taskUid) return document;
    const legacyReference = `#${selector.path[0]}/${selector.id}`;
    const referenceString = findReferenceString(object?.task, legacyReference);
    if (referenceString !== undefined) return referenceString;
    return findById(document, selector.id);
  }
  if (selector.root === 'intent' || selector.root === 'result') {
    const task = objectValue(object?.task);
    let current: unknown = task?.[selector.root];
    if (selector.root === 'result' && selector.path.length === 0) return current;
    for (const segment of selector.path) {
      const currentObject = objectValue(current);
      if (!currentObject || !(segment in currentObject)) return undefined;
      current = currentObject[segment];
    }
    return findById(current, selector.id);
  }
  return undefined;
}

function success(ref: string, repository: string, document: ParsedDocument, data: unknown): ReferenceResolutionReport {
  return report(ref, [], {
    globalResourceId: globalResourceId(repository, ref, document, data),
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

function taskSelector(kind: string, id: string): Selector | undefined {
  const paths: Readonly<Record<string, { readonly root: 'intent' | 'result'; readonly path: readonly string[] }>> = {
    objective: { root: 'intent', path: ['objectives'] },
    input: { root: 'intent', path: ['inputs'] },
    target: { root: 'intent', path: ['targets'] },
    procedure: { root: 'intent', path: ['procedures'] },
    'test-case': { root: 'intent', path: ['objectives'] },
    change: { root: 'result', path: ['implementation', 'changes'] },
    execution: { root: 'result', path: ['verification', 'tests'] },
    artifact: { root: 'result', path: ['artifacts'] },
    finding: { root: 'result', path: ['findings'] },
    result: { root: 'result', path: [] },
    outcome: { root: 'result', path: ['outcomes'] },
  };
  const selected = paths[kind];
  return selected ? parseSelector(selected.root, selected.path, id) : undefined;
}

function globalReferenceParts(ref: string): { readonly repository: string; readonly target: string } | undefined {
  const match = /^sdlc:\/\/repo\/([^/]+)\/(.+)$/u.exec(ref);
  if (!match) return undefined;
  try {
    return { repository: decodeURIComponent(match[1]!), target: match[2]! };
  } catch {
    return undefined;
  }
}

async function resolveLocal(repositoryRoot: string, ref: string, currentTask?: TaskContext): Promise<ReferenceResolutionReport> {
  const repository = await repositoryIdentifier(repositoryRoot);
  const global = globalReferenceParts(ref);
  if (global) {
    if (global.repository !== repository) return report(ref, [`Global reference belongs to repository ${global.repository}, not ${repository}.`]);
    const taskTarget = /^([A-Z]{1,10}-[0-9]+-[0-9]{8})#([^/]+)\/(.+)$/u.exec(global.target);
    if (taskTarget) {
      const task = await taskDocument(repositoryRoot, taskTarget[1]!.slice(0, taskTarget[1]!.lastIndexOf('-')), taskTarget[1]!.slice(taskTarget[1]!.lastIndexOf('-') + 1));
      if (!task) return report(ref, [`Task document not found for global reference: ${ref}`]);
      if (taskTarget[2] === 'task' && taskTarget[3] === task.taskUid) return success(ref, repository, task.document, task.document.value);
      const selector = taskSelector(taskTarget[2]!, taskTarget[3]!);
      if (!selector) return report(ref, [`Global entity kind is not supported: ${taskTarget[2]}`]);
      const data = selectData(task.document.value, selector, taskTarget[1]!.slice(0, taskTarget[1]!.lastIndexOf('-')), task.taskUid);
      if (data === undefined) return report(ref, [`Global task entity not found in ${task.document.repositoryPath}: ${taskTarget[3]}`]);
      return success(ref, repository, task.document, data);
    }
    const workItemTarget = /^([A-Z]{1,10}-[0-9]+)#([^%]+)%23([^/]+)\/(.+)$/u.exec(global.target);
    if (workItemTarget) {
      const filename = workItemTarget[2]!;
      const document = await parseDocument(repositoryRoot, `.docs/work-items/${workItemTarget[1]!}/${filename}`);
      const kind = workItemTarget[3]!;
      if (kind === 'work-item' && workItemTarget[4] === workItemTarget[1]) return success(ref, repository, document, document.value);
      const data = findById(document.value, workItemTarget[4]!);
      if (data === undefined) return report(ref, [`Global work-item entity not found in ${document.repositoryPath}: ${workItemTarget[4]}`]);
      return success(ref, repository, document, data);
    }
    return report(ref, [`Global reference form is not supported for local resolution: ${ref}`]);
  }
  const criterion = acceptanceCriterionIdentifierReference(ref);
  if (criterion) {
    const document = await parseDocument(repositoryRoot, `.docs/work-items/${criterion.workItemId}/work-item.json`);
    const workItem = objectValue(document.value);
    const requirements = objectValue(workItem?.requirements);
    const items = requirements?.items;
    if (!Array.isArray(items)) return report(ref, [`Authoritative requirements.items array not found in ${document.repositoryPath}.`]);
    const matches = items.flatMap((item) => {
      const requirement = objectValue(item);
      const criteria = requirement?.acceptanceCriteria;
      return Array.isArray(criteria) ? criteria.filter((candidate) => objectValue(candidate)?.id === criterion.criterionId) : [];
    });
    if (matches.length === 0) return report(ref, [`Acceptance criterion not found in ${document.repositoryPath}: ${criterion.criterionId}`]);
    if (matches.length > 1) return report(ref, [`Duplicate acceptance criterion identifier in ${document.repositoryPath}: ${criterion.criterionId}`]);
    return success(ref, repository, document, matches[0]);
  }
  const requirement = requirementIdentifierReference(ref);
  if (requirement) {
    const document = await parseDocument(repositoryRoot, `.docs/work-items/${requirement.workItemId}/work-item.json`);
    const workItem = objectValue(document.value);
    const requirements = objectValue(workItem?.requirements);
    const items = requirements?.items;
    if (!Array.isArray(items)) return report(ref, [`Authoritative requirements.items array not found in ${document.repositoryPath}.`]);
    const matches = items.filter((item) => objectValue(item)?.id === requirement.requirementId);
    if (matches.length === 0) return report(ref, [`Requirement not found in ${document.repositoryPath}: ${requirement.requirementId}`]);
    if (matches.length > 1) return report(ref, [`Duplicate requirement identifier in ${document.repositoryPath}: ${requirement.requirementId}`]);
    return success(ref, repository, document, matches[0]);
  }

  const bareWorkItem = workItemReference(ref);
  if (bareWorkItem) {
    const document = await parseDocument(repositoryRoot, `.docs/work-items/${bareWorkItem}/work-item.json`);
    return success(ref, repository, document, document.value);
  }

  const bareTask = taskUidReference(ref);
  if (bareTask) {
    const resolved = await taskDocument(repositoryRoot, bareTask.workItemId, bareTask.orderKey);
    if (!resolved) return report(ref, [`Task document not found for task UID: ${ref}`]);
    return success(ref, repository, resolved.document, resolved.document.value);
  }

  const owned = taskOwnedParts(ref);
  if (owned) {
    const resolved = await taskDocument(repositoryRoot, owned.taskUid.slice(0, owned.taskUid.lastIndexOf('-')), owned.taskUid.slice(owned.taskUid.lastIndexOf('-') + 1));
    if (!resolved) return report(ref, [`Task document not found for task-owned identifier: ${ref}`]);
    const selector = taskSelector(taskEntityKind(ref), ref);
    if (!selector) return report(ref, [`Task-owned identifier category is not supported: ${ref}`]);
    const data = selectData(resolved.document.value, selector, owned.taskUid.slice(0, owned.taskUid.lastIndexOf('-')), resolved.taskUid);
    if (data === undefined) return report(ref, [`Task-owned identifier not found in ${resolved.document.repositoryPath}: ${ref}`]);
    return success(ref, repository, resolved.document, data);
  }

  const local = selectorReference(ref);
  if (local) {
    const document = await parseDocument(repositoryRoot, `.docs/work-items/${local.workItemId}/${local.filename}`);
    const data = selectData(document.value, local.selector, local.workItemId);
    if (data === undefined) return report(ref, [`Selector not found in ${document.repositoryPath}: ${local.selector.root}/${local.selector.path.join('/')}/${local.selector.id}`]);
    return success(ref, repository, document, data);
  }

  const localTask = taskLocalReference(ref);
  if (localTask) {
    if (!currentTask) return report(ref, ['Task-local references require an explicit current-task document context and cannot be resolved by this command root alone.']);
    const data = selectData(currentTask.document.value, localTask, currentTask.document.repositoryPath.split('/')[2] ?? '', currentTask.taskUid);
    if (data === undefined) return report(ref, [`Selector not found in ${currentTask.document.repositoryPath}: ${localTask.root}/${localTask.path.join('/')}/${localTask.id}`]);
    return success(ref, repository, currentTask.document, data);
  }

  const legacyLocalTask = legacyTaskLocalReference(ref);
  if (legacyLocalTask) {
    if (!currentTask) return report(ref, ['Legacy task-local references require migration and an explicit current-task context before resolution.']);
    const data = selectData(currentTask.document.value, legacyLocalTask, '', currentTask.taskUid);
    if (data === undefined) return report(ref, [`Legacy selector not found in ${currentTask.document.repositoryPath}: ${legacyLocalTask.path[0]}/${legacyLocalTask.id}`]);
    return success(ref, repository, currentTask.document, data);
  }

  const qualified = taskQualifiedReference(ref);
  if (qualified) {
    const resolved = await taskDocument(repositoryRoot, qualified.workItemId, qualified.orderKey);
    if (!resolved) return report(ref, [`Task document not found for task reference: ${ref}`]);
    const data = selectData(resolved.document.value, qualified.selector, qualified.workItemId, resolved.taskUid);
    if (data === undefined) return report(ref, [`Selector not found in ${resolved.document.repositoryPath}: ${qualified.selector.root}/${qualified.selector.path.join('/')}/${qualified.selector.id}`]);
    return success(ref, repository, resolved.document, data);
  }

  const legacyQualified = ref.match(/^([A-Z]{1,10}-[0-9]+)-([0-9]{8})#result\/([A-Za-z][A-Za-z0-9._:-]*)$/u);
  if (legacyQualified) {
    const resolved = await taskDocument(repositoryRoot, legacyQualified[1]!, legacyQualified[2]!);
    if (!resolved) return report(ref, [`Task document not found for task reference: ${ref}`]);
    return success(ref, repository, resolved.document, objectValue(resolved.document.value)?.task && objectValue(objectValue(resolved.document.value)!.task)?.result);
  }

  if (ref.startsWith('#')) return report(ref, ['Task-local references require an explicit current-task context and cannot be resolved by this command.']);
  if (ref.startsWith('sdlc://repo/')) return report(ref, ['Global reference could not be resolved.']);
  return report(ref, [`Reference form is not supported for local resolution: ${ref}`]);
}

export async function resolveReference(repositoryRoot: string, schemaRoot: string, ref: string, depth = 1, currentTask?: TaskContext): Promise<ReferenceResolutionReport> {
  const syntax = await validateReference(schemaRoot, ref);
  if (!syntax.valid) return report(ref, syntax.findings);
  try {
    let rootContext = currentTask;
    if (!rootContext) {
      const bareTask = taskUidReference(ref);
      const qualified = taskQualifiedReference(ref);
      const workItemId = bareTask?.workItemId ?? qualified?.workItemId;
      const orderKey = bareTask?.orderKey ?? qualified?.orderKey;
      if (workItemId && orderKey) {
        const task = await taskDocument(repositoryRoot, workItemId, orderKey);
        if (task) rootContext = { document: task.document, taskUid: task.taskUid };
      }
    }
    const root = await resolveLocal(repositoryRoot, ref, rootContext);
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
        const child = await resolveReference(repositoryRoot, schemaRoot, candidate, 1, rootContext);
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

export async function validateReferenceResource(repositoryRoot: string, schemaRoot: string, ref: string): Promise<import('./reference.js').ReferenceValidationReport> {
  const syntax = await validateReference(schemaRoot, ref);
  if (!syntax.valid) return syntax;
  const resolved = await resolveReference(repositoryRoot, schemaRoot, ref);
  if (!resolved.valid || !resolved.resolution) return syntax;
  return {
    ...syntax,
    globalResourceId: resolved.resolution.globalResourceId,
    repositoryPath: resolved.resolution.repositoryPath,
  };
}