import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { discoverTasks, DiscoveryError, type TaskSummary } from './discovery.js';
import { validateReference } from './reference.js';
import { resolveReference, type TaskContext } from './reference-resolution.js';

export const WORK_ITEM_VALIDATION_SCHEMA = 'https://schemas.handschuh.dev/sdlc/work-item-validation/v1';

export interface WorkItemObjectValidation {
  readonly path: string;
  readonly schema: 'sdlc/stat/v1';
  readonly repositoryPath: string;
  readonly fullPath: string;
  readonly tracked: boolean;
  readonly objectKind: 'file';
  readonly ref: string | null;
  readonly objectType: 'work-item' | 'task';
  readonly objectSchemaPath: string | null;
  readonly taskUid?: string;
  readonly valid: boolean;
  readonly findings: readonly string[];
  readonly schemaFindings?: readonly string[];
  readonly referenceFindings?: readonly ReferenceFinding[];
  readonly remediation?: readonly string[];
}

export interface ReferenceFinding {
  readonly path: string;
  readonly value: string;
  readonly category: 'syntax' | 'target' | 'context' | 'parse';
  readonly syntaxValid: boolean;
  readonly resolved: boolean;
  readonly reason: string;
  readonly remediation: string;
}

export interface WorkItemValidationReport {
  readonly schema: typeof WORK_ITEM_VALIDATION_SCHEMA;
  readonly workItemId: string;
  readonly valid: boolean;
  readonly objectCount: number;
  readonly validObjectCount: number;
  readonly invalidObjectCount: number;
  readonly objects: readonly WorkItemObjectValidation[];
  readonly findings: readonly string[];
  readonly scope?: 'work-item' | 'task';
  readonly taskUid?: string;
  readonly referenceCount?: number;
  readonly validReferenceCount?: number;
  readonly invalidReferenceCount?: number;
  readonly unresolvedReferenceCount?: number;
  readonly references?: readonly ReferenceFinding[];
}

const execFileAsync = promisify(execFile);
const WORK_ITEM_ID = /^[A-Z]{1,10}-[0-9]+$/u;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function validatorExecutable(): string {
  const configured = process.env.SDLC_SCHEMA_VALIDATE;
  if (configured) return configured;
  const local = '/home/michael/.cline/skills/sdlc/node_modules/.bin/schema-validate';
  return existsSync(local) ? local : 'schema-validate';
}

function taskSchemaPath(schemaUri: string): string {
  const match = /^https:\/\/schemas\.handschuh\.dev\/sdlc\/(task-[a-z0-9-]+)\/v([1-9][0-9]*)$/u.exec(schemaUri);
  if (!match) throw new DiscoveryError(`Unsupported task schema URI: ${schemaUri}`);
  const type = match[1]!;
  return `sdlc-${type}/v${match[2]}/sdlc-${type}.schema.json`;
}

async function validateDocument(schemaRoot: string, schemaPath: string, documentPath: string, cwd: string): Promise<string[]> {
  try {
    await execFileAsync(validatorExecutable(), ['--root', schemaRoot, '--schema', join(schemaRoot, schemaPath), '--document', documentPath], { cwd, encoding: 'utf8' });
    return [];
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    const message = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    return [message || `Schema validation failed: ${schemaPath}`];
  }
}

async function writeJson(directory: string, name: string, value: unknown): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

function looksLikeReference(value: string): boolean {
  return value.startsWith('#') || value.startsWith('sdlc://') || /^[A-Z]{1,10}-[0-9]+(?:-[0-9]{8})?(?:#|\|)/u.test(value);
}

async function discoverReferenceFindings(repositoryRoot: string, value: unknown, path: string, taskContext?: TaskContext): Promise<ReferenceFinding[]> {
  const findings: ReferenceFinding[] = [];
  const visit = async (current: unknown, currentPath: string): Promise<void> => {
    if (typeof current === 'string') {
      const field = currentPath.split('.').at(-1) ?? '';
      const referenceField = field === 'ref' || field === 'procedureRef' || field === 'taskRef' || field.endsWith('Refs') || field === 'reference' || field === 'referenceRef' || field === 'policyRef';
      if (!referenceField && !looksLikeReference(current)) return;
      const schemaRoot = existsSync(join(repositoryRoot, 'schemas')) ? repositoryRoot : packageRoot;
      const syntax = await validateReference(schemaRoot, current);
      if (!syntax.valid && !looksLikeReference(current)) return;
      if (!syntax.valid) {
        findings.push({
          path: currentPath,
          value: current,
          category: 'syntax',
          syntaxValid: false,
          resolved: false,
          reason: syntax.findings.join(' '),
          remediation: 'Replace this value with a reference accepted by a registered reference schema, or remove the reference marker if it is ordinary text.',
        });
        return;
      }
      const resolved = await resolveReference(repositoryRoot, schemaRoot, current, 1, taskContext);
      if (!resolved.valid) {
        const context = taskContext ? ` in ${taskContext.taskUid}` : '';
        findings.push({
          path: currentPath,
          value: current,
          category: current.startsWith('#') && !taskContext ? 'context' : 'target',
          syntaxValid: true,
          resolved: false,
          reason: resolved.findings.join(' '),
          remediation: `Update the reference to an existing resolvable target${context}, or provide the required task context for task-local references.`,
        });
      } else {
        findings.push({
          path: currentPath,
          value: current,
          category: 'target',
          syntaxValid: true,
          resolved: true,
          reason: 'Reference syntax and local target resolved successfully.',
          remediation: 'No remediation required.',
        });
      }
      return;
    }
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) await visit(current[index], `${currentPath}[${index}]`);
      return;
    }
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) await visit(child, `${currentPath}.${key}`);
    }
  };
  await visit(value, path);
  return findings;
}

