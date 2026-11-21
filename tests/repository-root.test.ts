import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { commandContext } from '../src/core/configuration.js';
import { RepositoryRootError, resolveRepositoryRoot } from '../src/core/repository-root.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await execFileAsync('rm', ['-rf', directory]);
  }
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-repository-root-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'nested', 'directory'), { recursive: true });
  await writeFile(join(root, 'README.md'), 'fixture\n');
  await execFileAsync('git', ['-C', root, 'init', '--quiet']);
  return root;
}

describe('Git repository-root resolution', () => {
  it('resolves nested directories and files to the Git top-level root', async () => {
    const root = await repository();

    await expect(resolveRepositoryRoot({ startingPath: join(root, 'nested', 'directory') })).resolves.toEqual(expect.objectContaining({
      repositoryRoot: root,
      startingPath: join(root, 'nested', 'directory'),
    }));
    await expect(resolveRepositoryRoot({ startingPath: join(root, 'README.md') })).resolves.toEqual(expect.objectContaining({ repositoryRoot: root }));
  });

  it('fails closed outside Git repositories and supports explicit path selection', async () => {
    const root = await repository();
    const outside = await mkdtemp(join(tmpdir(), 'sdlc-not-a-repository-'));
    temporaryDirectories.push(outside);

    await expect(resolveRepositoryRoot({ startingPath: outside })).rejects.toMatchObject<RepositoryRootError>({ code: 'REPOSITORY_ROOT_NOT_FOUND' });
    await expect(resolveRepositoryRoot({ startingPath: join(root, 'nested') })).resolves.toEqual(expect.objectContaining({ repositoryRoot: root }));
  });

  it('ignores stale configured repository roots when the current path is inside Git', async () => {
    const root = await repository();
    const stale = await mkdtemp(join(tmpdir(), 'sdlc-stale-config-'));
    temporaryDirectories.push(stale);
    const application = await mkdtemp(join(tmpdir(), 'sdlc-config-application-'));
    const home = await mkdtemp(join(tmpdir(), 'sdlc-config-home-'));
    temporaryDirectories.push(application, home);
    await mkdir(join(application, '.config'), { recursive: true });
    await writeFile(join(application, '.config', 'config.json'), JSON.stringify({
      schema: 'https://schemas.handschuh.dev/sdlc/config/v1',
      repositoryRoot: stale,
    }));

    const originalCwd = process.cwd();
    try {
      process.chdir(join(root, 'nested'));
      await expect(commandContext(undefined, { applicationSourceDirectory: application, homeDirectory: home, environment: {} }))
        .resolves.toEqual(expect.objectContaining({ repositoryRoot: root }));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('resolves a Git worktree to its worktree root', async () => {
    const root = await repository();
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'sdlc-tests@example.invalid']);
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'sdlc tests']);
    await execFileAsync('git', ['-C', root, 'add', '--', 'README.md']);
    await execFileAsync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture']);
    const worktree = await mkdtemp(join(tmpdir(), 'sdlc-worktree-'));
    temporaryDirectories.push(worktree);
    await execFileAsync('git', ['-C', root, 'worktree', 'add', '--quiet', '-b', 'fixture-worktree', worktree]);

    await expect(resolveRepositoryRoot({ startingPath: worktree })).resolves.toEqual(expect.objectContaining({ repositoryRoot: worktree }));
  });
});