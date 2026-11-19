import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { DiscoveryError, enumerateWorkItemObjects } from './discovery.js';
import { isTaskOwnedId, isTaskOwnedLocalId, taskOwnedId } from './identifier.js';

export const TASK_LOCAL_MIGRATION_SCHEMA = 'https://schemas.handschuh.dev/sdlc/ref/task-local-migration/v1';
export const WORK_ITEM_MIGRATION_SCHEMA = 'https://schemas.handschuh.dev/sdlc/ref/work-item-migration/v1';

export interface MigrationReplacement {
  readonly from: string;
  readonly to: string;
  readonly count: number;
}

export interface MigrationFile {
  readonly path: string;
  readonly changed: boolean;
  readonly replacements: readonly MigrationReplacement[];
}

export interface UnresolvableReference {
  readonly path: string;
  readonly reference: string;
  readonly context: string;
  readonly reason: string;
  readonly preserved: true;
}

export interface TaskLocalMigrationReport {
  readonly schema: typeof TASK_LOCAL_MIGRATION_SCHEMA;
  readonly path: string;
  readonly changedFiles: readonly string[];
  readonly files: readonly MigrationFile[];
  readonly replacements: readonly MigrationReplacement[];
  readonly unresolvable: readonly UnresolvableReference[];
  readonly findings: readonly string[];
}

export interface WorkItemMigrationReport extends Omit<TaskLocalMigrationReport, 'schema' | 'path'> {
  readonly schema: typeof WORK_ITEM_MIGRATION_SCHEMA;
  readonly workItemId: string;
  readonly path: string;
}

const WORK_ITEM_ID = '[A-Z]{1,10}-[0-9]+';
const WORK_ITEM_ID_PATTERN = /^[A-Z]{1,10}-[0-9]+$/u;
const ORDER_KEY = '[0-9]{2,8}';
const ID = '[A-Za-z][A-Za-z0-9._:-]*';
const TASK_QUALIFIED = new RegExp(`^(${WORK_ITEM_ID})\\|(${ORDER_KEY})#([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/(${ID})$`, 'u');
const HYPHEN_QUALIFIED = new RegExp(`^(${WORK_ITEM_ID})-([0-9]{8})#([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/(${ID})$`, 'u');
const TASK_ID = new RegExp(`^(${WORK_ITEM_ID})\\|(${ORDER_KEY})$`, 'u');
const TASK_LOCAL = new RegExp(`^#([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/(${ID})$`, 'u');
const WORK_ITEM_LOCAL = new RegExp(`^(${WORK_ITEM_ID})\\|(${ORDER_KEY})#work-item/(${WORK_ITEM_ID})$`, 'u');
const CANONICAL = /^#(?:intent|result)\/.+$/u;

interface TaskContext {
  readonly workItemId: string;
  readonly taskUid: string;
  readonly path: string;
  readonly value: unknown;
}

function canonicalizeTaskOwnedText(source: string, task: TaskContext | undefined, path: string, unresolvable: UnresolvableReference[], replacements: Map<string, MigrationReplacement>): string {
  if (!task) return source;
  const envelope = objectValue(task.value);
  if (envelope?.schema !== 'https://schemas.handschuh.dev/sdlc/task-envelope/v1') return source;
  const pattern = /\b(?:INPUT|OBJ|TARGET|VAL|TC|CHANGE|EXEC|ART|FIND|PROC|INV|R|O|Q|UQ|AC)-[A-Za-z0-9][A-Za-z0-9-]*\b/gu;
  return source.replace(pattern, (value, offset: number) => {
    if (isTaskOwnedId(value)) return value;
    if (!isTaskOwnedLocalId(value)) return value;
    const paths: string[] = [];
    const payload = objectValue(envelope?.task);
    for (const root of ['intent', 'result'] as const) entityPaths(payload?.[root], [root], value, paths);
    if (paths.length === 0) return value;
    if (paths.length > 1) {
      unresolvable.push(unresolved(path, value, task.taskUid, `Entity id ${value} is ambiguous across task-local paths: ${paths.join(', ')}.`));
      return value;
    }
    const canonical = taskOwnedId(task.taskUid, value);
    const key = `${value}\u0000${canonical}`;
    const previous = replacements.get(key);
    replacements.set(key, { from: value, to: canonical, count: (previous?.count ?? 0) + 1 });
    return canonical;
  });
}

