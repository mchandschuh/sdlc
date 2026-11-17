import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');

export function printHelp(): void {
  console.log('Usage: nodejs-cli-pattern [options]');
  console.log('\nOptions:');
  console.log('  -h, --help       Show this help message');
  console.log('  -v, --version    Show the package version');
}

async function version(): Promise<string> {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string };
  return packageJson.version;
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

  console.error(`Unknown option: ${first}`);
  console.error('Run "nodejs-cli-pattern --help" to see available options.');
  return 2;
}
