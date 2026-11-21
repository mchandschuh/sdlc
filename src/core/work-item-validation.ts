import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { discoverTasks, DiscoveryError, type TaskSummary } from './discovery.js';
import { validateReference } from './reference.js';
import { resolveReference, type TaskContext } from './reference-resolution.js';
import { isTaskOwnedId, isTaskOwnedLocalId, taskOwnedId } from './identifier.js';
import { validateBranchContext } from './branch-validation.js';

export const WORK_ITEM_VALIDATION_SCHEMA = 'https://schemas.handschuh.dev/sdlc/work-item-validation/v2';

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
  readonly identifierFindings?: readonly IdentifierFinding[];
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

export interface IdentifierFinding {
  readonly path: string;
  readonly category: 'task-owned';
  readonly value: string;
  readonly requiredForm: string;
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
  readonly identifierFindings?: readonly IdentifierFinding[];
  readonly scope?: 'work-item' | 'task';
  readonly taskUid?: string;
  readonly referenceCount?: number;
  readonly validReferenceCount?: number;
  readonly invalidReferenceCount?: number;
  readonly unresolvedReferenceCount?: number;
  readonly references?: readonly ReferenceFinding[];
  readonly branch: {
    readonly currentBranch: string | null;
    readonly detachedHead: boolean;
    readonly mergeTargetBranch: string | null;
    readonly contextBranch: string | null;
    readonly mergeTargetLocal: boolean;
    readonly mergeTargetRemote: boolean;
    readonly remotes: readonly string[];
  };
  readonly delivery: {
    readonly primaryBranch: string | null;
    readonly tagRequired: boolean;
    readonly expectedVersion?: string | null;
    readonly findings: readonly string[];
  };
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

interface TaskLifecyclePolicy {
  readonly statusProperty: string;
  readonly resultProperty: string;
  readonly initialStatuses: readonly string[];
  readonly statuses: Readonly<Record<string, {
    readonly kind?: string;
    readonly result?: string;
    readonly resultPresence?: 'empty-only' | 'partial' | 'required';
    readonly allowedResultPaths?: readonly string[];
    readonly requiredResultPaths?: readonly string[];
    readonly forbiddenResultPaths?: readonly string[];
  }>>;
  readonly transitions: Readonly<Record<string, readonly string[]>>;
}

function readTaskLifecyclePolicy(schemaRoot: string, schemaPath: string): TaskLifecyclePolicy {
  const document = JSON.parse(readFileSync(join(schemaRoot, schemaPath), 'utf8')) as Record<string, unknown>;
  const policy = document['x-sdlc-task-lifecycle'] as TaskLifecyclePolicy | undefined;
  const statuses = document.properties && typeof document.properties === 'object'
    ? (document.properties as Record<string, { readonly enum?: readonly string[] }>).status?.enum
    : undefined;
  if (!policy || policy.statusProperty !== '/status' || policy.resultProperty !== '/result' || !policy.initialStatuses?.length || !policy.statuses || typeof policy.statuses !== 'object' || !policy.transitions || typeof policy.transitions !== 'object') {
    throw new DiscoveryError(`Invalid x-sdlc-task-lifecycle metadata: ${schemaPath}`);
  }
  const statusNames = new Set(statuses ?? []);
  const policyNames = Object.keys(policy.statuses);
  if (!statuses || statusNames.size !== policyNames.length || policyNames.some((status) => !statusNames.has(status))) {
    throw new DiscoveryError(`Lifecycle metadata statuses do not match the task schema enum: ${schemaPath}`);
  }
  if (policy.initialStatuses.some((status) => !statusNames.has(status))) {
    throw new DiscoveryError(`Lifecycle metadata initialStatuses contains an undeclared status: ${schemaPath}`);
  }
  if (Object.keys(policy.transitions).some((status) => !statusNames.has(status)) || policyNames.some((status) => !(status in policy.transitions))) {
    throw new DiscoveryError(`Lifecycle metadata transitions do not match the task schema statuses: ${schemaPath}`);
  }
  const resultPaths = new Set(lifecycleResultFields(schemaRoot, schemaPath).map((field) => `/result/${field}`));
  for (const [status, entry] of Object.entries(policy.statuses)) {
    if (!entry.kind || !entry.resultPresence || !['empty-only', 'partial', 'required'].includes(entry.resultPresence)) {
      throw new DiscoveryError(`Invalid lifecycle status policy for ${status}: ${schemaPath}`);
    }
    const allowed = entry.allowedResultPaths ?? [];
    const required = entry.requiredResultPaths ?? [];
    const forbidden = entry.forbiddenResultPaths ?? [];
    if ([...allowed, ...required, ...forbidden].some((path) => !resultPaths.has(path))) {
      throw new DiscoveryError(`Lifecycle metadata result paths do not match the task result schema: ${schemaPath} (${status})`);
    }
    if (required.some((path) => !allowed.includes(path)) || forbidden.some((path) => allowed.includes(path) || required.includes(path))) {
      throw new DiscoveryError(`Lifecycle result paths overlap or are not allowed: ${schemaPath} (${status})`);
    }
    if (policy.transitions[status]!.some((target) => !statusNames.has(target) || target === status)) {
      throw new DiscoveryError(`Lifecycle metadata contains an invalid transition from ${status}: ${schemaPath}`);
    }
  }
  return policy;
}

function pointerValue(value: unknown, pointer: string): { readonly found: boolean; readonly value?: unknown } {
  if (pointer === '') return { found: true, value };
  if (!pointer.startsWith('/')) return { found: false };
  let current: unknown = value;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!current || typeof current !== 'object' || !(segment in (current as Record<string, unknown>))) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function lifecycleResultFields(schemaRoot: string, schemaPath: string): readonly string[] {
  const document = JSON.parse(readFileSync(join(schemaRoot, schemaPath), 'utf8')) as {
    readonly properties?: Readonly<Record<string, { readonly $ref?: string; readonly properties?: Readonly<Record<string, unknown>> }>>;
    readonly $defs?: Readonly<Record<string, { readonly properties?: Readonly<Record<string, unknown>> }>>;
  };
  const result = document.properties?.result;
  const definitionName = result?.$ref?.split('/').at(-1);
  const resultDefinition = definitionName ? document.$defs?.[definitionName] : result;
  return Object.keys(resultDefinition?.properties ?? {});
}

function lifecycleResultObject(payload: Record<string, unknown>, resultProperty: string): { readonly present: boolean; readonly value: unknown } {
  const result = pointerValue(payload, resultProperty);
  return { present: result.found && result.value !== null && result.value !== undefined, value: result.value };
}

export function validateTaskLifecycleTransition(
  schemaRoot: string,
  schemaPath: string,
  previousStatus: string | null,
  payload: Record<string, unknown>,
): string[] {
  let policy: TaskLifecyclePolicy;
  try {
    policy = readTaskLifecyclePolicy(schemaRoot, schemaPath);
  } catch (error) {
    return [error instanceof Error ? error.message : `Invalid x-sdlc-task-lifecycle metadata: ${schemaPath}`];
  }
  const statusResult = pointerValue(payload, policy.statusProperty);
  if (!statusResult.found || typeof statusResult.value !== 'string') return [`Task payload is missing lifecycle status at ${policy.statusProperty}: ${schemaPath}`];
  const status = statusResult.value;
  const entry = policy.statuses[status];
  if (!entry) return [`Task lifecycle status is not declared by ${schemaPath}: ${status}`];
  const findings: string[] = [];
  if (previousStatus === null) {
    if (!policy.initialStatuses.includes(status)) findings.push(`Task lifecycle status ${status} is not an initial status in ${schemaPath}.`);
  } else if (!policy.statuses[previousStatus]) {
    findings.push(`Previous task lifecycle status is not declared by ${schemaPath}: ${previousStatus}`);
  } else if (previousStatus !== status && !policy.transitions[previousStatus]!.includes(status)) {
    findings.push(`Invalid task lifecycle transition in ${schemaPath}: ${previousStatus} -> ${status}.`);
  }
  const result = lifecycleResultObject(payload, policy.resultProperty);
  const resultObject = result.value && typeof result.value === 'object' && !Array.isArray(result.value)
    ? result.value as Record<string, unknown>
    : undefined;
  const populatedResultFields = resultObject ? Object.keys(resultObject) : [];
  const allowed = new Set(entry.allowedResultPaths ?? []);
  const required = new Set(entry.requiredResultPaths ?? []);
  const forbidden = new Set(entry.forbiddenResultPaths ?? []);
  if (entry.resultPresence === 'empty-only' && populatedResultFields.length > 0) {
    findings.push(`Lifecycle status ${status} permits only an omitted, null, or empty result in ${schemaPath}.`);
  }
  if (entry.resultPresence === 'required' && !resultObject) {
    findings.push(`Lifecycle status ${status} requires a result object in ${schemaPath}.`);
  }
  for (const field of populatedResultFields) {
    const path = `${policy.resultProperty}/${field}`;
    if (!allowed.has(path)) findings.push(`Lifecycle status ${status} does not allow ${path} in ${schemaPath}.`);
  }
  for (const forbiddenPath of forbidden) {
    if (pointerValue(payload, forbiddenPath).found) findings.push(`Lifecycle status ${status} forbids ${forbiddenPath} in ${schemaPath}.`);
  }
  for (const requiredPath of required) {
    const result = pointerValue(payload, requiredPath);
    if (!result.found || result.value === null || result.value === undefined) findings.push(`Lifecycle status ${statusResult.value} requires ${requiredPath} in ${schemaPath}.`);
  }
  return findings;
}

function lifecycleFindings(schemaRoot: string, schemaPath: string, payload: Record<string, unknown>): string[] {
  return validateTaskLifecycleTransition(schemaRoot, schemaPath, null, payload).filter((finding) => !finding.includes('is not an initial status'));
}

async function validateTaskPayload(
  schemaRoot: string,
  schemaPath: string,
  documentPath: string,
  cwd: string,
  payload: Record<string, unknown>,
  temporaryDirectory: string,
  taskUid: string,
): Promise<string[]> {
  const policy = readTaskLifecyclePolicy(join(schemaRoot, 'schemas'), schemaPath);
  const lifecycleStatus = pointerValue(payload, policy.statusProperty).value;
  const statusPolicy = typeof lifecycleStatus === 'string' ? policy.statuses[lifecycleStatus] : undefined;
  if (statusPolicy?.result !== 'optional') return validateDocument(join(schemaRoot, 'schemas'), schemaPath, documentPath, cwd);

  const relaxedRegistry = join(temporaryDirectory, `${taskUid}-schemas`);
  await cp(join(schemaRoot, 'schemas'), relaxedRegistry, { recursive: true });
  const relaxedSchemaPath = join(relaxedRegistry, schemaPath);
  const relaxedSchema = JSON.parse(await readFile(relaxedSchemaPath, 'utf8')) as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  relaxedSchema.required = (relaxedSchema.required ?? []).filter((property) => property !== 'result');
  relaxedSchema.properties = { ...(relaxedSchema.properties ?? {}), result: {} };
  await writeFile(relaxedSchemaPath, JSON.stringify(relaxedSchema, null, 2));
  return validateDocument(relaxedRegistry, schemaPath, documentPath, cwd);
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

function discoverIdentifierFindings(value: unknown, path: string, taskUid?: string): IdentifierFinding[] {
  if (!taskUid) return [];
  const findings: IdentifierFinding[] = [];
  const visit = (current: unknown, currentPath: string): void => {
    if (typeof current === 'string' && isTaskOwnedLocalId(current)) {
      findings.push({
        path: currentPath,
        category: 'task-owned',
        value: current,
        requiredForm: taskOwnedId(taskUid, current),
        reason: `Task-owned identifier ${current} is not repository-unique.`,
        remediation: `Replace ${current} with ${taskOwnedId(taskUid, current)} or run sdlc ref migrate-task-local-up for the containing task.`,
      });
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
      return;
    }
    if (current && typeof current === 'object') {
      Object.entries(current).forEach(([key, child]) => visit(child, `${currentPath}.${key}`));
    }
  };
  visit(value, path);
  return findings;
}

async function discoverReferenceFindings(repositoryRoot: string, schemaRoot: string, value: unknown, path: string, taskContext?: TaskContext): Promise<ReferenceFinding[]> {
  const findings: ReferenceFinding[] = [];
  const visit = async (current: unknown, currentPath: string): Promise<void> => {
    if (typeof current === 'string') {
      const field = currentPath.split('.').at(-1) ?? '';
      const referenceField = field === 'ref' || field === 'procedureRef' || field === 'taskRef' || field.endsWith('Refs') || field === 'reference' || field === 'referenceRef' || field === 'policyRef';
      if (!referenceField && !looksLikeReference(current)) return;
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

async function statIdentity(repositoryRoot: string, repositoryPath: string, workItemId: string, objectType: WorkItemObjectValidation['objectType'], ref: string, workItemSchemaPath = 'schemas/work-item/v2/work-item.schema.json'): Promise<StatIdentity> {
  return {
    schema: 'sdlc/stat/v1',
    repositoryPath,
    fullPath: resolve(repositoryRoot, repositoryPath),
    tracked: await trackedPath(repositoryRoot, repositoryPath),
    objectKind: 'file',
    ref,
    objectType,
    objectSchemaPath: objectType === 'work-item'
      ? workItemSchemaPath
      : 'schemas/sdlc-task-envelope/v1/sdlc-task-envelope.schema.json',
  };
}

async function validateTask(repositoryRoot: string, schemaRoot: string, temporaryDirectory: string, workItemId: string, task: TaskSummary): Promise<WorkItemObjectValidation> {
  const path = resolve(repositoryRoot, task.path);
  const relativeTaskSchema = taskSchemaPath((YAML.parse(await readFile(path, 'utf8')) as Record<string, unknown>).task && typeof (YAML.parse(await readFile(path, 'utf8')) as Record<string, any>).task.taskSchema === 'string'
    ? (YAML.parse(await readFile(path, 'utf8')) as Record<string, any>).task.taskSchema
    : '');
  const document = YAML.parse(await readFile(path, 'utf8')) as Record<string, any>;
  const envelopePath = await writeJson(temporaryDirectory, `${task.taskUid}.envelope.json`, document);
  const payloadPath = await writeJson(temporaryDirectory, `${task.taskUid}.payload.json`, { status: document.task?.status, intent: document.task?.intent, result: document.task?.result });
  const findings = [
    ...await validateDocument(join(schemaRoot, 'schemas'), 'sdlc-task-envelope/v1/sdlc-task-envelope.schema.json', envelopePath, repositoryRoot),
    ...await validateTaskPayload(schemaRoot, relativeTaskSchema, payloadPath, repositoryRoot, { status: document.task?.status, intent: document.task?.intent, result: document.task?.result }, temporaryDirectory, task.taskUid),
    ...lifecycleFindings(join(schemaRoot, 'schemas'), relativeTaskSchema, { status: document.task?.status, intent: document.task?.intent, result: document.task?.result }),
  ];
  const taskContext: TaskContext = {
    taskUid: task.taskUid,
    document: { fullPath: path, repositoryPath: task.path, format: path.endsWith('.json') ? 'json' : 'yaml', value: document },
  };
  const referenceFindings = await discoverReferenceFindings(repositoryRoot, schemaRoot, document, '$', taskContext);
  const identifierFindings = discoverIdentifierFindings(document, '$', task.taskUid).filter((finding) => !isTaskOwnedId(finding.value));
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
    valid: schemaFindings.length === 0 && referenceErrors.length === 0 && identifierFindings.length === 0,
    findings: [...schemaFindings, ...identifierFindings.map((finding) => `${finding.path}: ${finding.reason}; required=${finding.requiredForm}\nRemediation: ${finding.remediation}`), ...referenceErrors.map((finding) => `${finding.path}: ${finding.reason}\nRemediation: ${finding.remediation}`)],
    schemaFindings,
    referenceFindings,
    remediation: [...schemaFindings.map((finding) => remediationForSchema(relativeTaskSchema, task.path)), ...identifierFindings.map((finding) => finding.remediation), ...referenceErrors.map((finding) => finding.remediation)],
    identifierFindings,
  };
}

export async function validateWorkItem(repositoryRoot: string, workItemId: string, selectedTaskUid?: string, schemaRoot = packageRoot): Promise<WorkItemValidationReport> {
  if (!WORK_ITEM_ID.test(workItemId)) throw new DiscoveryError(`Invalid work-item ID: ${workItemId}`);
  const workItemPath = resolve(repositoryRoot, `.docs/work-items/${workItemId}/work-item.json`);
  const temporaryDirectory = await mkdtemp(join('/tmp', 'sdlc-work-item-validation-'));
  try {
    const workItemObject = JSON.parse(await readFile(workItemPath, 'utf8'));
    const workItemDocument = await writeJson(temporaryDirectory, 'work-item.json', workItemObject);
    const workItemSchemaUri = typeof workItemObject.schema === 'string' ? workItemObject.schema : '';
    const workItemSchemaMatch = /^https:\/\/schemas\.handschuh\.dev\/sdlc\/work-item\/v([1-9][0-9]*)$/u.exec(workItemSchemaUri);
    const workItemSchemaPath = workItemSchemaMatch ? `work-item/v${workItemSchemaMatch[1]}/work-item.schema.json` : 'work-item/v2/work-item.schema.json';
    const workItemFindings = await validateDocument(join(schemaRoot, 'schemas'), workItemSchemaPath, workItemDocument, repositoryRoot);
    const workItemReferenceFindings = await discoverReferenceFindings(repositoryRoot, schemaRoot, workItemObject, '$');
    const workItemRepositoryPath = `.docs/work-items/${workItemId}/work-item.json`;
    const workItemIdentity = await statIdentity(repositoryRoot, workItemRepositoryPath, workItemId, 'work-item', `${workItemId}#work-item.json#work-item/${workItemId}`, `schemas/${workItemSchemaPath}`);
    const branchReport = await validateBranchContext(repositoryRoot, workItemObject as any);
    const branchPolicyApplies = workItemSchemaUri.endsWith('/work-item/v3') || workItemObject.workItemId === 'WI-0024';
    const branchFindings = branchReport.findings.map((finding) => `Branch policy: ${finding}`);
    const versionFindings = workItemSchemaUri.endsWith('/work-item/v3') && !workItemObject.versionSuggestion
      ? ['Version policy: work-item/v3 requires versionSuggestion in every lifecycle state.']
      : [];
    const deliveryFindings = branchFindings.filter((finding) => finding.includes('merge target') || finding.includes('primary') || finding.includes('remote'));
    const objects: WorkItemObjectValidation[] = [];
    if (!selectedTaskUid) objects.push({
      path: `.docs/work-items/${workItemId}/work-item.json`,
      ...workItemIdentity,
      objectType: 'work-item',
      valid: workItemFindings.length === 0 && workItemReferenceFindings.every((finding) => finding.resolved) && (!branchPolicyApplies || branchFindings.length === 0) && versionFindings.length === 0,
      findings: [...workItemFindings.map((finding) => `${finding}\nRemediation: ${remediationForSchema(`schemas/${workItemSchemaPath}`, workItemRepositoryPath)}`), ...workItemReferenceFindings.filter((finding) => !finding.resolved).map((finding) => `${finding.path}: ${finding.reason}\nRemediation: ${finding.remediation}`), ...(branchPolicyApplies ? branchFindings : []), ...versionFindings],
      schemaFindings: [...workItemFindings, ...versionFindings],
      referenceFindings: workItemReferenceFindings,
      remediation: [
        ...workItemFindings.map(() => remediationForSchema(`schemas/${workItemSchemaPath}`, workItemRepositoryPath)),
        ...workItemReferenceFindings.filter((finding) => !finding.resolved).map((finding) => finding.remediation),
        ...(branchPolicyApplies ? branchFindings.map(() => `Switch to the declared merge target or context branch, or run sdlc work-item start --work-item ${workItemId} from the merge target.`) : []),
        ...versionFindings.map(() => `Add versionSuggestion with impact, rationale, and disclaimer to ${workItemRepositoryPath}, then rerun validation.`),
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
      if (!selectedTaskUid || task.taskUid === selectedTaskUid) objects.push(await validateTask(repositoryRoot, schemaRoot, temporaryDirectory, workItemId, task));
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
      branch: {
        currentBranch: branchReport.currentBranch,
        detachedHead: branchReport.detachedHead,
        mergeTargetBranch: branchReport.mergeTargetBranch,
        contextBranch: branchReport.contextBranch,
        mergeTargetLocal: branchReport.mergeTargetLocal,
        mergeTargetRemote: branchReport.mergeTargetRemote,
        remotes: branchReport.remotes,
      },
      delivery: {
        primaryBranch: branchReport.mergeTargetBranch,
        tagRequired: branchReport.currentBranch === branchReport.mergeTargetBranch && workItemObject.status === 'complete',
        expectedVersion: null,
        findings: deliveryFindings,
      },
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}