const intentCollections: Readonly<Record<string, string>> = {
  objective: 'objectives',
  requirement: 'inputs',
  input: 'inputs',
  target: 'targets',
  procedure: 'procedures',
  'test-case': 'testCaseRefs',
};

const resultCollections: Readonly<Record<string, string>> = {
  result: 'results',
  outcome: 'outcomes',
  finding: 'findings',
  artifact: 'artifacts',
  verification: 'verification',
};

function repositoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function containedPath(root: string, requested: string): string {
  if (!requested || requested.startsWith('-')) throw new DiscoveryError('--path requires a repository-relative file or directory.');
  const base = resolve(root);
  const candidate = resolve(base, requested);
  const remainder = relative(base, candidate);
  if (!remainder || remainder === '..' || remainder.startsWith(`..${sep}`) || !candidate.startsWith(`${base}${sep}`)) {
    throw new DiscoveryError(`Path must remain within the repository: ${requested}`);
  }
  return candidate;
}

async function filesUnder(root: string, selected: string): Promise<string[]> {
  const metadata = await stat(selected).catch(() => undefined);
  if (!metadata) throw new DiscoveryError(`Migration path does not exist: ${repositoryPath(root, selected)}`);
  if (metadata.isFile()) return [selected];
  return enumerateWorkItemObjects(selected);
}

function taskIdentityFor(path: string): { readonly workItemId: string; readonly taskUid: string } | undefined {
  const match = /(?:^|[/\\])([A-Z]{1,10}-[0-9]+)-([0-9]{8})[^/\\]*\.(?:json|ya?ml|ts|md)$/u.exec(path);
  if (!match) return undefined;
  return { workItemId: match[1]!, taskUid: `${match[1]!}-${match[2]!}` };
}

async function taskContextFor(root: string, path: string): Promise<TaskContext | undefined> {
  const identity = taskIdentityFor(path);
  if (!identity) return undefined;
  try {
    const source = await readFile(path, 'utf8');
    const value = extname(path).toLowerCase() === '.json' ? JSON.parse(source) : YAML.parse(source);
    return { ...identity, path: repositoryPath(root, path), value };
  } catch {
    return undefined;
  }
}

async function findTaskContext(root: string, taskUid: string, cache: Map<string, TaskContext | undefined>): Promise<TaskContext | undefined> {
  if (cache.has(taskUid)) return cache.get(taskUid);
  const match = /^([A-Z]{1,10}-[0-9]+)-([0-9]{8})$/u.exec(taskUid);
  if (!match) {
    cache.set(taskUid, undefined);
    return undefined;
  }
  const steps = resolve(root, `.docs/work-items/${match[1]!}/steps`);
  const files = await enumerateWorkItemObjects(steps).catch(() => []);
  for (const path of files) {
    const context = await taskContextFor(root, path);
    if (context?.taskUid === taskUid) {
      cache.set(taskUid, context);
      return context;
    }
  }
  cache.set(taskUid, undefined);
  return undefined;
}

function selector(kind: string, id: string): string | undefined {
  const intent = intentCollections[kind];
  if (intent) return `#intent/${intent}/${id}`;
  const result = resultCollections[kind];
  if (result) return `#result/${result}/${id}`;
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function entityPaths(value: unknown, path: readonly string[], id: string, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) entityPaths(item, path, id, output);
    return;
  }
  const object = objectValue(value);
  if (!object) return;
  if (object.id === id) output.push(path.join('/'));
  for (const [key, child] of Object.entries(object)) {
    if (key === 'task') continue;
    entityPaths(child, [...path, key], id, output);
  }
}

function resolvableSelector(context: TaskContext, kind: string, id: string): { readonly value?: string; readonly reason?: string } {
  const envelope = objectValue(context.value);
  const task = objectValue(envelope?.task);
  if (!task) return { reason: 'Containing task document has no task payload.' };
  const paths: string[] = [];
  const canonical = envelope?.schema === 'https://schemas.handschuh.dev/sdlc/task-envelope/v1';
  const canonicalId = canonical && !isTaskOwnedId(id) && isTaskOwnedLocalId(id) ? taskOwnedId(context.taskUid, id) : id;
  for (const root of ['intent', 'result'] as const) {
    entityPaths(task[root], [root], id, paths);
    if (paths.length === 0) entityPaths(task[root], [root], canonicalId, paths);
  }
  if (paths.length === 0) return { reason: `No task-local entity with id ${id} exists in intent or result.` };
  if (paths.length > 1) return { reason: `Entity id ${id} is ambiguous across task-local paths: ${paths.join(', ')}.` };
  const path = paths[0]!;
  return { value: `#${path}/${canonicalId}` };
}

