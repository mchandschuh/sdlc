import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDiscoveredCommands } from './command-runner.js';

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function version(): Promise<string> {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string };
  return packageJson.version;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await runDiscoveredCommands(args, import.meta.url, packageRoot, await version()) ?? 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Command failed');
    return 1;
  }
}
