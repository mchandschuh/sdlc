import { readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { discoverTasks, DiscoveryError } from './discovery.js';

export const COLLECTION_LIST_SCHEMA = 'https://schemas.handschuh.dev/sdlc/collection-list/v1' as const;

export interface CollectionDefinition {
  readonly documentType: string;
  readonly name: string;
  readonly index: {
    readonly collectionPath: string;
    readonly parent?: {
      readonly argument: string;
      readonly identifierPath: string;
    };
    readonly childPath?: string;
  };
  readonly display: {
    readonly identifier: string;
    readonly title?: string;
    readonly text: string;
  };
  readonly identity: {
    readonly mode: 'field' | 'reference' | 'index';
    readonly referenceKind?: string;
  };
}

export interface CollectionSource {
  readonly fullPath: string;
  readonly repositoryPath: string;
  readonly format: 'json' | 'yaml';
}

export interface CollectionListReport {
  readonly schema: typeof COLLECTION_LIST_SCHEMA;
  readonly valid: boolean;
  readonly documentType: string;
  readonly collection: string;
  readonly indexExpression: string;
  readonly source: CollectionSource | null;
  readonly data: readonly unknown[];
  readonly findings: readonly string[];
}

interface ParsedDocument {
  readonly fullPath: string;
  readonly repositoryPath: string;
  readonly format: 'json' | 'yaml';
  readonly value: unknown;
  readonly documentType: string;
}

const WORK_ITEM_ID = /^[A-Z]{1,10}-[0-9]+$/u;
const TASK_UID = /^[A-Z]{1,10}-[0-9]+-[0-9]{8}$/u;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function repositoryPath(repositoryRoot: string, fullPath: string): string {
  return relative(repositoryRoot, fullPath).split(sep).join('/');
}

function containedPath(repositoryRoot: string, requestedPath: string): string {
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, requestedPath);
  const remainder = relative(root, candidate);
  if (!remainder || remainder === '..' || remainder.startsWith(`..${sep}`) || !candidate.startsWith(`${root}${sep}`)) {
    throw new DiscoveryError(`Collection path escapes the repository: ${requestedPath}`);
  }
  return candidate;
}

function decodePointerSegment(segment: string): string {
  let decoded = '';
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character !== '~') {
      decoded += character;
      continue;
    }
    const escape = segment[index + 1];
    if (escape !== '0' && escape !== '1') throw new DiscoveryError(`Invalid collection index escape in /${segment}.`);
    decoded += escape === '0' ? '~' : '/';
    index += 1;
  }
  return decoded;
}

function pointerSegments(expression: string): readonly string[] {
  if (!expression.startsWith('/')) throw new DiscoveryError(`Collection index must be an absolute property path: ${expression}`);
  return expression.slice(1).split('/').map(decodePointerSegment);
}

export function readCollectionPath(value: unknown, expression: string): unknown {
  let current = value;
  for (const segment of pointerSegments(expression)) {
    const object = objectValue(current);
    if (!object || !(segment in object)) return undefined;
    current = object[segment];
  }
  return current;
}

function selectorValue(value: unknown, expression: string): unknown {
  if (expression === '') return value;
  return readCollectionPath(value, expression);
}

function stringValue(value: unknown, expression: string, label: string): string {
  const selected = selectorValue(value, expression);
  if (typeof selected !== 'string' || selected.length === 0) throw new DiscoveryError(`Collection ${label} selector ${expression || '<value>'} did not produce a non-empty string.`);
  return selected;
}

function report(
  documentType: string,
  collection: string,
  indexExpression: string,
  source: CollectionSource | null,
  data: readonly unknown[],
  findings: readonly string[],
): CollectionListReport {
  return {
    schema: COLLECTION_LIST_SCHEMA,
    valid: findings.length === 0,
    documentType,
    collection,
    indexExpression,
    source,
    data,
    findings,
  };
}

async function parseDocument(repositoryRoot: string, requestedPath: string, documentType: string): Promise<ParsedDocument> {
  const fullPath = containedPath(repositoryRoot, requestedPath);
  const source = await readFile(fullPath, 'utf8');
  const extension = extname(fullPath).toLowerCase();
  if (extension === '.json') {
    return { fullPath, repositoryPath: repositoryPath(repositoryRoot, fullPath), format: 'json', value: JSON.parse(source), documentType };
  }
  if (extension === '.yaml' || extension === '.yml') {
    return { fullPath, repositoryPath: repositoryPath(repositoryRoot, fullPath), format: 'yaml', value: YAML.parse(source), documentType };
  }
  throw new DiscoveryError(`Unsupported collection document format: ${requestedPath}`);
}

