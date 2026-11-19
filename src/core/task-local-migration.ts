import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { DiscoveryError } from './discovery.js';

export const TASK_LOCAL_MIGRATION_SCHEMA = 'https://schemas.handschuh.dev/sdlc/ref/task-local-migration/v1';

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

export interface TaskLocalMigrationReport {
  readonly schema: typeof TASK_LOCAL_MIGRATION_SCHEMA;
  readonly path: string;
  readonly changedFiles: readonly string[];
  readonly files: readonly MigrationFile[];
  readonly replacements: readonly MigrationReplacement[];
  readonly findings: readonly string[];
}

const WORK_ITEM_ID = '[A-Z]{1,10}-[0-9]+';
const WORK_ITEM_ID_PATTERN = /^[A-Z]{1,10}-[0-9]+$/u;
const ORDER_KEY = '[0-9]{2,8}';
const ID = '[A-Za-z][A-Za-z0-9._:-]*';
const TASK_QUALIFIED = new RegExp(`^(${WORK_ITEM_ID})\\|(${ORDER_KEY})#([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/(${ID})$`, 'u');
const HYPHEN_QUALIFIED = new RegExp(`^(${WORK_ITEM_ID})-([0-9]{8})#([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/(${ID})$`, 'u');
const TASK_ID = new RegExp(`^(${WORK_ITEM_ID})\\|(${ORDER_KEY})$`, 'u');
const TASK_LOCAL = new RegExp(`^#([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/(${ID})$`, 'u');
const CANONICAL = /^#(?:intent|result)\/.+$/u;

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
  const entries = (await readdir(selected, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(selected, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile() && ['.json', '.yaml', '.yml', '.ts', '.md'].includes(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files;
}

function taskContextFor(path: string): { readonly workItemId: string; readonly taskUid: string } | undefined {
  const match = /(?:^|[/\\])([A-Z]{1,10}-[0-9]+)-([0-9]{8})[^/\\]*\.ya?ml$/u.exec(path);
  if (!match) return undefined;
  return { workItemId: match[1]!, taskUid: `${match[1]!}-${match[2]!}` };
}

function selector(kind: string, id: string): string | undefined {
  const intent = intentCollections[kind];
  if (intent) return `#intent/${intent}/${id}`;
  const result = resultCollections[kind];
  if (result) return `#result/${result}/${id}`;
  return undefined;
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

function migrateText(source: string, task: { readonly workItemId: string; readonly taskUid: string } | undefined): { text: string; replacements: MigrationReplacement[] } {
  const replacements = new Map<string, MigrationReplacement>();
  const pattern = new RegExp(`${WORK_ITEM_ID}(?:\\||-)[0-9]{2,8}#[a-z][a-z0-9]*(?:-[a-z0-9]+)*/${ID}|${WORK_ITEM_ID}\\|${ORDER_KEY}|#[a-z][a-z0-9]*(?:-[a-z0-9]+)*/${ID}`, 'gu');
  const text = source.replace(pattern, (value) => {
    const migrated = migrateReference(value, task);
    if (!migrated || (!task && value.startsWith('#'))) return value;
    const previous = replacements.get(`${migrated.from}\u0000${migrated.to}`);
    replacements.set(`${migrated.from}\u0000${migrated.to}`, { from: migrated.from, to: migrated.to, count: (previous?.count ?? 0) + 1 });
    return migrated.value;
  });
  return { text, replacements: [...replacements.values()] };
}

export async function migrateTaskLocalReferences(repositoryRoot: string, requestedPath: string): Promise<TaskLocalMigrationReport> {
  const selected = containedPath(repositoryRoot, requestedPath);
  const paths = await filesUnder(repositoryRoot, selected);
  const files: MigrationFile[] = [];
  const total = new Map<string, MigrationReplacement>();
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    const migrated = migrateText(source, taskContextFor(path));
    const filePath = repositoryPath(repositoryRoot, path);
    files.push({ path: filePath, changed: migrated.text !== source, replacements: migrated.replacements });
    for (const replacement of migrated.replacements) {
      const key = `${replacement.from}\u0000${replacement.to}`;
      const previous = total.get(key);
      total.set(key, { ...replacement, count: (previous?.count ?? 0) + replacement.count });
    }
    if (migrated.text !== source) await writeFile(path, migrated.text, 'utf8');
  }
  const replacements = [...total.values()];
  return {
    schema: TASK_LOCAL_MIGRATION_SCHEMA,
    path: repositoryPath(repositoryRoot, selected),
    changedFiles: files.filter((file) => file.changed).map((file) => file.path),
    files,
    replacements,
    findings: [],
  };
}

export async function migrateTaskLocalReferencesForWorkItem(repositoryRoot: string, workItemId: string): Promise<TaskLocalMigrationReport> {
  if (!WORK_ITEM_ID_PATTERN.test(workItemId)) throw new DiscoveryError(`Invalid work-item ID: ${workItemId}`);
  const requestedPath = `.docs/work-items/${workItemId}`;
  return migrateTaskLocalReferences(repositoryRoot, requestedPath);
}