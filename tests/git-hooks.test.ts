import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const installerSource = join(process.cwd(), 'scripts/install_sdlc_validate_git_hooks.mjs');

interface TestRepositoryOptions {
  readonly existingHook?: string;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return result.stdout.trim();
}

async function createRepository(options: TestRepositoryOptions = {}): Promise<{ root: string; hook: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-git-hooks-'));
  const log = join(root, 'hook-cli.log');
  const scriptDirectory = join(root, 'scripts');
  const binDirectory = join(root, 'bin');
  await mkdir(scriptDirectory, { recursive: true });
  await mkdir(binDirectory, { recursive: true });
  await writeFile(join(scriptDirectory, 'install_sdlc_validate_git_hooks.mjs'), await readFile(installerSource));
  await writeFile(join(binDirectory, 'cli.js'), [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "const workItemId = args[args.indexOf('--work-item') + 1];",
    "const log = process.env.SDLC_HOOK_CLI_LOG;",
    "if (log) appendFileSync(log, `${workItemId}\\n`);",
    "const failed = (process.env.SDLC_HOOK_FAIL_IDS ?? '').split(',').filter(Boolean).includes(workItemId);",
    "process.stdout.write(JSON.stringify({ schema: 'sdlc-work-item-validation/v1', workItemId, valid: !failed, findings: failed ? ['invalid fixture'] : [] }) + '\\n');",
    "if (failed) process.stderr.write(`validation stderr for ${workItemId}\\n`);",
    'process.exitCode = failed ? 1 : 0;',
    '',
  ].join('\n'));
  await chmod(join(binDirectory, 'cli.js'), 0o755);
  await git(root, ['init', '--quiet']);
  await git(root, ['config', 'user.email', 'sdlc-tests@example.invalid']);
  await git(root, ['config', 'user.name', 'sdlc tests']);
  const hook = join(root, '.git/hooks/pre-commit');
  if (options.existingHook !== undefined) {
    await writeFile(hook, options.existingHook);
    await chmod(hook, 0o755);
  }
  await execFileAsync(process.execPath, [join(root, 'scripts/install_sdlc_validate_git_hooks.mjs')], { cwd: root });
  return { root, hook, log };
}

async function stage(root: string, relativePath: string, content = 'fixture\n'): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  await git(root, ['add', '--', relativePath]);
}

