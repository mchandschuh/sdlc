import { execFile } from 'node:child_process';
import { stat as statFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveRepositoryRoot } from './repository-root.js';

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

export async function repositoryInfo(repositoryPath: string): Promise<RepositoryInfoReport> {
  if (!repositoryPath || repositoryPath.startsWith('-')) throw new Error('--path requires a path.');
  const fullPath = resolve(repositoryPath);
  try {
    if (!(await statFile(fullPath)).isDirectory()) {
      await statFile(fullPath);
    }
  } catch {
    throw new Error(`Path not found: ${repositoryPath}`);
  }
  const resolved = await resolveRepositoryRoot({ startingPath: fullPath });
  const [bare, origin] = await Promise.all([
    gitValue(resolved.repositoryRoot, ['rev-parse', '--is-bare-repository']),
    gitValue(resolved.repositoryRoot, ['config', '--get', 'remote.origin.url']).catch(() => ''),
  ]);
  return {
    schema: REPOSITORY_INFO_SCHEMA,
    fullPath,
    repositoryRoot: resolved.repositoryRoot,
    gitDir: resolved.gitDirectory,
    isBare: bare === 'true',
    origin: origin || null,
  };
}