function sourceOf(document: ParsedDocument): CollectionSource {
  return { fullPath: document.fullPath, repositoryPath: document.repositoryPath, format: document.format };
}

function definitionKey(documentType: string, collection: string): string {
  return `${documentType}\0${collection}`;
}

const definitions: readonly CollectionDefinition[] = [
  {
    documentType: 'https://schemas.handschuh.dev/sdlc/work-item/v3',
    name: 'requirement',
    index: { collectionPath: '/requirements/items' },
    display: { identifier: '/id', title: '/name', text: '/description' },
    identity: { mode: 'field' },
  },
  {
    documentType: 'https://schemas.handschuh.dev/sdlc/work-item/v3',
    name: 'acceptance-criterion',
    index: { collectionPath: '/requirements/items', parent: { argument: 'requirement', identifierPath: '/id' }, childPath: '/acceptanceCriteria' },
    display: { identifier: '/id', text: '/description' },
    identity: { mode: 'field' },
  },
  {
    documentType: 'https://schemas.handschuh.dev/sdlc/work-item/v3',
    name: 'scope',
    index: { collectionPath: '/scope' },
    display: { identifier: '/name', text: '/description' },
    identity: { mode: 'field' },
  },
  {
    documentType: 'https://schemas.handschuh.dev/sdlc/work-item/v3',
    name: 'non-goal',
    index: { collectionPath: '/nonGoals' },
    display: { identifier: '/name', text: '/description' },
    identity: { mode: 'field' },
  },
  {
    documentType: 'https://schemas.handschuh.dev/sdlc/task-envelope/v1',
    name: 'dependency',
    index: { collectionPath: '/dependsOn' },
    display: { identifier: '', text: '' },
    identity: { mode: 'reference', referenceKind: 'task' },
  },
  {
    documentType: 'https://schemas.handschuh.dev/sdlc/task-envelope/v1',
    name: 'validation-procedure',
    index: { collectionPath: '/governance/validationProcedures' },
    display: { identifier: '/id', title: '/name', text: '/expected/result' },
    identity: { mode: 'field' },
  },
  {
    documentType: 'https://schemas.handschuh.dev/sdlc/task-decomposition/v1',
    name: 'child',
    index: { collectionPath: '/task/result/tasks' },
    display: { identifier: '/ref', text: '/taskType' },
    identity: { mode: 'field' },
  },
  {
    documentType: 'https://schemas.handschuh.dev/sdlc/task-decomposition/v1',
    name: 'subrange',
    index: { collectionPath: '/task/intent/range/subranges' },
    display: { identifier: '/name', text: '/description' },
    identity: { mode: 'field' },
  },
  {
    documentType: 'https://schemas.handschuh.dev/sdlc/task-research/v1',
    name: 'question',
    index: { collectionPath: '/task/intent/questions' },
    display: { identifier: '/id', text: '/question' },
    identity: { mode: 'field' },
  },
  {
    documentType: 'https://schemas.handschuh.dev/sdlc/task-research/v1',
    name: 'source',
    index: { collectionPath: '/task/intent/sources' },
    display: { identifier: '/id', title: '/sourceType', text: '/purpose' },
    identity: { mode: 'field' },
  },
];

const registry = new Map(definitions.map((definition) => [definitionKey(definition.documentType, definition.name), definition]));

export function resolveCollectionDefinition(documentType: string, collection: string): CollectionDefinition | undefined {
  return registry.get(definitionKey(documentType, collection));
}

export function collectionDefinitions(): readonly CollectionDefinition[] {
  return definitions;
}

function selectCollection(document: unknown, definition: CollectionDefinition, arguments_: Readonly<Record<string, string>>): readonly unknown[] {
  let selected = readCollectionPath(document, definition.index.collectionPath);
  if (selected === undefined) throw new DiscoveryError(`Collection path not found: ${definition.index.collectionPath}`);
  if (definition.index.parent) {
    if (definition.index.childPath === undefined) throw new DiscoveryError(`Collection ${definition.name} has no child path.`);
    const parentId = arguments_[definition.index.parent.argument];
    if (!parentId) throw new DiscoveryError(`Collection ${definition.name} requires --${definition.index.parent.argument} <identifier>.`);
    if (!Array.isArray(selected)) throw new DiscoveryError(`Collection path is not an array: ${definition.index.collectionPath}`);
    const matches = selected.filter((item) => selectorValue(item, definition.index.parent!.identifierPath) === parentId);
    if (matches.length === 0) throw new DiscoveryError(`Parent ${definition.index.parent.argument} not found: ${parentId}`);
    if (matches.length > 1) throw new DiscoveryError(`Parent ${definition.index.parent.argument} is ambiguous: ${parentId}`);
    selected = readCollectionPath(matches[0], definition.index.childPath);
  }
  if (!Array.isArray(selected)) throw new DiscoveryError(`Collection path is not an array: ${definition.index.childPath ?? definition.index.collectionPath}`);
  return selected;
}

