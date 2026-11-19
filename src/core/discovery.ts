import { execFile } from 'node:child_process';
import { readFile, readdir, stat as statFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';

const WORK_ITEM_ID = /^[A-Z]{1,10}-[0-9]+$/u;
const TASK_UID = /^[A-Z]{1,10}-[0-9]+-[0-9]{8}$/u;
export const SUPPORTED_WORK_ITEM_OBJECT_EXTENSIONS = ['.json', '.yaml', '.yml', '.ts', '.md'] as const;
const execFileAsync = promisify(execFile);

export interface WorkItemSummary {
  readonly workItemId: string;
  readonly status: string;
  readonly title: string;
  readonly path: string;
}

export interface TaskSummary {
  readonly taskUid: string;
  readonly taskType: string;
  readonly processingStatus: string;
  readonly taskStatus: string;
  readonly path: string;
}

export interface DiscoveryReport<T> {
  readonly items: readonly T[];
  readonly findings: readonly string[];
}

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

export interface FileStatReport {
  readonly schema: 'sdlc/stat/v1';
  readonly repositoryPath: string;
  readonly fullPath: string;
  readonly tracked: true;
  readonly objectKind: 'file';
  readonly ref: string | null;
  readonly objectType: 'file' | 'work-item' | 'task';
  readonly objectSchemaPath: string | null;
  readonly stat: {
    readonly size: number;
    readonly mtime: string;
    readonly mode: number;
  };
}

interface StatObjectMetadata {
  readonly ref: string | null;
  readonly objectType: FileStatReport['objectType'];
  readonly objectSchemaPath: string | null;
}

function repositoryRelative(repositoryRoot: string, path: string): string {
  return relative(repositoryRoot, path).split(sep).join('/');
}

function containedPath(repositoryRoot: string, path: string): string {
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, path);
  const remainder = relative(root, candidate);
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || resolve(candidate) !== candidate && !candidate.startsWith(`${root}${sep}`)) {
    throw new DiscoveryError(`Path escapes the repository: ${path}`);
  }
  return candidate;
}

function recordObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DiscoveryError(`Invalid JSON object: ${path}`);
  return value as Record<string, unknown>;
}

export async function statTrackedPath(repositoryRoot: string, requestedPath: string): Promise<FileStatReport> {
  if (!requestedPath || requestedPath.startsWith('-')) throw new DiscoveryError('--path requires a relative file path.');
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, requestedPath);
  const repositoryPath = relative(root, candidate).split(sep).join('/');
  if (!repositoryPath || repositoryPath === '..' || repositoryPath.startsWith('../') || candidate.startsWith(`${root}${sep}`) === false) {
    throw new DiscoveryError(`Path must remain within the repository: ${requestedPath}`);
  }
  try {
    await execFileAsync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', repositoryPath], { encoding: 'utf8' });
  } catch {
    throw new DiscoveryError(`Path is not tracked by sdlc: ${requestedPath}`);
  }
  const metadata = await statFile(candidate);
  if (!metadata.isFile()) throw new DiscoveryError(`Path is not a file: ${requestedPath}`);
  const object = await statObjectMetadata(repositoryRoot, repositoryPath);
  return {
    schema: 'sdlc/stat/v1',
    repositoryPath,
    fullPath: candidate,
    tracked: true,
    objectKind: 'file',
    ...object,
    stat: {
      size: metadata.size,
      mtime: metadata.mtime.toISOString(),
      mode: metadata.mode,
    },
  };
}

async function statObjectMetadata(repositoryRoot: string, repositoryPath: string): Promise<StatObjectMetadata> {
  const generic: StatObjectMetadata = {
    ref: null,
    objectType: 'file',
    objectSchemaPath: null,
  };
  const workItemMatch = /^\.docs\/work-items\/([A-Z]{1,10}-[0-9]+)\/work-item\.json$/u.exec(repositoryPath);
  if (workItemMatch) {
    const workItemId = workItemMatch[1]!;
    return {
      ref: `${workItemId}#work-item.json#work-item/${workItemId}`,
      objectType: 'work-item',
      objectSchemaPath: 'schemas/work-item/v2/work-item.schema.json',
    };
  }
  const taskMatch = /^\.docs\/work-items\/([A-Z]{1,10}-[0-9]+)\/steps\/([^/]+\.ya?ml)$/u.exec(repositoryPath);
  if (!taskMatch) return generic;
  try {
    const taskPath = join(repositoryRoot, repositoryPath);
    const document = YAML.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    const taskUid = typeof document.taskUid === 'string' ? document.taskUid : '';
    const taskType = typeof document.taskType === 'string' ? document.taskType : '';
    if (!TASK_UID.test(taskUid) || !taskType || !document.task || typeof document.task !== 'object') return generic;
    const workItemId = taskMatch[1]!;
    const taskPathFromWorkItem = `steps/${taskMatch[2]!}`;
    return {
      ref: `${workItemId}#${taskPathFromWorkItem}#task/${taskUid}`,
      objectType: 'task',
      objectSchemaPath: 'schemas/sdlc-task-envelope/v1/sdlc-task-envelope.schema.json',
    };
  } catch {
    return generic;
  }
}

