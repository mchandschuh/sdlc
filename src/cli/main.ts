import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverNextTask, discoverTasks, discoverWorkItems, DiscoveryError, statTrackedPath, type DiscoveryReport, type TaskSummary, type WorkItemSummary } from '../core/discovery.js';
import { validateReference } from '../core/reference.js';
import { resolveReference, validateReferenceResource } from '../core/reference-resolution.js';
import { migrateTaskLocalReferences, migrateTaskLocalReferencesForWorkItem } from '../core/task-local-migration.js';
import { validateWorkItem, WORK_ITEM_VALIDATION_SCHEMA, type WorkItemValidationReport } from '../core/work-item-validation.js';
import { repositoryInfo, REPOSITORY_INFO_SCHEMA, type RepositoryInfoReport } from '../core/repository.js';
import { resolveCommandContext, resolveOperativeRoot } from '../core/operative-root.js';

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
type OperativeRootSupplier = () => Promise<string>;

export function printHelp(): void {
  console.log('Usage: sdlc [options]');
  console.log('\nOptions:');
  console.log('  -h, --help       Show this help message');
  console.log('  -v, --version    Show the package version');
  console.log('\nCommands:');
  console.log('  work-item list   List .docs/work-items/*');
  console.log('  repository info   Find the nearest Git repository');
  console.log('  task list        List the selected work-item task records');
  console.log('  task next        Select the next unprocessed task');
  console.log('  ref validate     Validate one schema-registered reference');
  console.log('  ref resolve      Resolve a repository-local reference to document data');
  console.log('  ref migrate-task-local-up  Migrate recognized task-local references under a path');
  console.log('  stat              Inspect one tracked file path');
}

async function version(): Promise<string> {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string };
  return packageJson.version;
}

function jsonRequested(args: readonly string[]): boolean {
  return args.includes('--json');
}

function printWorkItems(report: DiscoveryReport<WorkItemSummary>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ schema: 'sdlc-work-item-list/v1', ...report }, null, 2));
    return;
  }
  console.log('Work items:');
  for (const item of report.items) console.log(`  ${item.workItemId}  ${item.status.padEnd(12)} ${item.title} (${item.path})`);
  if (report.items.length === 0) console.log('  none');
  for (const finding of report.findings) console.error(`Finding: ${finding}`);
}

function printTasks(workItemId: string, report: DiscoveryReport<TaskSummary>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ schema: 'sdlc-task-list/v1', workItemId, ...report }, null, 2));
    return;
  }
  console.log(`Tasks for ${workItemId}:`);
  for (const task of report.items) console.log(`  ${task.taskUid}  ${task.taskType.padEnd(14)} ${task.processingStatus.padEnd(22)} ${task.path}`);
  if (report.items.length === 0) console.log('  none');
  for (const finding of report.findings) console.error(`Finding: ${finding}`);
}

function commandHelp(command: 'work-item list' | 'task list'): number {
  if (command === 'work-item list') {
    console.log('Usage: sdlc work-item list [--work-item <work-item>] [--json]');
    console.log('List canonical work-item.json records below .docs/work-items/.');
  } else {
    console.log('Usage: sdlc task list --work-item <work-item> [--json]');
    console.log('List canonical task envelopes below the selected work item stepsPath.');
  }
  return 0;
}