function validateIdentity(items: readonly unknown[], definition: CollectionDefinition): void {
  if (definition.identity.mode === 'index') return;
  const identifiers = items.map((item) => definition.identity.mode === 'reference'
    ? stringValue(item, definition.display.identifier, definition.name)
    : stringValue(item, definition.display.identifier, definition.name));
  const unique = new Set(identifiers);
  if (unique.size !== identifiers.length) throw new DiscoveryError(`Collection ${definition.name} contains duplicate authoritative identifiers.`);
}

export function projectHumanItem(item: unknown, definition: CollectionDefinition): { identifier: string; title?: string; text: string } {
  const identifier = stringValue(item, definition.display.identifier, definition.name);
  const text = stringValue(item, definition.display.text, definition.name);
  const title = definition.display.title ? stringValue(item, definition.display.title, definition.name) : undefined;
  return title ? { identifier, title, text } : { identifier, text };
}

export function formatHumanItem(item: unknown, definition: CollectionDefinition): string {
  const projected = projectHumanItem(item, definition);
  return `${projected.identifier}${projected.title ? `  [${projected.title}]` : ''}  ${projected.text}`;
}

export async function listCollection(
  repositoryRoot: string,
  documentPath: string,
  documentType: string,
  collection: string,
  arguments_: Readonly<Record<string, string>> = {},
): Promise<CollectionListReport> {
  const definition = resolveCollectionDefinition(documentType, collection);
  const indexExpression = definition?.index.childPath ?? definition?.index.collectionPath ?? '';
  if (!definition) return report(documentType, collection, indexExpression, null, [], [`Unknown collection definition: ${documentType} / ${collection}`]);
  let document: ParsedDocument | undefined;
  try {
    document = await parseDocument(repositoryRoot, documentPath, documentType);
    const data = selectCollection(document.value, definition, arguments_);
    validateIdentity(data, definition);
    return report(documentType, collection, indexExpression, sourceOf(document), data, []);
  } catch (error) {
    const source = document ? sourceOf(document) : null;
    return report(documentType, collection, indexExpression, source, [], [error instanceof Error ? error.message : `Unable to list collection: ${collection}`]);
  }
}

export async function listWorkItemCollection(
  repositoryRoot: string,
  workItemId: string,
  collection: string,
  arguments_: Readonly<Record<string, string>> = {},
): Promise<CollectionListReport> {
  if (!WORK_ITEM_ID.test(workItemId)) throw new DiscoveryError(`Invalid work-item ID: ${workItemId}`);
  return listCollection(repositoryRoot, `.docs/work-items/${workItemId}/work-item.json`, 'https://schemas.handschuh.dev/sdlc/work-item/v3', collection, arguments_);
}

export async function listTaskCollection(
  repositoryRoot: string,
  taskUid: string,
  collection: string,
  arguments_: Readonly<Record<string, string>> = {},
): Promise<CollectionListReport> {
  if (!TASK_UID.test(taskUid)) throw new DiscoveryError(`Invalid task identifier: ${taskUid}`);
  const workItemId = taskUid.slice(0, taskUid.lastIndexOf('-'));
  const tasks = await discoverTasks(repositoryRoot, workItemId);
  const task = tasks.items.find((item) => item.taskUid === taskUid);
  if (!task) throw new DiscoveryError(`Task not found: ${taskUid}`);
  const source = await readFile(resolve(repositoryRoot, task.path), 'utf8');
  const envelope = YAML.parse(source) as Record<string, unknown>;
  const taskObject = objectValue(envelope.task);
  const taskSchema = typeof taskObject?.taskSchema === 'string' ? taskObject.taskSchema : '';
  const documentType = resolveCollectionDefinition(taskSchema, collection)
    ? taskSchema
    : resolveCollectionDefinition('https://schemas.handschuh.dev/sdlc/task-envelope/v1', collection)
      ? 'https://schemas.handschuh.dev/sdlc/task-envelope/v1'
      : taskSchema;
  if (!documentType) throw new DiscoveryError(`Task has no effective schema: ${taskUid}`);
  return listCollection(repositoryRoot, task.path, documentType, collection, arguments_);
}