import { execFile, spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ALL_GIT_HOOKS } from '../scripts/git_hooks.mjs';

const execFileAsync = promisify(execFile);
const installerSource = join(process.cwd(), 'scripts/install.mjs');
const dispatcherSource = join(process.cwd(), 'scripts/git_hooks.mjs');
const cliSource = join(process.cwd(), 'bin/cli.js');
const distSource = join(process.cwd(), 'dist');
const schemasSource = join(process.cwd(), 'schemas');
const packageSource = join(process.cwd(), 'package.json');
const workItemSource = join(process.cwd(), '.docs/work-items/WI-0032');
const DOCUMENTED_GIT_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change',
];
const HOOKS = DOCUMENTED_GIT_HOOKS;

interface TestRepositoryOptions {
  readonly existingHook?: string;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return result.stdout.trim();
}

async function runProcess(command: string, args: readonly string[], options: { cwd: string; input?: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(options.input ?? '');
  });
}

async function createRepository(options: TestRepositoryOptions = {}): Promise<{ root: string; hook: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-git-hooks-'));
  const log = join(root, 'hook-cli.log');
  const scriptDirectory = join(root, 'scripts');
  const binDirectory = join(root, 'bin');
  const home = join(root, 'home');
  await mkdir(scriptDirectory, { recursive: true });
  await mkdir(binDirectory, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'sdlc-hook-fixture', version: '0.7.2', type: 'module' }));
  await writeFile(join(scriptDirectory, 'install.mjs'), await readFile(installerSource));
  await writeFile(join(scriptDirectory, 'git_hooks.mjs'), await readFile(dispatcherSource));
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
  await writeFile(join(root, 'README.md'), 'fixture baseline\n');
  const hook = join(root, '.git/hooks/pre-commit');
  if (options.existingHook !== undefined) {
    await writeFile(hook, options.existingHook);
    await chmod(hook, 0o755);
  }
  await execFileAsync(process.execPath, [join(root, 'scripts/install.mjs'), '--hooks'], { cwd: root, env: { ...process.env, HOME: home } });
  await git(root, ['add', '--', 'README.md']);
  await git(root, ['commit', '--quiet', '-m', 'fixture baseline']);
  return { root, hook, log };
}

async function stage(root: string, relativePath: string, content = 'fixture\n'): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  await git(root, ['add', '--', relativePath]);
}