function printNextTask(workItemId: string, task: TaskSummary | null, json: boolean): void {
  const response = {
    schema: 'https://schemas.handschuh.dev/sdlc/task-next/v1',
    workItemId,
    selection: task ? 'selected' : 'none',
    task,
  } as const;
  if (json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (task) {
    console.log(`Next task for ${workItemId}:`);
    console.log(`  ${task.taskUid}  ${task.taskType.padEnd(14)} ${task.processingStatus.padEnd(22)} ${task.path}`);
  } else {
    console.log(`No task requires processing for ${workItemId}.`);
  }
}

function printWorkItemValidation(report: WorkItemValidationReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Work item validation for ${report.workItemId}: ${report.valid ? 'passed' : 'failed'}`);
  console.log(`  Objects: ${report.validObjectCount}/${report.objectCount} valid`);
  for (const object of report.objects) {
    console.log(`  ${object.valid ? 'PASS' : 'FAIL'} ${object.objectType} ${object.path}`);
    for (const finding of object.findings) console.error(`Finding: ${finding}`);
  }
}

function printRepositoryInfo(report: RepositoryInfoReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Repository: ${report.repositoryRoot}`);
  console.log(`  Path: ${report.fullPath}`);
  console.log(`  Git directory: ${report.gitDir}`);
  console.log(`  Bare: ${report.isBare}`);
  console.log(`  Origin: ${report.origin ?? 'none'}`);
}

function optionValue(args: readonly string[], name: string): { value?: string; duplicate: boolean; unknown?: string } {
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') continue;
    if (argument === name) {
      const next = args[index + 1];
      if (!next || next.startsWith('-')) throw new DiscoveryError(`${name} requires a value.`);
      if (value !== undefined) return { duplicate: true };
      value = next;
      index += 1;
      continue;
    }
    if (argument.startsWith(`${name}=`)) {
      const next = argument.slice(name.length + 1);
      if (!next) throw new DiscoveryError(`${name} requires a value.`);
      if (value !== undefined) return { duplicate: true };
      value = next;
      continue;
    }
    return { duplicate: false, value, unknown: argument };
  }
  return { duplicate: false, value };
}

function selectedOptions(args: readonly string[], names: readonly string[]): { readonly values: Readonly<Record<string, string | undefined>>; readonly unknown?: string } {
  const values: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') continue;
    const name = names.find((candidate) => argument === candidate || argument.startsWith(`${candidate}=`));
    if (!name) return { values, unknown: argument };
    const value = argument === name ? args[++index] : argument.slice(name.length + 1);
    if (!value || value.startsWith('-')) throw new DiscoveryError(`${name} requires a value.`);
    if (values[name] !== undefined) throw new DiscoveryError(`Duplicate ${name} option.`);
    values[name] = value;
  }
  return { values };
}

async function handleWorkItemValidation(args: readonly string[], getOperativeRoot: OperativeRootSupplier): Promise<number | undefined> {
  if (args[0] !== 'work-item' || args[1] !== 'validate') return undefined;
  const selected = selectedOptions(args.slice(2), ['--work-item', '--repository-root']);
  if (selected.unknown) throw new DiscoveryError(`Unknown option: ${selected.unknown}`);
  const workItem = selected.values['--work-item'];
  if (!workItem) throw new DiscoveryError('Usage: sdlc work-item validate --work-item <work-item> [--repository-root <path>] [--json]');
  const context = await resolveCommandContext(selected.values['--repository-root']);
  const report = await validateWorkItem(context.repositoryRoot, workItem, undefined, context.schemaRegistryRoot);
  printWorkItemValidation(report, jsonRequested(args));
  return report.valid ? 0 : 1;
}

async function handleTaskValidation(args: readonly string[], getOperativeRoot: OperativeRootSupplier): Promise<number | undefined> {
  if (args[0] !== 'task' || args[1] !== 'validate') return undefined;
  const selected = selectedOptions(args.slice(2), ['--task', '--repository-root']);
  if (selected.unknown) throw new DiscoveryError(`Unknown option: ${selected.unknown}`);
  const task = selected.values['--task'];
  if (!task) throw new DiscoveryError('Usage: sdlc task validate --task <task-identifier> [--repository-root <path>] [--json]');
  if (!/^[A-Z]{1,10}-[0-9]+-[0-9]{8}$/u.test(task)) throw new DiscoveryError(`Invalid task identifier: ${task}`);
  const workItemId = task.slice(0, task.lastIndexOf('-'));
  const context = await resolveCommandContext(selected.values['--repository-root']);
  const report = await validateWorkItem(context.repositoryRoot, workItemId, task, context.schemaRegistryRoot);
  printWorkItemValidation(report, jsonRequested(args));
  return report.valid ? 0 : 1;
}