function unresolved(path: string, reference: string, context: string, reason: string): UnresolvableReference {
  return { path, reference, context, reason, preserved: true };
}

function migrateReference(value: string, task: { readonly workItemId: string; readonly taskUid: string } | undefined): { value: string; from: string; to: string } | undefined {
  const taskId = TASK_ID.exec(value);
  if (taskId) {
    const to = `${taskId[1]!}-${taskId[2]!.padStart(8, '0')}`;
    return { value: to, from: value, to };
  }
  const qualified = TASK_QUALIFIED.exec(value);
  const hyphenQualified = HYPHEN_QUALIFIED.exec(value);
  if (qualified || hyphenQualified) {
    const match = qualified ?? hyphenQualified!;
    const [, workItemId, orderKey, kind, id] = match;
    const local = selector(kind!, id!);
    if (!local) return undefined;
    const to = `${workItemId}-${orderKey!.padStart(8, '0')}${local}`;
    return { value: to, from: value, to };
  }
  const local = TASK_LOCAL.exec(value);
  if (!local || !task || CANONICAL.test(value)) return undefined;
  const target = selector(local[1]!, local[2]!);
  if (!target) return undefined;
  return { value: target, from: value, to: target };
}

async function migrateText(
  root: string,
  path: string,
  source: string,
  task: TaskContext | undefined,
  taskCache: Map<string, TaskContext | undefined>,
): Promise<{ text: string; replacements: MigrationReplacement[]; unresolvable: UnresolvableReference[] }> {
  const replacements = new Map<string, MigrationReplacement>();
  const unresolvable: UnresolvableReference[] = [];
  const pattern = new RegExp(`${WORK_ITEM_ID}(?:\\||-)[0-9]{2,8}#[a-z][a-z0-9]*(?:-[a-z0-9]+)*/${ID}(?![/A-Za-z0-9._:-])|${WORK_ITEM_ID}\\|${ORDER_KEY}#work-item/${WORK_ITEM_ID}|${WORK_ITEM_ID}\\|${ORDER_KEY}|(?<![A-Za-z0-9_.#])#(?!intent/|result/)[a-z][a-z0-9]*(?:-[a-z0-9]+)*/${ID}(?![/A-Za-z0-9._:-])`, 'gu');
  const matches = [...source.matchAll(pattern)];
  let cursor = 0;
  let text = '';
  for (const match of matches) {
    const value = match[0]!;
    text += source.slice(cursor, match.index);
    cursor = match.index! + value.length;
    const qualifiedWorkItem = WORK_ITEM_LOCAL.exec(value);
    if (qualifiedWorkItem) {
      const workItemPath = resolve(root, `.docs/work-items/${qualifiedWorkItem[3]!}/work-item.json`);
      try {
        const workItem = JSON.parse(await readFile(workItemPath, 'utf8')) as { workItemId?: string };
        if (workItem.workItemId === qualifiedWorkItem[3]!) {
          const migrated = { from: value, to: `${qualifiedWorkItem[3]}#work-item.json#work-item/${qualifiedWorkItem[3]}` };
          const previous = replacements.get(`${migrated.from}\u0000${migrated.to}`);
          replacements.set(`${migrated.from}\u0000${migrated.to}`, { ...migrated, count: (previous?.count ?? 0) + 1 });
          text += migrated.to;
          continue;
        }
      } catch {
        // Fall through to the explicit unresolved report.
      }
      unresolvable.push(unresolved(path, value, 'work-item', `Work-item target ${qualifiedWorkItem[3]} could not be resolved.`));
      text += value;
      continue;
    }
    const taskId = TASK_ID.exec(value);
    if (taskId) {
      const targetUid = `${taskId[1]!}-${taskId[2]!.padStart(8, '0')}`;
      if (task?.taskUid === targetUid || await findTaskContext(root, targetUid, taskCache)) {
        const previous = replacements.get(`${value}\u0000${targetUid}`);
        replacements.set(`${value}\u0000${targetUid}`, { from: value, to: targetUid, count: (previous?.count ?? 0) + 1 });
      } else {
        unresolvable.push(unresolved(path, value, 'task', `Task ${targetUid} could not be resolved.`));
      }
      text += (replacements.has(`${value}\u0000${targetUid}`) ? targetUid : value);
      continue;
    }
    const qualified = TASK_QUALIFIED.exec(value) ?? HYPHEN_QUALIFIED.exec(value);
    const local = TASK_LOCAL.exec(value);
    const targetUid = qualified ? `${qualified[1]!}-${qualified[2]!.padStart(8, '0')}` : undefined;
    const targetContext = qualified
      ? (task?.taskUid === targetUid ? task : await findTaskContext(root, targetUid!, taskCache))
      : task;
    const kind = qualified?.[3] ?? local?.[1];
    const id = qualified?.[4] ?? local?.[2];
    if (!targetContext || !kind || !id) {
      unresolvable.push(unresolved(path, value, task ? task.taskUid : 'no-task-context', targetContext ? 'Reference selector could not be parsed.' : 'No containing task context is available.'));
      text += value;
      continue;
    }
    if (isTaskOwnedId(id)) {
      text += value;
      continue;
    }
    const resolved = resolvableSelector(targetContext, kind, id);
    if (!resolved.value) {
      unresolvable.push(unresolved(path, value, targetContext.taskUid, resolved.reason!));
      text += value;
      continue;
    }
    const replacement = qualified ? `${targetContext.taskUid}${resolved.value}` : resolved.value;
    const previous = replacements.get(`${value}\u0000${replacement}`);
    replacements.set(`${value}\u0000${replacement}`, { from: value, to: replacement, count: (previous?.count ?? 0) + 1 });
    text += replacement;
  }
  text += source.slice(cursor);
  text = canonicalizeTaskOwnedText(text, task, path, unresolvable, replacements);
  return { text, replacements: [...replacements.values()], unresolvable };
}

