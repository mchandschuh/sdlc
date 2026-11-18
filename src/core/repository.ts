import { execFile } from 'node:child_process';
import { stat as statFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const REPOSITORY_INFO_SCHEMA = 'https://schemas.handschuh.dev/sdlc/repository/info/v1';

export interface RepositoryInfoReport {
  readonly schema: typeof REPOSITORY_INFO_SCHEMA;
  readonly fullPath: string;
  readonly repositoryRoot: string;
  readonly gitDir: string;
  readonly isBare: boolean;
  readonly origin: string | null;
}

async function gitValue(repositoryRoot: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' });
  return result.stdout.trim();
}

async function isGitBoundary(directory: string): Promise<boolean> {
  try {
    await statFile(resolve(directory, '.git'));
    return true;
  } catch {
    return false;
  }
}

export async function repositoryInfo(repositoryPath: string): Promise<RepositoryInfoReport> {
  if (!repositoryPath || repositoryPath.startsWith('-')) throw new Error('--path requires a path.');
  const fullPath = resolve(repositoryPath);
  let current = fullPath;
  try {
    if (!(await statFile(current)).isDirectory()) current = dirname(current);
  } catch {
    throw new Error(`Path not found: ${repositoryPath}`);
  }
  while (!(await isGitBoundary(current))) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`No Git repository found from path: ${repositoryPath}`);
    current = parent;
  }
  const [repositoryRoot, gitDir, bare, origin] = await Promise.all([
    gitValue(current, ['rev-parse', '--show-toplevel']),
    gitValue(current, ['rev-parse', '--git-dir']),
    gitValue(current, ['rev-parse', '--is-bare-repository']),
    gitValue(current, ['config', '--get', 'remote.origin.url']).catch(() => ''),
  ]);
  return {
    schema: REPOSITORY_INFO_SCHEMA,
    fullPath,
    repositoryRoot: resolve(repositoryRoot),
    gitDir: resolve(current, gitDir),
    isBare: bare === 'true',
    origin: origin || null,
  };
}