function remediationForSchema(schemaPath: string, objectPath: string): string {
  return `Fix the object at ${objectPath} so it conforms to ${schemaPath}, then rerun validation.`;
}

async function trackedPath(repositoryRoot: string, repositoryPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repositoryRoot, 'ls-files', '--error-unmatch', '--', repositoryPath], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

interface StatIdentity {
  readonly schema: 'sdlc/stat/v1';
  readonly repositoryPath: string;
  readonly fullPath: string;
  readonly tracked: boolean;
  readonly objectKind: 'file';
  readonly ref: string | null;
  readonly objectType: WorkItemObjectValidation['objectType'];
  readonly objectSchemaPath: string;
}

async function statIdentity(repositoryRoot: string, repositoryPath: string, workItemId: string, objectType: WorkItemObjectValidation['objectType'], ref: string): Promise<StatIdentity> {
  return {
    schema: 'sdlc/stat/v1',
    repositoryPath,
    fullPath: resolve(repositoryRoot, repositoryPath),
    tracked: await trackedPath(repositoryRoot, repositoryPath),
    objectKind: 'file',
    ref,
    objectType,
    objectSchemaPath: objectType === 'work-item'
      ? 'schemas/work-item/v2/work-item.schema.json'
      : 'schemas/sdlc-task-envelope/v1/sdlc-task-envelope.schema.json',
  };
}

async function validateTask(repositoryRoot: string, temporaryDirectory: string, workItemId: string, task: TaskSummary): Promise<WorkItemObjectValidation> {
  const path = resolve(repositoryRoot, task.path);
  const relativeTaskSchema = taskSchemaPath((YAML.parse(await readFile(path, 'utf8')) as Record<string, unknown>).task && typeof (YAML.parse(await readFile(path, 'utf8')) as Record<string, any>).task.taskSchema === 'string'
    ? (YAML.parse(await readFile(path, 'utf8')) as Record<string, any>).task.taskSchema
    : '');
  const document = YAML.parse(await readFile(path, 'utf8')) as Record<string, any>;
  const envelopePath = await writeJson(temporaryDirectory, `${task.taskUid}.envelope.json`, document);
  const payloadPath = await writeJson(temporaryDirectory, `${task.taskUid}.payload.json`, { intent: document.task?.intent, result: document.task?.result });
  const findings = [
    ...await validateDocument(join(repositoryRoot, 'schemas'), 'sdlc-task-envelope/v1/sdlc-task-envelope.schema.json', envelopePath, repositoryRoot),
    ...await validateDocument(join(repositoryRoot, 'schemas'), relativeTaskSchema, payloadPath, repositoryRoot),
  ];
  const taskContext: TaskContext = {
    taskUid: task.taskUid,
    document: { fullPath: path, repositoryPath: task.path, format: 'yaml', value: document },
  };
  const referenceFindings = await discoverReferenceFindings(repositoryRoot, document, '$', taskContext);
  const referenceErrors = referenceFindings.filter((finding) => !finding.resolved);
  const schemaFindings = findings.map((finding) => `${finding}\nRemediation: ${remediationForSchema(relativeTaskSchema, task.path)}`);
  const workItemPrefix = `.docs/work-items/${workItemId}/`;
  const taskPath = task.path.startsWith(workItemPrefix) ? task.path.slice(workItemPrefix.length) : task.path;
  const identity = await statIdentity(repositoryRoot, task.path, workItemId, 'task', `${workItemId}#${taskPath}#task/${task.taskUid}`);
  return {
    path: task.path,
    ...identity,
    objectType: 'task',
    taskUid: task.taskUid,
    valid: schemaFindings.length === 0 && referenceErrors.length === 0,
    findings: [...schemaFindings, ...referenceErrors.map((finding) => `${finding.path}: ${finding.reason}\nRemediation: ${finding.remediation}`)],
    schemaFindings,
    referenceFindings,
    remediation: [...schemaFindings.map((finding) => remediationForSchema(relativeTaskSchema, task.path)), ...referenceErrors.map((finding) => finding.remediation)],
  };
}