async function commit(root: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['-C', root, 'commit', '-m', 'test commit'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function runPrePush(root: string, input: string): Promise<{ readonly code: number | null; readonly output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/install_sdlc_validate_git_hooks.mjs'), '--pre-push', 'origin'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

describe('install_sdlc_validate_git_hooks.mjs', () => {
  it('installs an executable hook idempotently and preserves existing hook content', async () => {
    const repository = await createRepository({
      existingHook: '#!/bin/sh\necho existing-hook >> "$SDLC_HOOK_EXISTING_LOG"\nexit 0\n',
    });
    const first = await readFile(repository.hook, 'utf8');
    const firstMode = (await stat(repository.hook)).mode & 0o111;

    await execFileAsync(process.execPath, [join(repository.root, 'scripts/install_sdlc_validate_git_hooks.mjs')], { cwd: repository.root });

    expect(await readFile(repository.hook, 'utf8')).toBe(first);
    expect(firstMode).not.toBe(0);
    expect(first).toContain('existing-hook');
    expect(first.match(/sdlc work-item validation >>>/gu)).toHaveLength(1);
  });

  it('skips unrelated commits and validates each staged work item once', async () => {
    const repository = await createRepository();
    await stage(repository.root, 'README.md');
    await commit(repository.root, { SDLC_HOOK_CLI_LOG: repository.log });
    expect(await readFile(repository.log).catch(() => '')).toBe('');

    await stage(repository.root, '.docs/work-items/WI-0002/work-item.json');
    await stage(repository.root, '.docs/work-items/WI-0001/steps/task.yaml');
    await commit(repository.root, { SDLC_HOOK_CLI_LOG: repository.log });
    expect(await readFile(repository.log, 'utf8')).toBe('WI-0001\nWI-0002\n');
  });

  it('prints the complete validation response, blocks the commit, and leaves staged files unchanged', async () => {
    const repository = await createRepository();
    const relativePath = '.docs/work-items/WI-0099/work-item.json';
    const content = '{"invalid":true}\n';
    await stage(repository.root, relativePath, content);

    let failure: { stdout?: string; stderr?: string } | undefined;
    try {
      await commit(repository.root, { SDLC_HOOK_CLI_LOG: repository.log, SDLC_HOOK_FAIL_IDS: 'WI-0099' });
    } catch (error) {
      failure = error as { stdout?: string; stderr?: string };
    }

    expect(failure).toBeDefined();
    const output = `${failure?.stdout ?? ''}${failure?.stderr ?? ''}`;
    expect(output).toContain('"workItemId":"WI-0099"');
    expect(output).toContain('"valid":false');
    expect(output).toContain('validation stderr for WI-0099');
    expect(await readFile(join(repository.root, relativePath), 'utf8')).toBe(content);
    expect(await git(repository.root, ['status', '--short'])).toContain(`A  ${relativePath}`);
  });

  it('runs the preserved hook body before allowing a valid work-item commit', async () => {
    const repository = await createRepository({
      existingHook: '#!/bin/sh\necho existing-hook >> "$SDLC_HOOK_EXISTING_LOG"\nexit 0\n',
    });
    await stage(repository.root, '.docs/work-items/WI-0003/work-item.json');
    await commit(repository.root, {
      SDLC_HOOK_CLI_LOG: repository.log,
      SDLC_HOOK_EXISTING_LOG: join(repository.root, 'existing-hook.log'),
    });

    expect(await readFile(join(repository.root, 'existing-hook.log'), 'utf8')).toBe('existing-hook\n');
    expect(await readFile(repository.log, 'utf8')).toBe('WI-0003\n');
  });

  it('installs all managed hooks with --hooks idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-all-hooks-'));
    await mkdir(join(root, 'scripts'), { recursive: true });
    const installer = join(root, 'scripts', 'install.mjs');
    await writeFile(installer, await readFile(join(process.cwd(), 'scripts/install.mjs')));
    await git(root, ['init', '--quiet']);
    await writeFile(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho unmanaged-hook\n');
    await execFileAsync(process.execPath, [installer, '--hooks'], { cwd: root, env: { ...process.env, HOME: join(root, 'home') } });
    const hooks = ['applypatch-msg', 'commit-msg', 'post-update', 'pre-applypatch', 'pre-commit', 'pre-merge-commit', 'pre-push', 'pre-rebase', 'pre-receive', 'prepare-commit-msg', 'push-to-checkout', 'update'];
    const contents = await Promise.all(hooks.map(async (hook) => readFile(join(root, '.git', 'hooks', hook), 'utf8')));
    expect(contents.every((content) => content.includes('# >>> sdlc managed hook >>>'))).toBe(true);
    expect(contents[hooks.indexOf('pre-commit')]).toContain('unmanaged-hook');
    const before = contents;
    await execFileAsync(process.execPath, [installer, '--hooks'], { cwd: root, env: { ...process.env, HOME: join(root, 'home') } });
    expect(await Promise.all(hooks.map(async (hook) => readFile(join(root, '.git', 'hooks', hook), 'utf8')))).toEqual(before);
  });

  it('installs completion and primary-release hook blocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-completion-hooks-'));
    await mkdir(join(root, 'scripts'), { recursive: true });
    const installer = join(root, 'scripts', 'install_sdlc_validate_git_hooks.mjs');
    await writeFile(installer, await readFile(installerSource));
    await git(root, ['init', '--quiet']);
    await execFileAsync(process.execPath, [installer], { cwd: root });
    expect(await readFile(join(root, '.git', 'hooks', 'post-merge'), 'utf8')).toContain('sdlc work-item completion reminder');
    expect(await readFile(join(root, '.git', 'hooks', 'pre-push'), 'utf8')).toContain('sdlc primary release validation');
  });

  it('blocks staged task processing on the wrong branch', async () => {
    const repository = await createRepository();
    await stage(repository.root, '.docs/work-items/WI-0099/work-item.json', JSON.stringify({
      workItemId: 'WI-0099',
      context: { mergeTarget: { branch: 'main' }, branch: { name: 'WI-0099-feature', created: true } },
    }));
    await stage(repository.root, '.docs/work-items/WI-0099/steps/WI-0099-10000000.yaml', 'processingStatus: unprocessed\n');
    await commit(repository.root);
    await stage(repository.root, '.docs/work-items/WI-0099/steps/WI-0099-10000000.yaml', 'processingStatus: processing_in_progress\n');
    await expect(commit(repository.root)).rejects.toThrow();
  });

  it('enforces deterministic minor release version and annotated tag on primary push', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-release-hook-'));
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/install_sdlc_validate_git_hooks.mjs'), await readFile(installerSource));
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.8.0' }));
    await git(root, ['init', '--quiet']);
    await git(root, ['checkout', '-b', 'main']);
    await git(root, ['config', 'user.email', 'sdlc-tests@example.invalid']);
    await git(root, ['config', 'user.name', 'sdlc tests']);
    await git(root, ['add', '--', 'package.json', 'scripts/install_sdlc_validate_git_hooks.mjs']);
    await git(root, ['commit', '--quiet', '-m', 'baseline']);
    await git(root, ['tag', '--annotate', '0.7.0', '-m', 'Release 0.7.0']);
    const baseline = await git(root, ['rev-parse', 'HEAD']);
    await mkdir(join(root, '.docs/work-items/WI-0099'), { recursive: true });
    await writeFile(join(root, '.docs/work-items/WI-0099/work-item.json'), JSON.stringify({ status: 'complete', versionSuggestion: { impact: 'minor' } }));
    await git(root, ['add', '--', '.docs/work-items/WI-0099/work-item.json']);
    await git(root, ['commit', '--quiet', '-m', 'complete work item']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await git(root, ['tag', '--annotate', '0.8.0', '-m', 'Release 0.8.0']);
    const tagObject = await git(root, ['rev-parse', 'refs/tags/0.8.0']);
    const input = [`refs/heads/main ${head} refs/heads/main ${baseline}`, `refs/tags/0.8.0 ${tagObject} refs/tags/0.8.0 ${'0'.repeat(40)}`].join('\n') + '\n';
    const result = await runPrePush(root, input);
    expect(result.code).toBe(0);
  });

  it('rejects a primary push when package.json is ahead of calculated impact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-release-ahead-hook-'));
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/install_sdlc_validate_git_hooks.mjs'), await readFile(installerSource));
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.9.0' }));
    await git(root, ['init', '--quiet']);
    await git(root, ['checkout', '-b', 'main']);
    await git(root, ['config', 'user.email', 'sdlc-tests@example.invalid']);
    await git(root, ['config', 'user.name', 'sdlc tests']);
    await git(root, ['add', '--', 'package.json', 'scripts/install_sdlc_validate_git_hooks.mjs']);
    await git(root, ['commit', '--quiet', '-m', 'baseline']);
    await git(root, ['tag', '--annotate', '0.7.0', '-m', 'Release 0.7.0']);
    const baseline = await git(root, ['rev-parse', 'HEAD']);
    await mkdir(join(root, '.docs/work-items/WI-0099'), { recursive: true });
    await writeFile(join(root, '.docs/work-items/WI-0099/work-item.json'), JSON.stringify({ status: 'complete', versionSuggestion: { impact: 'minor' } }));
    await git(root, ['add', '--', '.docs/work-items/WI-0099/work-item.json']);
    await git(root, ['commit', '--quiet', '-m', 'complete work item']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    const result = await runPrePush(root, `refs/heads/main ${head} refs/heads/main ${baseline}\n`);
    expect(result.code).toBe(1);
    expect(result.output).toContain('package.json contains 0.9.0');
  });

  it('installs a default user config without overwriting an existing config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-config-install-'));
    await mkdir(join(root, 'scripts'), { recursive: true });
    const installer = join(root, 'scripts', 'install.mjs');
    await writeFile(installer, await readFile(join(process.cwd(), 'scripts/install.mjs')));
    await git(root, ['init', '--quiet']);
    const home = join(root, 'home');
    const environment = { ...process.env, HOME: home };
    await execFileAsync(process.execPath, [installer], { cwd: root, env: environment });
    const configPath = join(home, '.sdlc', 'config.json');
    const first = await readFile(configPath, 'utf8');
    expect(JSON.parse(first)).toEqual(expect.objectContaining({
      schema: 'https://schemas.handschuh.dev/sdlc/config/v1',
      repositoryRoot: root,
    }));
    await execFileAsync(process.execPath, [installer], { cwd: root, env: environment });
    expect(await readFile(configPath, 'utf8')).toBe(first);
  });
});