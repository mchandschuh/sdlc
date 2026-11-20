import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscoveryError, statTrackedPath } from '../core/discovery.js';
import { validateReference } from '../core/reference.js';
import { resolveReference, validateReferenceResource } from '../core/reference-resolution.js';
import { migrateTaskLocalReferences, migrateTaskLocalReferencesForWorkItem, migrateWorkItemReferences } from '../core/task-local-migration.js';
import { WORK_ITEM_VALIDATION_SCHEMA } from '../core/work-item-validation.js';
import { resolveOperativeRoot } from '../core/operative-root.js';
import { runDiscoveredCommands } from './command-runner.js';

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
type OperativeRootSupplier = () => Promise<string>;

async function version(): Promise<string> {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string };
  return packageJson.version;
}

function jsonRequested(args: readonly string[]): boolean {
  return args.includes('--json');
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
  if (args[1] === 'migrate-work-item-up') {
    if (args[2] === '--help' || args[2] === '-h') {
      console.log('Usage: sdlc ref migrate-work-item-up --work-item <work-item-id> [--json]');
      console.log('Migrate recognized references under one complete work-item directory.');
      return 0;
    }
    let workItemId: string | undefined;
    for (let index = 2; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === '--json') continue;
      if (argument === '--work-item') {
        const value = args[++index];
        if (!value || value.startsWith('-')) throw new DiscoveryError('--work-item requires a value.');
        if (workItemId !== undefined) throw new DiscoveryError('Duplicate --work-item option.');
        workItemId = value;
      } else if (argument.startsWith('--work-item=')) {
        const value = argument.slice('--work-item='.length);
        if (!value) throw new DiscoveryError('--work-item requires a value.');
        if (workItemId !== undefined) throw new DiscoveryError('Duplicate --work-item option.');
        workItemId = value;
      } else {
        throw new DiscoveryError(`Unknown option: ${argument}`);
      }
    }
    if (!workItemId) throw new DiscoveryError('Usage: sdlc ref migrate-work-item-up --work-item <work-item-id> [--json]');
    const report = await migrateWorkItemReferences(await resolveOperativeRoot(), workItemId);
    console.log(JSON.stringify(report, null, 2));
    return report.findings.length === 0 ? 0 : 1;
  }
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

async function legacyMain(args: readonly string[]): Promise<number> {
  const [first] = args;

  if (!first || first === '-h' || first === '--help') return 0;

  if (first === '-v' || first === '--version') {
    console.log(await version());
    return 0;
  }

  try {
    const getOperativeRoot = (): Promise<string> => resolveOperativeRoot();
    const referenceResult = await handleReference(args, packageRoot);
    if (referenceResult !== undefined) return referenceResult;
    const statResult = await handleStat(args, getOperativeRoot);
    if (statResult !== undefined) return statResult;
  } catch (error) {
    console.error(error instanceof DiscoveryError ? error.message : 'Discovery failed');
    return 1;
  }

  console.error(`Unknown option: ${first}`);
  console.error('Run "sdlc --help" to see available options.');
  return 2;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const dynamicInvocation = args.length === 0
      || args.includes('-h')
      || args.includes('--help')
      || args.includes('-v')
      || args.includes('--version')
      || (args[0] === 'work-item' && ['list', 'start', 'validate'].includes(args[1] ?? ''))
      || (args[0] === 'task' && ['list', 'validate', 'next'].includes(args[1] ?? ''))
      || (args[0] === 'repository' && args[1] === 'info');
    if (!dynamicInvocation) return await legacyMain(args);
    const dynamicResult = await runDiscoveredCommands(args, import.meta.url, packageRoot, await version());
    return dynamicResult === undefined ? await legacyMain(args) : dynamicResult;
  } catch (error) {
    console.error(error instanceof DiscoveryError ? error.message : error instanceof Error ? error.message : 'Command failed');
    return 1;
  }
}