async function handleRepositoryInfo(args: readonly string[]): Promise<number | undefined> {
  if (args[0] !== 'repository' || args[1] !== 'info') return undefined;
  const selected = optionValue(args.slice(2), '--path');
  if (selected.duplicate) throw new DiscoveryError('Duplicate --path option.');
  if (selected.unknown) throw new DiscoveryError(`Unknown option: ${selected.unknown}`);
  if (!selected.value) throw new DiscoveryError('Usage: sdlc repository info --path <path> [--json]');
  try {
    const report = await repositoryInfo(selected.value);
    printRepositoryInfo(report, jsonRequested(args));
    return 0;
  } catch (error) {
    throw new DiscoveryError(error instanceof Error ? error.message : 'Repository discovery failed');
  }
}

async function handleDiscovery(args: readonly string[], getOperativeRoot: OperativeRootSupplier): Promise<number | undefined> {
  const [first, second] = args;
  if (first === 'work-item' && (second === '--help' || second === '-h')) return commandHelp('work-item list');
  if (first === 'task' && (second === '--help' || second === '-h')) return commandHelp('task list');
  if (first === 'work-item' && second === 'list' && (args.includes('--help') || args.includes('-h'))) return commandHelp('work-item list');
  if (first === 'task' && second === 'list' && (args.includes('--help') || args.includes('-h'))) return commandHelp('task list');
  if (first === 'work-item' && second === 'list') {
    const selected = optionValue(args.slice(2), '--work-item');
    if (selected.duplicate) throw new DiscoveryError('Duplicate --work-item option.');
    if (selected.unknown) throw new DiscoveryError(`Unknown option: ${selected.unknown}`);
    const report = await discoverWorkItems(await getOperativeRoot());
    if (!selected.value) {
      printWorkItems(report, jsonRequested(args));
      return report.findings.length > 0 ? 1 : 0;
    }
    if (!/^[A-Z]{1,10}-[0-9]+$/u.test(selected.value)) throw new DiscoveryError(`Invalid work-item ID: ${selected.value}`);
    if (!report.items.some((item) => item.workItemId === selected.value)) throw new DiscoveryError(`Work item not found: ${selected.value}`);
    const selectedReport = { ...report, items: report.items.filter((item) => item.workItemId === selected.value) };
    printWorkItems(selectedReport, jsonRequested(args));
    return selectedReport.findings.length > 0 ? 1 : 0;
  }
  if (first === 'task' && second === 'list') {
    const selected = optionValue(args.slice(2), '--work-item');
    if (selected.duplicate) throw new DiscoveryError('Duplicate --work-item option.');
    if (selected.unknown) throw new DiscoveryError(`Unknown option: ${selected.unknown}`);
    if (!selected.value) throw new DiscoveryError('Usage: sdlc task list --work-item <work-item> [--json]');
    const report = await discoverTasks(await getOperativeRoot(), selected.value);
    printTasks(selected.value, report, jsonRequested(args));
    return report.findings.length > 0 ? 1 : 0;
  }
  if (first === 'task' && second === 'next') {
    const selected = optionValue(args.slice(2), '--work-item');
    if (selected.duplicate) throw new DiscoveryError('Duplicate --work-item option.');
    if (selected.unknown) throw new DiscoveryError(`Unknown option: ${selected.unknown}`);
    if (!selected.value) throw new DiscoveryError('Usage: sdlc task next --work-item <work-item> [--json]');
    if (!/^[A-Z]{1,10}-[0-9]+$/u.test(selected.value)) throw new DiscoveryError(`Invalid work-item ID: ${selected.value}`);
    const task = await discoverNextTask(await getOperativeRoot(), selected.value);
    printNextTask(selected.value, task, jsonRequested(args));
    return 0;
  }
  return undefined;
}