async function commit(root: string, env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['-C', root, 'commit', '-m', 'test commit'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function runDispatcher(root: string, hook: string, args: readonly string[] = [], input = ''): Promise<{ code: number | null; output: string }> {
  return runProcess(process.execPath, [join(root, 'scripts/git_hooks.mjs'), 'dispatch', hook, ...args], { cwd: root, input });
}

describe('unified Git hook dispatcher', () => {
  it('defines one canonical handler name for every documented Git hook', () => {
    expect(ALL_GIT_HOOKS).toEqual(DOCUMENTED_GIT_HOOKS);
    expect(new Set(ALL_GIT_HOOKS).size).toBe(DOCUMENTED_GIT_HOOKS.length);
  });

  it('routes supported hooks and rejects unknown hook names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-dispatcher-routing-'));
    await git(root, ['init', '--quiet']);
    await git(root, ['checkout', '-b', 'main']);
    await writeFile(join(root, 'package.json'), '{}');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/git_hooks.mjs'), await readFile(dispatcherSource));
    await git(root, ['add', '--', 'package.json', 'scripts/git_hooks.mjs']);
    await git(root, ['config', 'user.email', 'sdlc-tests@example.invalid']);
    await git(root, ['config', 'user.name', 'sdlc tests']);
    await git(root, ['commit', '--quiet', '-m', 'baseline']);

    for (const hook of HOOKS) {
      const result = await runDispatcher(root, hook);
      expect(result.code, hook).toBe(0);
    }
    const unknown = await runDispatcher(root, 'unknown-hook');
    expect(unknown.code).toBe(1);
    expect(unknown.output).toContain('Unknown Git hook');
  });

  it('installs executable uniform wrappers idempotently and preserves existing content', async () => {
    const repository = await createRepository({
      existingHook: '#!/bin/sh\necho existing-hook >> "$SDLC_HOOK_EXISTING_LOG"\nexit 0\n',
    });
    const first = await Promise.all(HOOKS.map((hook) => readFile(join(repository.root, '.git/hooks', hook), 'utf8')));
    const firstMode = (await stat(repository.hook)).mode & 0o111;

    await execFileAsync(process.execPath, [join(repository.root, 'scripts/install.mjs'), '--hooks'], { cwd: repository.root, env: { ...process.env, HOME: join(repository.root, 'home') } });

    const second = await Promise.all(HOOKS.map((hook) => readFile(join(repository.root, '.git/hooks', hook), 'utf8')));
    expect(second).toEqual(first);
    expect(firstMode).not.toBe(0);
    expect(first[HOOKS.indexOf('pre-commit')]).toContain('existing-hook');
    expect(first.every((content, index) => content.includes(`git_hooks.mjs" dispatch "${HOOKS[index]}" "$@"`))).toBe(true);
    const normalized = first.map((content, index) => content.match(/# >>> sdlc managed hook >>>[\s\S]*?# <<< sdlc managed hook <<</u)?.[0]?.replace(`dispatch \"${HOOKS[index]}\"`, 'dispatch \"<hook>\"'));
    expect(new Set(normalized).size).toBe(1);
    const installedConfig = JSON.parse(await readFile(join(repository.root, 'home/.sdlc/config.json'), 'utf8')) as Record<string, unknown>;
    expect(installedConfig.repositoryRoot).toBeUndefined();
  });

  it('executes every actual installed hook wrapper and forwards the wrapper boundary', async () => {
    const repository = await createRepository();
    for (const hook of HOOKS) {
      const wrapper = join(repository.root, '.git/hooks', hook);
      expect((await stat(wrapper)).mode & 0o111, hook).not.toBe(0);
      const result = await runProcess(wrapper, ['wrapper-argument'], { cwd: repository.root, input: `stdin for ${hook}\n` });
      expect(result.code, hook).toBe(0);
    }
  });

  it('replaces legacy split installer blocks without removing unmanaged content', async () => {
    const legacy = [
      '#!/bin/sh',
      'echo unmanaged-hook >> "$SDLC_HOOK_EXISTING_LOG"',
      '# >>> sdlc work-item validation >>>',
      'node old-installer.mjs --run-hook',
      '# <<< sdlc work-item validation <<<',
      '',
    ].join('\n');
    const repository = await createRepository({ existingHook: legacy });
    const content = await readFile(repository.hook, 'utf8');
    expect(content).toContain('unmanaged-hook');
    expect(content).not.toContain('old-installer.mjs');
    expect(content).not.toContain('sdlc work-item validation');
    expect(content).toContain('git_hooks.mjs');
  });

  it('forwards the hook name, original arguments, and stdin through the wrapper', async () => {
    const repository = await createRepository();
    const received = join(repository.root, 'wrapper-received.json');
    await writeFile(join(repository.root, 'scripts/git_hooks.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => appendFileSync('wrapper-received.json', JSON.stringify({ args: process.argv.slice(2), input })));",
      '',
    ].join('\n'));
    const result = await runProcess(join(repository.root, '.git/hooks/pre-push'), ['first', 'argument with spaces'], { cwd: repository.root, input: 'push stdin\n' });
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(received, 'utf8'))).toEqual({ args: ['dispatch', 'pre-push', 'first', 'argument with spaces'], input: 'push stdin\n' });
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

  it('runs preserved unmanaged hook content before a valid work-item commit', async () => {
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

  it('installs the post-merge reminder and pre-push release behavior through dispatch', async () => {
    const repository = await createRepository();
    expect(await readFile(join(repository.root, '.git/hooks/post-merge'), 'utf8')).toContain('dispatch "post-merge"');
    expect(await readFile(join(repository.root, '.git/hooks/pre-push'), 'utf8')).toContain('dispatch "pre-push"');
    const result = await runProcess(join(repository.root, '.git/hooks/post-merge'), [], { cwd: repository.root });
    expect(result.code).toBe(0);
    expect(result.output).toContain('Post-merge reminder');
  });

  it('exercises work-item start and task-processing branch enforcement through installed hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-hook-branch-operations-'));
    const home = join(root, 'home');
    await mkdir(join(root, 'bin'), { recursive: true });
    await cp(cliSource, join(root, 'bin/cli.js'));
    await chmod(join(root, 'bin/cli.js'), 0o755);
    await cp(distSource, join(root, 'dist'), { recursive: true });
    await cp(schemasSource, join(root, 'schemas'), { recursive: true });
    await cp(packageSource, join(root, 'package.json'));
    await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(join(root, '.gitignore'), 'node_modules\nhome/\n');
    await mkdir(join(root, '.docs/work-items'), { recursive: true });
    await cp(workItemSource, join(root, '.docs/work-items/WI-0032'), { recursive: true });
    const implementationTaskPath = join(root, '.docs/work-items/WI-0032/steps/WI-0032-10000000-implementation.yaml');
    const implementationTask = await readFile(implementationTaskPath, 'utf8');
    await writeFile(implementationTaskPath, implementationTask.replace('processingStatus: processing_completed', 'processingStatus: unprocessed'));
    const workItemPath = join(root, '.docs/work-items/WI-0032/work-item.json');
    const workItem = JSON.parse(await readFile(workItemPath, 'utf8')) as { context: { branch: { created: boolean } } };
    workItem.context.branch.created = false;
    await writeFile(workItemPath, `${JSON.stringify(workItem, null, 2)}\n`);
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/install.mjs'), await readFile(installerSource));
    await writeFile(join(root, 'scripts/git_hooks.mjs'), await readFile(dispatcherSource));
    await git(root, ['init', '--quiet']);
    await git(root, ['checkout', '-b', 'main']);
    await git(root, ['config', 'user.email', 'sdlc-tests@example.invalid']);
    await git(root, ['config', 'user.name', 'sdlc tests']);
    await writeFile(join(root, 'README.md'), 'fixture baseline\n');
    await git(root, ['add', '--', 'README.md']);
    await git(root, ['commit', '--quiet', '-m', 'fixture baseline']);
    await execFileAsync(process.execPath, [join(root, 'scripts/install.mjs'), '--hooks'], { cwd: root, env: { ...process.env, HOME: home } });
    await git(root, ['add', '--', '.docs/work-items/WI-0032', '.gitignore', 'bin/cli.js', 'dist', 'package.json', 'schemas', 'scripts']);
    await git(root, ['commit', '--quiet', '-m', 'baseline WI-0032 fixture']);

    const start = await runProcess(process.execPath, [join(root, 'bin/cli.js'), 'work-item', 'start', '--work-item', 'WI-0032', '--json'], { cwd: root, env: { HOME: home } });
    expect(start.code, `${start.output}\nstatus=${await git(root, ['status', '--short'])}`).toBe(0);
    expect(start.output).toContain('"started": true');
    expect(await git(root, ['branch', '--show-current'])).toBe('WI-0032-hook-delivery-tests');

    await git(root, ['switch', 'main']);
    const taskPath = '.docs/work-items/WI-0032/steps/WI-0032-10000000-implementation.yaml';
    const taskFile = join(root, taskPath);
    const before = await readFile(taskFile, 'utf8');
    await writeFile(taskFile, before.replace('processingStatus: unprocessed', 'processingStatus: processing_completed'));
    await git(root, ['add', '--', taskPath]);
    await expect(execFileAsync('git', ['-C', root, 'commit', '-m', 'wrong branch task processing'], { encoding: 'utf8' })).rejects.toThrow();
    expect(await git(root, ['status', '--short'])).toContain(`M  ${taskPath}`);

    await git(root, ['switch', 'WI-0032-hook-delivery-tests']);
    await git(root, ['commit', '--quiet', '-m', 'process WI-0032 implementation task']);
    expect(await git(root, ['log', '-1', '--format=%s'])).toBe('process WI-0032 implementation task');
  }, 15_000);

  it('exercises the installed primary pre-push wrapper for a local no-remote revision release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-hook-local-release-'));
    const scriptDirectory = join(root, 'scripts');
    await mkdir(scriptDirectory, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.7.2', type: 'module' }));
    await writeFile(join(scriptDirectory, 'install.mjs'), await readFile(installerSource));
    await writeFile(join(scriptDirectory, 'git_hooks.mjs'), await readFile(dispatcherSource));
    await git(root, ['init', '--quiet']);
    await git(root, ['checkout', '-b', 'main']);
    await git(root, ['config', 'user.email', 'sdlc-tests@example.invalid']);
    await git(root, ['config', 'user.name', 'sdlc tests']);
    await git(root, ['add', '--', 'package.json', 'scripts']);
    await git(root, ['commit', '--quiet', '-m', 'release fixture baseline']);
    await git(root, ['tag', '--annotate', '0.7.2', '-m', 'Release 0.7.2']);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.7.3', type: 'module' }));
    await mkdir(join(root, '.docs/work-items/WI-0099'), { recursive: true });
    await writeFile(join(root, '.docs/work-items/WI-0099/work-item.json'), JSON.stringify({ status: 'complete', versionSuggestion: { impact: 'revision' } }));
    await git(root, ['add', '--', 'package.json', '.docs/work-items/WI-0099/work-item.json']);
    await git(root, ['commit', '--quiet', '-m', 'complete local revision fixture']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await git(root, ['tag', '--annotate', '0.7.3', '-m', 'Release 0.7.3']);
    await execFileAsync(process.execPath, [join(root, 'scripts/install.mjs'), '--hooks'], { cwd: root, env: { ...process.env, HOME: join(root, 'home') } });
    const tagObject = await git(root, ['rev-parse', 'refs/tags/0.7.3']);
    const baseline = await git(root, ['rev-parse', 'HEAD~1']);
    const input = [`refs/heads/main ${head} refs/heads/main ${baseline}`, `refs/tags/0.7.3 ${tagObject} refs/tags/0.7.3 ${'0'.repeat(40)}`].join('\n') + '\n';
    const result = await runProcess(join(root, '.git/hooks/pre-push'), ['origin'], { cwd: root, input });
    expect(result.code).toBe(0);
  });

  it('rejects a primary push when package.json is ahead of calculated impact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-release-ahead-hook-'));
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/git_hooks.mjs'), await readFile(dispatcherSource));
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.9.0' }));
    await git(root, ['init', '--quiet']);
    await git(root, ['checkout', '-b', 'main']);
    await git(root, ['config', 'user.email', 'sdlc-tests@example.invalid']);
    await git(root, ['config', 'user.name', 'sdlc tests']);
    await git(root, ['add', '--', 'package.json', 'scripts/git_hooks.mjs']);
    await git(root, ['commit', '--quiet', '-m', 'baseline']);
    await git(root, ['tag', '--annotate', '0.7.0', '-m', 'Release 0.7.0']);
    const baseline = await git(root, ['rev-parse', 'HEAD']);
    await mkdir(join(root, '.docs/work-items/WI-0099'), { recursive: true });
    await writeFile(join(root, '.docs/work-items/WI-0099/work-item.json'), JSON.stringify({ status: 'complete', versionSuggestion: { impact: 'minor' } }));
    await git(root, ['add', '--', '.docs/work-items/WI-0099/work-item.json']);
    await git(root, ['commit', '--quiet', '-m', 'complete work item']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    const result = await runDispatcher(root, 'pre-push', ['origin'], `refs/heads/main ${head} refs/heads/main ${baseline}\n`);
    expect(result.code).toBe(1);
    expect(result.output).toContain('package.json contains 0.9.0');
  });
});