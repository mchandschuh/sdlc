import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RepositoryRootErrorCode =
  | 'REPOSITORY_ROOT_PATH_INVALID'
  | 'REPOSITORY_ROOT_NOT_FOUND'
  | 'REPOSITORY_ROOT_GIT_FAILED';

export class RepositoryRootError extends Error {
  constructor(
    readonly code: RepositoryRootErrorCode,
    message: string,
    readonly startingPath?: string,
  ) {
    super(message);
    this.name = 'RepositoryRootError';
  }
}

export interface RepositoryRootResolution {
  readonly repositoryRoot: string;
  readonly startingPath: string;
  readonly gitDirectory: string;
}

export interface RepositoryRootResolutionOptions {
  readonly startingPath?: string;
}

async function existingStartingPath(requestedPath: string): Promise<string> {
  const fullPath = resolve(requestedPath);
  let metadata;
  try {
    metadata = await stat(fullPath);
  } catch {
    throw new RepositoryRootError('REPOSITORY_ROOT_PATH_INVALID', `Path not found: ${requestedPath}`, requestedPath);
  }
  return metadata.isDirectory() ? fullPath : dirname(fullPath);
}

async function gitValue(startingPath: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', startingPath, ...args], { encoding: 'utf8' });
    return result.stdout.trim();
  } catch (error) {
    const details = `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`.trim();
    throw new RepositoryRootError(
      'REPOSITORY_ROOT_GIT_FAILED',
      details || `Git could not resolve a repository from path: ${startingPath}`,
      startingPath,
    );
  }
}

export async function resolveRepositoryRoot(
  options: RepositoryRootResolutionOptions = {},
): Promise<RepositoryRootResolution> {
  const requestedPath = options.startingPath ?? process.cwd();
  const startingPath = await existingStartingPath(requestedPath);
  let repositoryRoot: string;
  try {
    repositoryRoot = resolve(await gitValue(startingPath, ['rev-parse', '--show-toplevel']));
  } catch (error) {
    if (error instanceof RepositoryRootError && error.code === 'REPOSITORY_ROOT_GIT_FAILED') {
      throw new RepositoryRootError(
        'REPOSITORY_ROOT_NOT_FOUND',
        `No Git repository found from path: ${requestedPath}`,
        requestedPath,
      );
    }
    throw error;
  }
  const gitDirectory = resolve(await gitValue(startingPath, ['rev-parse', '--absolute-git-dir']));
  return { repositoryRoot, startingPath, gitDirectory };
}