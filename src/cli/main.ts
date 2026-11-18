import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTasks, discoverWorkItems, DiscoveryError, statTrackedPath, type DiscoveryReport, type TaskSummary, type WorkItemSummary } from '../core/discovery.js';
import { validateReference } from '../core/reference.js';

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function printHelp(): void {
  console.log('Usage: sdlc [options]');
  console.log('\nOptions:');
  console.log('  -h, --help       Show this help message');
  console.log('  -v, --version    Show the package version');
  console.log('\nCommands:');
  console.log('  work-item list   List .docs/work-items/*');
  console.log('  task list        List the selected work-item task records');
  console.log('  ref validate     Validate one schema-registered reference');
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

async function handleDiscovery(args: readonly string[]): Promise<number | undefined> {
  const [first, second] = args;
  if (first === 'work-item' && (second === '--help' || second === '-h')) return commandHelp('work-item list');
  if (first === 'task' && (second === '--help' || second === '-h')) return commandHelp('task list');
  if (first === 'work-item' && second === 'list' && (args.includes('--help') || args.includes('-h'))) return commandHelp('work-item list');
  if (first === 'task' && second === 'list' && (args.includes('--help') || args.includes('-h'))) return commandHelp('task list');
  if (first === 'work-item' && second === 'list') {
    const selected = optionValue(args.slice(2), '--work-item');
    if (selected.duplicate) throw new DiscoveryError('Duplicate --work-item option.');
    if (selected.unknown) throw new DiscoveryError(`Unknown option: ${selected.unknown}`);
    const report = await discoverWorkItems(repositoryRoot);
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
    const report = await discoverTasks(repositoryRoot, selected.value);
    printTasks(selected.value, report, jsonRequested(args));
    return report.findings.length > 0 ? 1 : 0;
  }
  return undefined;
}

async function handleStat(args: readonly string[]): Promise<number | undefined> {
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
  const result = await statTrackedPath(repositoryRoot, pathValue);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

async function handleReference(args: readonly string[]): Promise<number | undefined> {
  if (args[0] !== 'ref') return undefined;
  if (args[1] !== 'validate') throw new DiscoveryError('Usage: sdlc ref validate --ref <reference>');
  if (args[2] === '--help' || args[2] === '-h') {
    console.log('Usage: sdlc ref validate --ref <reference>');
    console.log('Validate one reference against recursively discovered schema-registered reference types.');
    return 0;
  }
  let ref: string | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') continue;
    if (argument === '--ref') {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new DiscoveryError('--ref requires a reference.');
      if (ref !== undefined) throw new DiscoveryError('Duplicate --ref option.');
      ref = value;
    } else if (argument.startsWith('--ref=')) {
      const value = argument.slice('--ref='.length);
      if (!value) throw new DiscoveryError('--ref requires a reference.');
      if (ref !== undefined) throw new DiscoveryError('Duplicate --ref option.');
      ref = value;
    } else {
      throw new DiscoveryError(`Unknown option: ${argument}`);
    }
  }
  if (!ref) throw new DiscoveryError('Usage: sdlc ref validate --ref <reference>');
  const result = await validateReference(repositoryRoot, ref);
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
    const referenceResult = await handleReference(args);
    if (referenceResult !== undefined) return referenceResult;
    const statResult = await handleStat(args);
    if (statResult !== undefined) return statResult;
    const discoveryResult = await handleDiscovery(args);
    if (discoveryResult !== undefined) return discoveryResult;
  } catch (error) {
    console.error(error instanceof DiscoveryError ? error.message : 'Discovery failed');
    return 1;
  }

  console.error(`Unknown option: ${first}`);
  console.error('Run "sdlc --help" to see available options.');
  return 2;
}
