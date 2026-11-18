import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTasks, discoverWorkItems, DiscoveryError, type DiscoveryReport, type TaskSummary, type WorkItemSummary } from '../core/discovery.js';

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function printHelp(): void {
  console.log('Usage: sdlc [options]');
  console.log('\nOptions:');
  console.log('  -h, --help       Show this help message');
  console.log('  -v, --version    Show the package version');
  console.log('\nCommands:');
  console.log('  work-item list   List .docs/work-items/*');
  console.log('  task list <id>   List the selected work-item task records');
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
    console.log('Usage: sdlc work-item list [--json]');
    console.log('List canonical work-item.json records below .docs/work-items/.');
  } else {
    console.log('Usage: sdlc task list <work-item-id> [--json]');
    console.log('List canonical task envelopes below the selected work item stepsPath.');
  }
  return 0;
}

async function handleDiscovery(args: readonly string[]): Promise<number | undefined> {
  const [first, second, third] = args;
  if (first === 'work-item' && (second === '--help' || second === '-h')) return commandHelp('work-item list');
  if (first === 'task' && (second === '--help' || second === '-h')) return commandHelp('task list');
  if (first === 'work-item' && second === 'list') {
    if (third && third !== '--json') throw new DiscoveryError(`Unknown option: ${third}`);
    const report = await discoverWorkItems(repositoryRoot);
    printWorkItems(report, jsonRequested(args));
    return report.findings.length > 0 ? 1 : 0;
  }
  if (first === 'task' && second === 'list') {
    const workItemId = third && !third.startsWith('--') ? third : undefined;
    if (!workItemId) throw new DiscoveryError('Usage: sdlc task list <work-item-id> [--json]');
    const extra = args.slice(3).filter((arg) => arg !== '--json');
    if (extra.length > 0) throw new DiscoveryError(`Unknown option: ${extra[0]}`);
    const report = await discoverTasks(repositoryRoot, workItemId);
    printTasks(workItemId, report, jsonRequested(args));
    return report.findings.length > 0 ? 1 : 0;
  }
  return undefined;
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