async function workItemsDirectory(repositoryRoot: string): Promise<string> {
  return containedPath(repositoryRoot, '.docs/work-items');
}

export async function discoverWorkItems(repositoryRoot: string): Promise<DiscoveryReport<WorkItemSummary>> {
  const directory = await workItemsDirectory(repositoryRoot);
  if (!existsSync(directory)) return { items: [], findings: [] };

  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  const items: WorkItemSummary[] = [];
  const findings: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name, 'work-item.json');
    try {
      const record = recordObject(JSON.parse(await readFile(path, 'utf8')), path);
      const workItemId = typeof record.workItemId === 'string' ? record.workItemId : '';
      const status = typeof record.status === 'string' ? record.status : '';
      const title = typeof record.title === 'string' ? record.title : '';
      if (!WORK_ITEM_ID.test(workItemId) || workItemId !== entry.name || !status || !title) {
        throw new DiscoveryError(`Invalid work-item record: ${path}`);
      }
      items.push({ workItemId, status, title, path: repositoryRelative(repositoryRoot, path) });
    } catch (error) {
      findings.push(error instanceof Error ? error.message : `Unable to read work-item record: ${path}`);
    }
  }

  return { items, findings };
}

export async function enumerateWorkItemObjects(directory: string, root = directory): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await enumerateWorkItemObjects(path, root));
    else if (entry.isFile() && SUPPORTED_WORK_ITEM_OBJECT_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) files.push(path);
  }
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right), undefined, { numeric: true }));
}

export async function discoverTasks(repositoryRoot: string, workItemId: string): Promise<DiscoveryReport<TaskSummary>> {
  if (!WORK_ITEM_ID.test(workItemId)) throw new DiscoveryError(`Invalid work-item ID: ${workItemId}`);
  const workItemPath = containedPath(repositoryRoot, `.docs/work-items/${workItemId}/work-item.json`);
  if (!existsSync(workItemPath)) throw new DiscoveryError(`Work item not found: ${workItemId}`);
  const workItem = recordObject(JSON.parse(await readFile(workItemPath, 'utf8')), workItemPath);
  const stepsPath = typeof workItem.stepsPath === 'string' ? workItem.stepsPath : '';
  if (!stepsPath.endsWith('/')) throw new DiscoveryError(`Work item has no valid stepsPath: ${workItemId}`);
  const directory = containedPath(repositoryRoot, stepsPath);
  const files = await enumerateWorkItemObjects(directory);
  const items: TaskSummary[] = [];
  const findings: string[] = [];

  for (const path of files) {
    try {
      const documents = YAML.parseAllDocuments(await readFile(path, 'utf8'), { version: '1.2', uniqueKeys: true });
      if (documents.length !== 1 || documents[0]!.errors.length > 0) throw new DiscoveryError(`Invalid YAML task document: ${path}`);
      const envelope = recordObject(documents[0]!.toJSON(), path);
      const task = recordObject(envelope.task, path);
      const taskUid = typeof envelope.taskUid === 'string' ? envelope.taskUid : '';
      const taskType = typeof envelope.taskType === 'string' ? envelope.taskType : '';
      const processingStatus = typeof envelope.processingStatus === 'string' ? envelope.processingStatus : '';
      const taskStatus = typeof task.status === 'string' ? task.status : '';
      if (!TASK_UID.test(taskUid) || !taskType || !processingStatus || !taskStatus) throw new DiscoveryError(`Invalid task envelope: ${path}`);
      items.push({ taskUid, taskType, processingStatus, taskStatus, path: repositoryRelative(repositoryRoot, path) });
    } catch (error) {
      findings.push(error instanceof Error ? error.message : `Unable to read task document: ${path}`);
    }
  }

  return { items, findings };
}

export async function discoverNextTask(repositoryRoot: string, workItemId: string): Promise<TaskSummary | null> {
  const report = await discoverTasks(repositoryRoot, workItemId);
  return report.items.find((task) => task.processingStatus === 'unprocessed') ?? null;
}