export async function validateWorkItem(repositoryRoot: string, workItemId: string, selectedTaskUid?: string): Promise<WorkItemValidationReport> {
  if (!WORK_ITEM_ID.test(workItemId)) throw new DiscoveryError(`Invalid work-item ID: ${workItemId}`);
  const workItemPath = resolve(repositoryRoot, `.docs/work-items/${workItemId}/work-item.json`);
  const temporaryDirectory = await mkdtemp(join('/tmp', 'sdlc-work-item-validation-'));
  try {
    const workItemObject = JSON.parse(await readFile(workItemPath, 'utf8'));
    const workItemDocument = await writeJson(temporaryDirectory, 'work-item.json', workItemObject);
    const workItemFindings = await validateDocument(join(repositoryRoot, 'schemas'), 'work-item/v2/work-item.schema.json', workItemDocument, repositoryRoot);
    const workItemReferenceFindings = await discoverReferenceFindings(repositoryRoot, workItemObject, '$');
    const workItemRepositoryPath = `.docs/work-items/${workItemId}/work-item.json`;
    const workItemIdentity = await statIdentity(repositoryRoot, workItemRepositoryPath, workItemId, 'work-item', `${workItemId}#work-item.json#work-item/${workItemId}`);
    const objects: WorkItemObjectValidation[] = [];
    if (!selectedTaskUid) objects.push({
      path: `.docs/work-items/${workItemId}/work-item.json`,
      ...workItemIdentity,
      objectType: 'work-item',
      valid: workItemFindings.length === 0 && workItemReferenceFindings.every((finding) => finding.resolved),
      findings: [...workItemFindings.map((finding) => `${finding}\nRemediation: ${remediationForSchema('schemas/work-item/v2/work-item.schema.json', workItemRepositoryPath)}`), ...workItemReferenceFindings.filter((finding) => !finding.resolved).map((finding) => `${finding.path}: ${finding.reason}\nRemediation: ${finding.remediation}`)],
      schemaFindings: workItemFindings,
      referenceFindings: workItemReferenceFindings,
      remediation: [
        ...workItemFindings.map(() => remediationForSchema('schemas/work-item/v2/work-item.schema.json', workItemRepositoryPath)),
        ...workItemReferenceFindings.filter((finding) => !finding.resolved).map((finding) => finding.remediation),
      ],
    });
    const taskReport = await discoverTasks(repositoryRoot, workItemId);
    for (const finding of taskReport.findings) {
      objects.push({
        path: finding,
        schema: 'sdlc/stat/v1',
        repositoryPath: finding,
        fullPath: resolve(repositoryRoot, finding),
        tracked: false,
        objectKind: 'file',
        ref: null,
        objectType: 'task',
        objectSchemaPath: null,
        valid: false,
        findings: [finding],
      });
    }
    for (const task of taskReport.items) {
      if (!selectedTaskUid || task.taskUid === selectedTaskUid) objects.push(await validateTask(repositoryRoot, temporaryDirectory, workItemId, task));
    }
    const validObjectCount = objects.filter((object) => object.valid).length;
    const findings = objects.flatMap((object) => object.findings);
    const references = objects.flatMap((object) => object.referenceFindings ?? []);
    const referenceErrors = references.filter((reference) => !reference.resolved);
    return {
      schema: WORK_ITEM_VALIDATION_SCHEMA,
      workItemId,
      valid: findings.length === 0 && objects.length > 0,
      objectCount: objects.length,
      validObjectCount,
      invalidObjectCount: objects.length - validObjectCount,
      objects,
      findings,
      scope: selectedTaskUid ? 'task' : 'work-item',
      taskUid: selectedTaskUid,
      referenceCount: references.length,
      validReferenceCount: references.filter((reference) => reference.resolved).length,
      invalidReferenceCount: references.filter((reference) => !reference.syntaxValid).length,
      unresolvedReferenceCount: referenceErrors.length,
      references,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}