export async function migrateTaskLocalReferences(repositoryRoot: string, requestedPath: string): Promise<TaskLocalMigrationReport> {
  const selected = containedPath(repositoryRoot, requestedPath);
  const paths = await filesUnder(repositoryRoot, selected);
  const files: MigrationFile[] = [];
  const total = new Map<string, MigrationReplacement>();
  const unresolvable: UnresolvableReference[] = [];
  const taskCache = new Map<string, TaskContext | undefined>();
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    const migrated = await migrateText(repositoryRoot, repositoryPath(repositoryRoot, path), source, await taskContextFor(repositoryRoot, path), taskCache);
    const filePath = repositoryPath(repositoryRoot, path);
    files.push({ path: filePath, changed: migrated.text !== source, replacements: migrated.replacements });
    for (const replacement of migrated.replacements) {
      const key = `${replacement.from}\u0000${replacement.to}`;
      const previous = total.get(key);
      total.set(key, { ...replacement, count: (previous?.count ?? 0) + replacement.count });
    }
    unresolvable.push(...migrated.unresolvable);
    if (migrated.text !== source) await writeFile(path, migrated.text, 'utf8');
  }
  const replacements = [...total.values()];
  return {
    schema: TASK_LOCAL_MIGRATION_SCHEMA,
    path: repositoryPath(repositoryRoot, selected),
    changedFiles: files.filter((file) => file.changed).map((file) => file.path),
    files,
    replacements,
    unresolvable,
    findings: [],
  };
}

export async function migrateTaskLocalReferencesForWorkItem(repositoryRoot: string, workItemId: string): Promise<TaskLocalMigrationReport> {
  if (!WORK_ITEM_ID_PATTERN.test(workItemId)) throw new DiscoveryError(`Invalid work-item ID: ${workItemId}`);
  const requestedPath = `.docs/work-items/${workItemId}`;
  return migrateTaskLocalReferences(repositoryRoot, requestedPath);
}

export async function migrateWorkItemReferences(repositoryRoot: string, workItemId: string): Promise<WorkItemMigrationReport> {
  if (!WORK_ITEM_ID_PATTERN.test(workItemId)) throw new DiscoveryError(`Invalid work-item ID: ${workItemId}`);
  const report = await migrateTaskLocalReferences(repositoryRoot, `.docs/work-items/${workItemId}`);
  return {
    ...report,
    schema: WORK_ITEM_MIGRATION_SCHEMA,
    workItemId,
  };
}