async function handleStat(args: readonly string[], getOperativeRoot: OperativeRootSupplier): Promise<number | undefined> {
  if (args[0] !== 'stat') return undefined;
  if (args[1] === '--help' || args[1] === '-h') {
    console.log('Usage: sdlc stat --path <file-path>');
    console.log('Inspect one repository-tracked file and return a stable JSON stat envelope.');
    return 0;
  }
  let pathValue: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') continue;
    if (argument === '--path') {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new DiscoveryError('--path requires a file path.');
      if (pathValue !== undefined) throw new DiscoveryError('Duplicate --path option.');
      pathValue = value;
    } else if (argument.startsWith('--path=')) {
      const value = argument.slice('--path='.length);
      if (!value) throw new DiscoveryError('--path requires a file path.');
      if (pathValue !== undefined) throw new DiscoveryError('Duplicate --path option.');
      pathValue = value;
    } else {
      throw new DiscoveryError(`Unknown option: ${argument}`);
    }
  }
  if (!pathValue) throw new DiscoveryError('Usage: sdlc stat --path <file-path>');
  const result = await statTrackedPath(await getOperativeRoot(), pathValue);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

async function handleReference(args: readonly string[], schemaRoot: string): Promise<number | undefined> {
  if (args[0] !== 'ref') return undefined;
  if (args[1] === 'migrate-task-local-up') {
    if (args[2] === '--help' || args[2] === '-h') {
      console.log('Usage: sdlc ref migrate-task-local-up [--path <path> | --work-item <work-item-id>] [--json]');
      console.log('Rewrite recognized legacy task-local/task-qualified references under one bounded repository scope.');
      return 0;
    }
    let pathValue: string | undefined;
    let workItemId: string | undefined;
    for (let index = 2; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === '--json') continue;
      if (argument === '--path' || argument === '--work-item') {
        const value = args[++index];
        if (!value || value.startsWith('-')) throw new DiscoveryError(`${argument} requires a value.`);
        if (argument === '--path') {
          if (pathValue !== undefined) throw new DiscoveryError('Duplicate --path option.');
          pathValue = value;
        } else {
          if (workItemId !== undefined) throw new DiscoveryError('Duplicate --work-item option.');
          workItemId = value;
        }
        continue;
      }
      if (argument.startsWith('--path=')) {
        const value = argument.slice('--path='.length);
        if (!value) throw new DiscoveryError('--path requires a value.');
        if (pathValue !== undefined) throw new DiscoveryError('Duplicate --path option.');
        pathValue = value;
        continue;
      }
      if (argument.startsWith('--work-item=')) {
        const value = argument.slice('--work-item='.length);
        if (!value) throw new DiscoveryError('--work-item requires a value.');
        if (workItemId !== undefined) throw new DiscoveryError('Duplicate --work-item option.');
        workItemId = value;
        continue;
      }
      throw new DiscoveryError(`Unknown option: ${argument}`);
    }
    if (pathValue !== undefined && workItemId !== undefined) throw new DiscoveryError('--path and --work-item are mutually exclusive.');
    if (pathValue === undefined && workItemId === undefined) throw new DiscoveryError('Usage: sdlc ref migrate-task-local-up [--path <path> | --work-item <work-item-id>]');
    const root = await resolveOperativeRoot();
    const report = pathValue !== undefined
      ? await migrateTaskLocalReferences(root, pathValue)
      : await migrateTaskLocalReferencesForWorkItem(root, workItemId!);
    console.log(JSON.stringify(report, null, 2));
    return report.findings.length === 0 ? 0 : 1;
  }
  if (args[1] !== 'validate' && args[1] !== 'resolve') throw new DiscoveryError('Usage: sdlc ref <validate|resolve|migrate-task-local-up>');
  const command = args[1];
  if (args[2] === '--help' || args[2] === '-h') {
    console.log(command === 'validate' ? 'Usage: sdlc ref validate --ref <reference>' : 'Usage: sdlc ref resolve --ref <reference> [--depth [positive-integer]]');
    console.log(command === 'validate' ? 'Validate one reference against recursively discovered schema-registered reference types.' : 'Resolve one repository-local reference to its containing document and selected data, with optional flat reference expansion.');
    return 0;
  }
  let ref: string | undefined;
  let depth = 1;
  let depthSelected = false;
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') continue;
    if (argument === '--ref') {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new DiscoveryError('--ref requires a reference.');
      if (ref !== undefined) throw new DiscoveryError('Duplicate --ref option.');
      ref = value;
    } else if (command === 'resolve' && argument === '--depth') {
      if (depthSelected) throw new DiscoveryError('Duplicate --depth option.');
      depthSelected = true;
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) continue;
      if (!/^[1-9][0-9]*$/u.test(value)) throw new DiscoveryError('--depth requires a positive integer.');
      depth = Number(value);
      if (!Number.isSafeInteger(depth)) throw new DiscoveryError('--depth is too large.');
      index += 1;
    } else if (command === 'resolve' && argument.startsWith('--depth=')) {
      if (depthSelected) throw new DiscoveryError('Duplicate --depth option.');
      depthSelected = true;
      const value = argument.slice('--depth='.length);
      if (!/^[1-9][0-9]*$/u.test(value)) throw new DiscoveryError('--depth requires a positive integer.');
      depth = Number(value);
      if (!Number.isSafeInteger(depth)) throw new DiscoveryError('--depth is too large.');
    } else if (argument.startsWith('--ref=')) {
      const value = argument.slice('--ref='.length);
      if (!value) throw new DiscoveryError('--ref requires a reference.');
      if (ref !== undefined) throw new DiscoveryError('Duplicate --ref option.');
      ref = value;
    } else {
      throw new DiscoveryError(`Unknown option: ${argument}`);
    }
  }
  if (!ref) throw new DiscoveryError(`Usage: sdlc ref ${command} --ref <reference>`);
  let repositoryRoot: string | undefined;
  try {
    repositoryRoot = await resolveOperativeRoot();
  } catch (error) {
    if (command === 'validate') {
      const result = await validateReference(schemaRoot, ref);
      console.log(JSON.stringify(result, null, 2));
      return result.valid ? 0 : 1;
    }
    throw error;
  }
  const result = command === 'validate'
    ? await validateReferenceResource(repositoryRoot, schemaRoot, ref)
    : await resolveReference(repositoryRoot, schemaRoot, ref, depth);
  console.log(JSON.stringify(result, null, 2));
  return result.valid ? 0 : 1;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [first] = args;

  if (!first || first === '-h' || first === '--help') {
    printHelp();
    return 0;
  }

  if (first === '-v' || first === '--version') {
    console.log(await version());
    return 0;
  }

  try {
    const getOperativeRoot = (): Promise<string> => resolveOperativeRoot();
    const referenceResult = await handleReference(args, packageRoot);
    if (referenceResult !== undefined) return referenceResult;
    const repositoryInfoResult = await handleRepositoryInfo(args);
    if (repositoryInfoResult !== undefined) return repositoryInfoResult;
    const workItemValidationResult = await handleWorkItemValidation(args, getOperativeRoot);
    if (workItemValidationResult !== undefined) return workItemValidationResult;
    const taskValidationResult = await handleTaskValidation(args, getOperativeRoot);
    if (taskValidationResult !== undefined) return taskValidationResult;
    const statResult = await handleStat(args, getOperativeRoot);
    if (statResult !== undefined) return statResult;
    const discoveryResult = await handleDiscovery(args, getOperativeRoot);
    if (discoveryResult !== undefined) return discoveryResult;
  } catch (error) {
    console.error(error instanceof DiscoveryError ? error.message : 'Discovery failed');
    return 1;
  }

  console.error(`Unknown option: ${first}`);
  console.error('Run "sdlc --help" to see available options.');
  return 2;
}
