import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscoveryError, statTrackedPath } from '../core/discovery.js';
import { resolveOperativeRoot } from '../core/operative-root.js';
import { runDiscoveredCommands } from './command-runner.js';

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
type OperativeRootSupplier = () => Promise<string>;

async function version(): Promise<string> {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string };
  return packageJson.version;
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

async function legacyMain(args: readonly string[]): Promise<number> {
  const [first] = args;

  if (!first || first === '-h' || first === '--help') return 0;

  if (first === '-v' || first === '--version') {
    console.log(await version());
    return 0;
  }

  try {
    const getOperativeRoot = (): Promise<string> => resolveOperativeRoot();
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
      || (args[0] === 'repository' && args[1] === 'info')
      || (args[0] === 'ref' && ['validate', 'resolve', 'migrate-task-local-up', 'migrate-work-item-up'].includes(args[1] ?? ''));
    if (!dynamicInvocation) return await legacyMain(args);
    const dynamicResult = await runDiscoveredCommands(args, import.meta.url, packageRoot, await version());
    return dynamicResult === undefined ? await legacyMain(args) : dynamicResult;
  } catch (error) {
    console.error(error instanceof DiscoveryError ? error.message : error instanceof Error ? error.message : 'Command failed');
    return 1;
  }
}
