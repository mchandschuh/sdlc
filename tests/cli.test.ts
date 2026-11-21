import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { main } from '../src/cli/main.js';
import { discoverNextTask, discoverTasks, discoverWorkItems, DiscoveryError, enumerateWorkItemObjects, SUPPORTED_WORK_ITEM_OBJECT_EXTENSIONS, statTrackedPath } from '../src/core/discovery.js';
import { discoverReferenceSchemas } from '../src/core/reference.js';
import { validateWorkItem } from '../src/core/work-item-validation.js';
import { repositoryInfo } from '../src/core/repository.js';
import { commandContext, resolveSdlcConfig } from '../src/core/configuration.js';

const execFileAsync = promisify(execFile);

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI interface', () => {
  it.each(['-h', '--help'])('prints help for %s', async (argument) => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main([argument])).resolves.toBe(0);

    expect(output.join('\n')).toContain('Usage: sdlc [options]');
    expect(output.join('\n')).toContain('-h, --help');
    expect(output.join('\n')).toContain('-v, --version');
  });

  it('exposes work-item start help', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['work-item', 'start', '--help'])).resolves.toBe(0);

    expect(output.join('\n')).toContain('Usage: sdlc work-item start --work-item <work-item>');
  });

  it('resolves repository-dependent commands from a nested CWD repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-operative-root-'));
    const nested = join(root, 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'README.md'), 'separate repository\n');
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    await execFileAsync('git', ['-C', root, 'add', '--', 'README.md']);

    const originalCwd = process.cwd();
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    try {
      process.chdir(nested);
      await expect(main(['stat', '--path', 'README.md', '--json'])).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    const report = JSON.parse(output.join('\n')) as { repositoryPath: string; fullPath: string; tracked: boolean };
    expect(report.repositoryPath).toBe('README.md');
    expect(report.fullPath).toBe(join(root, 'README.md'));
    expect(report.tracked).toBe(true);
  });

  it('fails repository-dependent commands outside any Git repository', async () => {
    const originalCwd = process.cwd();
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));
    try {
      process.chdir(tmpdir());
      await expect(main(['stat', '--path', 'README.md'])).resolves.toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
    expect(errors.at(-1)).toContain('No Git repository found from path');
  });

  it('resolves configuration provenance without using a configured repository root fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-config-precedence-'));
    const application = join(root, 'application');
    const home = join(root, 'home');
    const environmentRoot = join(root, 'environment');
    const applicationRepository = join(root, 'application-repository');
    const homeRepository = join(root, 'home-repository');
    const environmentRepository = join(root, 'environment-repository');
    await Promise.all([
      mkdir(join(application, '.config'), { recursive: true }),
      mkdir(join(home, '.sdlc'), { recursive: true }),
      mkdir(environmentRoot, { recursive: true }),
      mkdir(applicationRepository, { recursive: true }),
      mkdir(homeRepository, { recursive: true }),
      mkdir(environmentRepository, { recursive: true }),
    ]);
    const config = (repositoryRoot: string) => JSON.stringify({ schema: 'https://schemas.handschuh.dev/sdlc/config/v1', repositoryRoot });
    await writeFile(join(application, '.config', 'config.json'), config(applicationRepository));
    await writeFile(join(home, '.sdlc', 'config.json'), config(homeRepository));
    await writeFile(join(environmentRoot, 'config.json'), config(environmentRepository));
    const options = { applicationSourceDirectory: application, homeDirectory: home, environment: { SDLC_CONFIG: environmentRoot } };
    await expect(resolveSdlcConfig(options)).resolves.toEqual(expect.objectContaining({
      config: expect.objectContaining({ repositoryRoot: environmentRepository }),
      source: 'environment',
      sourcePath: join(environmentRoot, 'config.json'),
    }));
    await execFileAsync('git', ['-C', applicationRepository, 'init', '--quiet']);
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(commandContext(undefined, options)).rejects.toThrow('No Git repository found from path');
      await expect(commandContext(applicationRepository, options)).resolves.toEqual(expect.objectContaining({ repositoryRoot: applicationRepository }));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('rejects invalid configured paths before selecting a repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-invalid-config-'));
    const application = join(root, 'application');
    await mkdir(join(application, '.config'), { recursive: true });
    await writeFile(join(application, '.config', 'config.json'), JSON.stringify({ schema: 'https://schemas.handschuh.dev/sdlc/config/v1', repositoryRoot: '../outside' }));
    await expect(resolveSdlcConfig({ applicationSourceDirectory: application, homeDirectory: join(root, 'home'), environment: {} })).rejects.toThrow('repositoryRoot must be an absolute path without parent traversal.');
  });

  it('prints repository-dependent command help without requiring a Git repository', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      await expect(main(['stat', '--help'])).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
    expect(output.join('\n')).toContain('Usage: sdlc stat --path <file-path>');
  });

  it('prints help when no option is supplied', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main([])).resolves.toBe(0);

    expect(output.join('\n')).toContain('Usage: sdlc [options]');
  });

  it('fails with a stable message for an unknown option', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));

    await expect(main(['--unknown'])).resolves.toBe(2);

    expect(errors).toEqual([
      'Unknown option: --unknown',
      'Run "sdlc --help" to see available options.',
    ]);
  });

  it('documents and validates reference command errors', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));

    await expect(main(['ref', 'validate', '--help'])).resolves.toBe(0);
    expect(output.join('\n')).toContain('Usage: sdlc ref validate --ref <reference>');
    await expect(main(['ref', 'validate'])).resolves.toBe(1);
    expect(errors.at(-1)).toBe('Usage: sdlc ref validate --ref <reference>');
    await expect(main(['ref', 'validate', '--ref', '#not-a-reference'])).resolves.toBe(1);
    const invalid = JSON.parse(output.at(-1)!) as { valid: boolean; findings: string[] };
    expect(invalid.valid).toBe(false);
    expect(invalid.findings).toContain('No registered reference schema matched the supplied reference.');
  });

  it.each([
    ['ref resolve', 'Usage: sdlc ref resolve --ref <reference> [--depth [positive-integer]] [--json]'],
    ['ref migrate-task-local-up', 'Usage: sdlc ref migrate-task-local-up [--path <path> | --work-item <work-item-id>] [--json]'],
  ])('exposes generated help for %s', async (command, usage) => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main([...command.split(' '), '--help'])).resolves.toBe(0);

    expect(output.join('\n')).toContain(usage);
  });

  it.each([
    ['WI-0001', 'https://schemas.handschuh.dev/sdlc/work-item-id/v1'],
    ['WI-0001-80000000', 'https://schemas.handschuh.dev/sdlc/task-uid/v1'],
    ['WI-0001_REQ_001', 'https://schemas.handschuh.dev/sdlc/requirement-identifier/v1'],
    ['WI-0001_REQ_001_AC_001', 'https://schemas.handschuh.dev/sdlc/acceptance-criterion-identifier/v1'],
  ])('validates bare identity reference %s', async (ref, schemaId) => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['ref', 'validate', '--ref', ref])).resolves.toBe(0);

    const report = JSON.parse(output.join('\n')) as { valid: boolean; matches: Array<{ schemaId: string }> };
    expect(report.valid).toBe(true);
    expect(report.matches.some((match) => match.schemaId === schemaId)).toBe(true);
  });

  it('returns global resource identity and repository path for canonical task-owned identifiers', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['ref', 'validate', '--ref', 'WI-0026-10000000_OBJ-001', '--json'])).resolves.toBe(0);
    const validation = JSON.parse(output.at(-1)!) as { valid: boolean; globalResourceId: string; repositoryRoot: string; fullPath: string; repositoryPath: string };
    expect(validation).toEqual(expect.objectContaining({
      valid: true,
      globalResourceId: 'sdlc://repo/github.com%2Fmchandschuh%2Fsdlc/WI-0026-10000000#objective/WI-0026-10000000_OBJ-001',
      repositoryRoot: process.cwd(),
      fullPath: join(process.cwd(), '.docs/work-items/WI-0026/steps/WI-0026-10000000-repository-identifier-implementation.yaml'),
      repositoryPath: '.docs/work-items/WI-0026/steps/WI-0026-10000000-repository-identifier-implementation.yaml',
    }));

    await expect(main(['ref', 'resolve', '--ref', 'WI-0026-10000000_OBJ-001', '--json'])).resolves.toBe(0);
    const resolution = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: { globalResourceId: string; repositoryPath: string; data: { id: string } } };
    expect(resolution.valid).toBe(true);
    expect(resolution.resolution).toEqual(expect.objectContaining({
      globalResourceId: validation.globalResourceId,
      repositoryPath: validation.repositoryPath,
      data: expect.objectContaining({ id: 'WI-0026-10000000_OBJ-001' }),
    }));
  });

  it('validates an external repository without a local schemas directory when explicitly selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-external-validation-'));
    const item = join(root, '.docs', 'work-items', 'BTCUSD-0000');
    await mkdir(join(item, 'steps'), { recursive: true });
    await writeFile(join(item, 'work-item.json'), JSON.stringify({
      schema: 'https://schemas.handschuh.dev/sdlc/work-item/v2',
      workItemId: 'BTCUSD-0000',
      status: 'planned',
      title: 'External fixture',
      objective: 'Validate an external repository without vendored schemas.',
      repository: { root, authority: 'local' },
      context: { mergeTarget: { branch: 'main' }, branch: { name: 'BTCUSD-0000-fixture', created: false, rationale: 'fixture' } },
      request: { source: 'conversation', text: 'fixture', sha256: '0'.repeat(64) },
      scope: [{ name: 'external-fixture', description: 'fixture', reason: 'fixture' }],
      nonGoals: [{ name: 'none', description: 'none', reason: 'fixture', forbiddenFileWrites: [], forbiddenFileReads: [] }],
      requirements: { items: [{ id: 'BTCUSD-0000_REQ_001', name: 'fixture', description: 'fixture', reason: 'fixture', acceptanceCriteria: [{ id: 'BTCUSD-0000_REQ_001_AC_001', description: 'fixture' }] }] },
      stepsPath: '.docs/work-items/BTCUSD-0000/steps/',
    }, null, 2));
    const before = await readFile(join(item, 'work-item.json'), 'utf8');
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    await execFileAsync('git', ['-C', root, 'checkout', '-b', 'main']);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    await expect(main(['work-item', 'validate', '--work-item', 'BTCUSD-0000', '--repository-root', root, '--json'])).resolves.toBe(0);
    const report = JSON.parse(output.at(-1)!) as { valid: boolean; workItemId: string; invalidObjectCount: number };
    expect(report).toEqual(expect.objectContaining({ valid: true, workItemId: 'BTCUSD-0000', invalidObjectCount: 0 }));
    expect(await readFile(join(item, 'work-item.json'), 'utf8')).toBe(before);
  });

  it('resolves every canonical task-owned identifier prefix directly', async () => {
    const prefixes = ['INPUT', 'OBJ', 'TARGET', 'VAL', 'TC', 'CHANGE', 'EXEC', 'ART', 'FIND', 'PROC', 'INV', 'R', 'O', 'Q', 'UQ'] as const;
    const root = await mkdtemp(join(tmpdir(), 'sdlc-task-owned-prefixes-'));
    const workItem = join(root, '.docs', 'work-items', 'WI-0099');
    const steps = join(workItem, 'steps');
    await mkdir(steps, { recursive: true });
    await writeFile(join(workItem, 'work-item.json'), JSON.stringify({
      workItemId: 'WI-0099',
      status: 'planned',
      title: 'Task-owned identifier fixture',
      stepsPath: '.docs/work-items/WI-0099/steps/',
    }));
    await writeFile(join(steps, 'WI-0099-10000000-fixture.yaml'), [
      'schema: https://schemas.handschuh.dev/sdlc/task-envelope/v1',
      'workItemId: WI-0099',
      'taskUid: WI-0099-10000000',
      "orderKey: '10000000'",
      'parentTaskUid: null',
      'taskType: implementation',
      'processingStatus: unprocessed',
      'title: Task-owned fixture',
      'objective: Task-owned fixture',
      'references:',
      '  required: []',
      '  informational: []',
      'dependsOn: []',
      'task:',
      '  status: planned',
      '  intent:',
      '    objectives:',
      `      - id: WI-0099-10000000_OBJ-001`,
      '        statement: objective',
      '    inputs:',
      `      - id: WI-0099-10000000_INPUT-001`,
      '        kind: artifact',
      '    targets:',
      `      - id: WI-0099-10000000_TARGET-001`,
      '        kind: artifact',
      '    procedures:',
      `      - id: WI-0099-10000000_VAL-001`,
      '        name: procedure',
      '    testCaseRefs:',
      `      - '#test-case/WI-0099-10000000_TC-001'`,
      '  result:',
      '    implementation:',
      '      changes:',
      `        - id: WI-0099-10000000_CHANGE-001`,
      '          type: production-code',
      '    verification:',
      '      tests:',
      `        - id: WI-0099-10000000_EXEC-001`,
      '          status: passed',
      '    artifacts:',
      `      - id: WI-0099-10000000_ART-001`,
      '        name: artifact',
      '    findings:',
      `      - id: WI-0099-10000000_FIND-001`,
      '        summary: finding',
      '    procedures:',
      `      - id: WI-0099-10000000_PROC-001`,
      '        name: procedure',
      '    invariants:',
      `      - id: WI-0099-10000000_INV-001`,
      '        statement: invariant',
      '    results:',
      `      - id: WI-0099-10000000_R-001`,
      '        summary: result',
      '    outcomes:',
      `      - id: WI-0099-10000000_O-001`,
      '        summary: outcome',
      '    questions:',
      `      - id: WI-0099-10000000_Q-001`,
      '        question: question',
      '    unresolvedQuestions:',
      `      - id: WI-0099-10000000_UQ-001`,
      '        question: unresolved',
      '',
    ].join('\n'));
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    await execFileAsync('git', ['-C', root, 'checkout', '-b', 'main']);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      for (const prefix of prefixes) {
        const ref = `WI-0099-10000000_${prefix}-001`;
        output.length = 0;
        await expect(main(['ref', 'validate', '--ref', ref, '--json'])).resolves.toBe(0);
        const validation = JSON.parse(output.at(-1)!) as { valid: boolean; globalResourceId?: string; repositoryRoot?: string; fullPath?: string; repositoryPath?: string };
        expect(validation.valid, ref).toBe(true);
        expect(validation.globalResourceId, ref).toContain(`WI-0099-10000000#`);
        expect(validation.repositoryRoot, ref).toBe(root);
        expect(validation.fullPath, ref).toBe(join(steps, 'WI-0099-10000000-fixture.yaml'));
        expect(validation.repositoryPath, ref).toBe('.docs/work-items/WI-0099/steps/WI-0099-10000000-fixture.yaml');
        await expect(main(['ref', 'resolve', '--ref', ref, '--json'])).resolves.toBe(0);
        const resolution = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: { globalResourceId: string; fullPath: string; repositoryPath: string; data: unknown } };
        expect(resolution.valid, ref).toBe(true);
        expect(resolution.resolution.globalResourceId, ref).toBe(validation.globalResourceId);
        expect(resolution.resolution.fullPath, ref).toBe(validation.fullPath);
        expect(resolution.resolution.repositoryPath, ref).toBe(validation.repositoryPath);
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('validates every root example from every marked reference schema', async () => {
    const schemas = await discoverReferenceSchemas(process.cwd());
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema.examples.length, `${schema.path} must provide examples`).toBeGreaterThan(0);
      for (const example of schema.examples) {
        const output: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
        await expect(main(['ref', 'validate', '--ref', example])).resolves.toBe(0);
        const report = JSON.parse(output.at(-1)!) as { valid: boolean; matches: Array<{ schemaId: string }> };
        expect(report.valid, `${schema.path} example ${example}`).toBe(true);
        expect(report.matches.some((match) => match.schemaId === schema.id), `${schema.path} example ${example}`).toBe(true);
        vi.restoreAllMocks();
      }
    }
  });

  it('confirms work-item.json is the authoritative requirement declaration source', async () => {
    const repositoryRoot = process.cwd();
    const workItemFiles = (await filesUnder(join(repositoryRoot, '.docs', 'work-items')))
      .filter((path) => path.endsWith('/work-item.json'));
    expect(workItemFiles.length).toBeGreaterThan(0);
    for (const path of workItemFiles) {
      const workItem = JSON.parse(await readFile(path, 'utf8')) as { requirements?: { items?: Array<{ id?: string }> } };
      expect(Array.isArray(workItem.requirements?.items), path).toBe(true);
      for (const requirement of workItem.requirements!.items!) expect(requirement.id, path).toMatch(/^[A-Z]{1,10}-[0-9]+_REQ_[0-9]{3,}$/u);
    }

    const taskFiles = (await filesUnder(join(repositoryRoot, '.docs', 'work-items')))
      .filter((path) => path.endsWith('.yaml') || path.endsWith('.yml'));
    for (const path of taskFiles) {
      const task = YAML.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      expect(Object.hasOwn(task, 'requirements'), path).toBe(false);
    }

    const requirementSchemaFiles = (await filesUnder(join(repositoryRoot, 'schemas')))
      .filter((path) => path.endsWith('.schema.json'));
    const rootRequirementSchemas = requirementSchemaFiles.filter((path) => {
      const schema = JSON.parse(readFileSync(path, 'utf8')) as { properties?: Record<string, unknown> };
      return Object.hasOwn(schema.properties ?? {}, 'requirements');
    }).map((path) => path.slice(repositoryRoot.length + 1).split('\\').join('/')).sort();
    expect(rootRequirementSchemas).toEqual([
      'schemas/work-item-assessment/v1/work-item-assessment.schema.json',
      'schemas/work-item-requirements/v1/sdlc-work-item-requirements.schema.json',
      'schemas/work-item/v2/work-item.schema.json',
      'schemas/work-item/v3/work-item.schema.json',
    ]);
  });

  it('uses the installed reference schema registry outside a repository', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      await expect(main(['ref', 'validate', '--ref', 'WI-0001'])).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
    const report = JSON.parse(output.join('\n')) as { valid: boolean; matches: Array<{ schemaId: string }> };
    expect(report.valid).toBe(true);
    expect(report.matches.some((match) => match.schemaId === 'https://schemas.handschuh.dev/sdlc/work-item-id/v1')).toBe(true);
  });

  it('resolves bare work-item and task references to absolute documents and data', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['ref', 'resolve', '--ref', 'WI-0007'])).resolves.toBe(0);
    const workItem = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: { fullPath: string; repositoryPath: string; format: string; data: { workItemId: string } } };
    expect(workItem.valid).toBe(true);
    expect(workItem.resolution.fullPath).toBe(join(process.cwd(), '.docs/work-items/WI-0007/work-item.json'));
    expect(workItem.resolution.repositoryPath).toBe('.docs/work-items/WI-0007/work-item.json');
    expect(workItem.resolution.format).toBe('json');
    expect(workItem.resolution.data.workItemId).toBe('WI-0007');

    await expect(main(['ref', 'resolve', '--ref', 'WI-0007-10000000'])).resolves.toBe(0);
    const task = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: { fullPath: string; repositoryPath: string; format: string; data: { taskUid: string } } };
    expect(task.valid).toBe(true);
    expect(task.resolution.fullPath).toBe(join(process.cwd(), '.docs/work-items/WI-0007/steps/WI-0007-10000000-implementation.yaml'));
    expect(task.resolution.repositoryPath).toBe('.docs/work-items/WI-0007/steps/WI-0007-10000000-implementation.yaml');
    expect(task.resolution.format).toBe('yaml');
    expect(task.resolution.data.taskUid).toBe('WI-0007-10000000');
  });

  it('resolves a bare requirement identifier from authoritative work-item.json data', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const before = await readFile('.docs/work-items/WI-0023/work-item.json', 'utf8');

    await expect(main(['ref', 'resolve', '--ref', 'WI-0023_REQ_001'])).resolves.toBe(0);

    const requirement = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: { repositoryPath: string; format: string; data: { id: string; name: string; description: string; reason: string; acceptanceCriteria: unknown[] } } };
    expect(requirement.valid).toBe(true);
    expect(requirement.resolution.repositoryPath).toBe('.docs/work-items/WI-0023/work-item.json');
    expect(requirement.resolution.format).toBe('json');
    expect(requirement.resolution.data).toEqual(expect.objectContaining({
      id: 'WI-0023_REQ_001',
      name: 'requirement-authority',
      description: expect.any(String),
      reason: expect.any(String),
      acceptanceCriteria: expect.any(Array),
    }));
    expect(await readFile('.docs/work-items/WI-0023/work-item.json', 'utf8')).toBe(before);
  });

  it('resolves a bare acceptance-criterion identifier from authoritative work-item.json data', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const before = await readFile('.docs/work-items/WI-0002/work-item.json', 'utf8');

    await expect(main(['ref', 'resolve', '--ref', 'WI-0002_REQ_001_AC_001'])).resolves.toBe(0);

    const criterion = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: { repositoryPath: string; format: string; data: { id: string; description: string } } };
    expect(criterion.valid).toBe(true);
    expect(criterion.resolution.repositoryPath).toBe('.docs/work-items/WI-0002/work-item.json');
    expect(criterion.resolution.format).toBe('json');
    expect(criterion.resolution.data).toEqual(expect.objectContaining({ id: 'WI-0002_REQ_001_AC_001', description: expect.any(String) }));
    expect(await readFile('.docs/work-items/WI-0002/work-item.json', 'utf8')).toBe(before);
  });

  it.each(['WI-0002_REQ_001_AC_01', 'WI-0002_REQ_001_AC_ABC'])('rejects malformed bare acceptance-criterion identifier %s', async (ref) => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    await expect(main(['ref', 'validate', '--ref', ref])).resolves.toBe(1);
    expect((JSON.parse(output.at(-1)!) as { valid: boolean }).valid).toBe(false);
  });

  it('resolves a bare requirement identifier from a nested repository CWD', async () => {
    const nested = join(process.cwd(), '.docs', 'work-items', 'WI-0023', 'steps');
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(nested);
      await expect(main(['ref', 'resolve', '--ref', 'WI-0023_REQ_002'])).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
    const requirement = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: { repositoryPath: string; data: { id: string } } };
    expect(requirement.valid).toBe(true);
    expect(requirement.resolution.repositoryPath).toBe('.docs/work-items/WI-0023/work-item.json');
    expect(requirement.resolution.data.id).toBe('WI-0023_REQ_002');
  });

  it.each(['WI-0001_REQ_01', 'WI-0001_REQ_0001', 'WI-0001-REQ-001', 'WI-0001_REQ_ABC'])('rejects malformed bare requirement identifier %s', async (ref) => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    await expect(main(['ref', 'validate', '--ref', ref])).resolves.toBe(1);
    expect((JSON.parse(output.at(-1)!) as { valid: boolean }).valid).toBe(false);
  });

  it('reports missing and duplicate requirement identifiers without mutating the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-requirement-resolution-'));
    const workItemDirectory = join(root, '.docs', 'work-items', 'WI-0099');
    await mkdir(workItemDirectory, { recursive: true });
    const workItemPath = join(workItemDirectory, 'work-item.json');
    const fixture = JSON.stringify({ requirements: { items: [
      { id: 'WI-0099_REQ_001', name: 'first', description: 'first', reason: 'first', acceptanceCriteria: [{ id: 'WI-0099_REQ_001_AC_001', description: 'first' }] },
      { id: 'WI-0099_REQ_001', name: 'duplicate', description: 'duplicate', reason: 'duplicate', acceptanceCriteria: [{ id: 'WI-0099_REQ_001_AC_002', description: 'duplicate' }] },
    ] } });
    await writeFile(workItemPath, fixture);
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    const originalCwd = process.cwd();
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    try {
      process.chdir(root);
      await expect(main(['ref', 'resolve', '--ref', 'WI-0099_REQ_001'])).resolves.toBe(1);
      const duplicate = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: null; findings: string[] };
      expect(duplicate.valid).toBe(false);
      expect(duplicate.resolution).toBeNull();
      expect(duplicate.findings[0]).toContain('Duplicate requirement identifier');

      await expect(main(['ref', 'resolve', '--ref', 'WI-0099_REQ_999'])).resolves.toBe(1);
      const missing = JSON.parse(output.at(-1)!) as { valid: boolean; findings: string[] };
      expect(missing.valid).toBe(false);
      expect(missing.findings[0]).toContain('Requirement not found');
    } finally {
      process.chdir(originalCwd);
    }
    expect(await readFile(workItemPath, 'utf8')).toBe(fixture);
  });

  it('resolves work-item-local and task-qualified selectors and reports unsupported scopes', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['ref', 'resolve', '--ref', 'WI-0007#work-item.json#requirement/WI-0007_REQ_001'])).resolves.toBe(0);
    const requirement = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: { data: { id: string } } };
    expect(requirement.valid).toBe(true);
    expect(requirement.resolution.data.id).toBe('WI-0007_REQ_001');

    await expect(main(['ref', 'resolve', '--ref', 'WI-0007-10000000#result/R-001'])).resolves.toBe(0);
    const result = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: { repositoryPath: string; data: { status: string } } };
    expect(result.valid).toBe(true);
    expect(result.resolution.repositoryPath).toContain('WI-0007-10000000-implementation.yaml');
    expect(result.resolution.data.status).toBeDefined();

    await expect(main(['ref', 'resolve', '--ref', '#objective/OBJ-001'])).resolves.toBe(1);
    const local = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: null; findings: string[] };
    expect(local.valid).toBe(false);
    expect(local.resolution).toBeNull();
    expect(local.findings[0]).toContain('migration');
  });

  it('resolves explicit task-local intent/result JSON paths and rejects unrooted local paths', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['ref', 'resolve', '--ref', 'WI-0007-10000000#result/implementation/changes/CHANGE-001'])).resolves.toBe(0);
    const qualified = JSON.parse(output.at(-1)!) as { valid: boolean; resolution: { data: { id: string } } };
    expect(qualified.valid).toBe(true);
    expect(qualified.resolution.data.id).toBe('CHANGE-001');

    await expect(main(['ref', 'resolve', '--ref', '#objective/OBJ-001'])).resolves.toBe(1);
    const legacy = JSON.parse(output.at(-1)!) as { valid: boolean; findings: string[] };
    expect(legacy.valid).toBe(false);
    expect(legacy.findings[0]).toContain('migration');
  });

  it('accepts canonical hyphen task identifiers and rejects pipe-separated task references', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['ref', 'validate', '--ref', 'WI-0007-10000000#result/R-001'])).resolves.toBe(0);
    expect((JSON.parse(output.at(-1)!) as { valid: boolean }).valid).toBe(true);

    await expect(main(['ref', 'validate', '--ref', 'WI-0007|10000000#result/R-001'])).resolves.toBe(1);
    expect((JSON.parse(output.at(-1)!) as { valid: boolean }).valid).toBe(false);
  });

  it('migrates recognized task-local references within the selected path and reports replacements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-task-local-migration-'));
    const selected = join(root, 'nested');
    await mkdir(selected, { recursive: true });
    await writeFile(join(root, 'outside.yaml'), 'ref: "WI-0099|10000000#result/R-001"\n');
    const target = join(selected, 'WI-0099-10000000-task.yaml');
    await writeFile(target, [
      'taskUid: WI-0099-10000000',
      'task:',
      '  intent:',
      '    objectives:',
      '      - id: OBJ-001',
      '        statement: objective',
      '  result:',
      '    results:',
      '      - id: R-001',
      '        summary: result',
      '      - id: R-002',
      '        summary: result',
      'references:',
      '  - "#objective/OBJ-001"',
      '  - "WI-0099|10000000#result/R-001"',
      '  - "WI-0099-10000000#result/R-002"',
      '  - "OBJ-001"',
      '  - "WI-0099|10000000"',
      '',
    ].join('\n'));
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(main(['ref', 'migrate-task-local-up', '--path', 'nested', '--json'])).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    const report = JSON.parse(output.at(-1)!) as { changedFiles: string[]; replacements: Array<{ from: string; to: string; count: number }>; unresolvable: Array<{ reference: string }> };
    expect(report.changedFiles).toEqual(['nested/WI-0099-10000000-task.yaml']);
    expect(report.replacements).toEqual(expect.arrayContaining([
      { from: '#objective/OBJ-001', to: '#intent/objectives/OBJ-001', count: 1 },
      { from: 'WI-0099|10000000#result/R-001', to: 'WI-0099-10000000#result/results/R-001', count: 1 },
      { from: 'WI-0099-10000000#result/R-002', to: 'WI-0099-10000000#result/results/R-002', count: 1 },
      { from: 'WI-0099|10000000', to: 'WI-0099-10000000', count: 1 },
    ]));
    expect(report.unresolvable).toEqual([]);
    expect(await readFile(target, 'utf8')).toContain('#intent/objectives/OBJ-001');
    expect(await readFile(target, 'utf8')).toContain('WI-0099-10000000#result/results/R-001');
    expect(await readFile(join(root, 'outside.yaml'), 'utf8')).toContain('WI-0099|10000000#result/R-001');
    expect(await readFile(target, 'utf8')).toContain('OBJ-001');
  });

  it('is a no-op for canonical content and rejects unsafe migration paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-task-local-migration-safe-'));
    await writeFile(join(root, 'canonical.yaml'), 'ref: "#intent/objectives/OBJ-001"\nvalue: "OBJ-001"\n');
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    const before = await readFile(join(root, 'canonical.yaml'), 'utf8');
    const output: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(main(['ref', 'migrate-task-local-up', '--path', 'canonical.yaml', '--json'])).resolves.toBe(0);
      await expect(main(['ref', 'migrate-task-local-up', '--path', '../outside'])).resolves.toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
    const report = JSON.parse(output.at(-1)!) as { changedFiles: string[]; files: Array<{ changed: boolean }> };
    expect(report.changedFiles).toEqual([]);
    expect(report.files).toEqual([{ path: 'canonical.yaml', changed: false, replacements: [] }]);
    expect(await readFile(join(root, 'canonical.yaml'), 'utf8')).toBe(before);
    expect(errors.at(-1)).toContain('Path must remain within the repository');
  });

  it('preserves and reports recognized references whose task-local targets cannot resolve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-task-local-migration-unresolvable-'));
    const target = join(root, 'WI-0099-10000000-task.yaml');
    await writeFile(target, [
      'taskUid: WI-0099-10000000',
      'task:',
      '  intent:',
      '    objectives:',
      '      - id: OBJ-001',
      '        statement: objective',
      'references:',
      '  - "#objective/OBJ-999"',
      '  - "WI-0099|10000000#result/R-001"',
      '',
    ].join('\n'));
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(main(['ref', 'migrate-task-local-up', '--path', 'WI-0099-10000000-task.yaml', '--json'])).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
    const report = JSON.parse(output.at(-1)!) as { changedFiles: string[]; unresolvable: Array<{ path: string; reference: string; reason: string; preserved: true }> };
    expect(report.changedFiles).toEqual([]);
    expect(report.unresolvable).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'WI-0099-10000000-task.yaml', reference: '#objective/OBJ-999', preserved: true }),
      expect.objectContaining({ path: 'WI-0099-10000000-task.yaml', reference: 'WI-0099|10000000#result/R-001', preserved: true }),
    ]));
    const content = await readFile(target, 'utf8');
    expect(content).toContain('#objective/OBJ-999');
    expect(content).toContain('WI-0099|10000000#result/R-001');
  });

  it('migrates an entire selected work item and leaves sibling work items unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-work-item-migration-'));
    const selected = join(root, '.docs', 'work-items', 'WI-0099');
    const sibling = join(root, '.docs', 'work-items', 'WI-0100');
    await mkdir(join(selected, 'steps'), { recursive: true });
    await mkdir(join(sibling, 'steps'), { recursive: true });
    await writeFile(join(selected, 'work-item.json'), JSON.stringify({ workItemId: 'WI-0099', ref: 'WI-0099|10000000#work-item/WI-0099', value: 'OBJ-001' }, null, 2));
    await writeFile(join(selected, 'steps', 'WI-0099-10000000-task.yaml'), [
      'taskUid: WI-0099-10000000',
      'task:',
      '  result:',
      '    results:',
      '      - id: R-001',
      '        summary: result',
      'references:',
      '  - "WI-0099|10000000#result/R-001"',
      '',
    ].join('\n'));
    await writeFile(join(sibling, 'work-item.json'), JSON.stringify({ workItemId: 'WI-0100', ref: 'WI-0100|10000000#work-item/WI-0100' }, null, 2));
    await writeFile(join(sibling, 'steps', 'WI-0100-10000000-task.yaml'), 'ref: "#objective/OBJ-001"\n');
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);

    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(main(['ref', 'migrate-task-local-up', '--work-item', 'WI-0099', '--json'])).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    const report = JSON.parse(output.at(-1)!) as { path: string; changedFiles: string[] };
    expect(report.path).toBe('.docs/work-items/WI-0099');
    expect(report.changedFiles).toEqual([
      '.docs/work-items/WI-0099/steps/WI-0099-10000000-task.yaml',
      '.docs/work-items/WI-0099/work-item.json',
    ]);
    expect(await readFile(join(selected, 'work-item.json'), 'utf8')).toContain('WI-0099#work-item.json#work-item/WI-0099');
    expect(await readFile(join(selected, 'steps', 'WI-0099-10000000-task.yaml'), 'utf8')).toContain('WI-0099-10000000#result/results/R-001');
    expect(await readFile(join(sibling, 'work-item.json'), 'utf8')).toContain('WI-0100|10000000#work-item/WI-0100');
    expect(await readFile(join(sibling, 'steps', 'WI-0100-10000000-task.yaml'), 'utf8')).toContain('#objective/OBJ-001');
  });

  it('rejects invalid, missing, and conflicting whole-work-item migration options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-work-item-migration-errors-'));
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(main(['ref', 'migrate-task-local-up', '--work-item', 'bad-id'])).resolves.toBe(1);
      await expect(main(['ref', 'migrate-task-local-up', '--work-item', 'WI-0999'])).resolves.toBe(1);
      await expect(main(['ref', 'migrate-task-local-up', '--path', '.', '--work-item', 'WI-0999'])).resolves.toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
    expect(errors).toEqual([
      'Invalid work-item ID: bad-id',
      'Migration path does not exist: .docs/work-items/WI-0999',
      '--path and --work-item are mutually exclusive.',
    ]);
  });

  it('provides a distinct migrate-work-item-up command with deterministic idempotent scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-migrate-work-item-up-'));
    const selected = join(root, '.docs', 'work-items', 'WI-0099');
    const sibling = join(root, '.docs', 'work-items', 'WI-0100');
    await mkdir(join(selected, 'steps'), { recursive: true });
    await mkdir(join(sibling, 'steps'), { recursive: true });
    await writeFile(join(selected, 'work-item.json'), JSON.stringify({ workItemId: 'WI-0099', ref: 'WI-0099|10000000#work-item/WI-0099' }, null, 2));
    await writeFile(join(selected, 'steps', 'WI-0099-10000000-task.yaml'), [
      'taskUid: WI-0099-10000000',
      'task:',
      '  result:',
      '    results:',
      '      - id: R-001',
      '        summary: result',
      'references:',
      '  - "WI-0099|10000000#result/R-001"',
      '  - "#objective/OBJ-999"',
      '',
    ].join('\n'));
    await writeFile(join(sibling, 'work-item.json'), JSON.stringify({ workItemId: 'WI-0100', ref: 'WI-0100|10000000#work-item/WI-0100' }, null, 2));
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    const siblingBefore = await readFile(join(sibling, 'work-item.json'), 'utf8');
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(main(['ref', 'migrate-work-item-up', '--work-item', 'WI-0099', '--json'])).resolves.toBe(0);
      const first = JSON.parse(output.at(-1)!) as { schema: string; workItemId: string; path: string; changedFiles: string[]; unresolvable: Array<{ reference: string; preserved: true }> };
      expect(first).toEqual(expect.objectContaining({ schema: 'https://schemas.handschuh.dev/sdlc/ref/work-item-migration/v1', workItemId: 'WI-0099', path: '.docs/work-items/WI-0099' }));
      expect(first.changedFiles).toEqual([
        '.docs/work-items/WI-0099/steps/WI-0099-10000000-task.yaml',
        '.docs/work-items/WI-0099/work-item.json',
      ]);
      expect(first.unresolvable).toEqual(expect.arrayContaining([expect.objectContaining({ reference: '#objective/OBJ-999', preserved: true })]));
      expect(await readFile(join(selected, 'work-item.json'), 'utf8')).toContain('WI-0099#work-item.json#work-item/WI-0099');
      expect(await readFile(join(selected, 'steps', 'WI-0099-10000000-task.yaml'), 'utf8')).toContain('WI-0099-10000000#result/results/R-001');
      expect(await readFile(join(sibling, 'work-item.json'), 'utf8')).toBe(siblingBefore);

      output.length = 0;
      await expect(main(['ref', 'migrate-work-item-up', '--work-item=WI-0099', '--json'])).resolves.toBe(0);
      const second = JSON.parse(output.at(-1)!) as { changedFiles: string[]; files: Array<{ changed: boolean }>; replacements: unknown[] };
      expect(second.changedFiles).toEqual([]);
      expect(second.files.every((file) => !file.changed)).toBe(true);
      expect(second.replacements).toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('reports migrate-work-item-up help and rejects unsafe selections without writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-migrate-work-item-up-errors-'));
    await mkdir(join(root, '.docs', 'work-items', 'WI-0099'), { recursive: true });
    const marker = join(root, '.docs', 'work-items', 'WI-0099', 'work-item.json');
    await writeFile(marker, '{"workItemId":"WI-0099"}\n');
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    const output: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(main(['ref', 'migrate-work-item-up', '--help'])).resolves.toBe(0);
      await expect(main(['ref', 'migrate-work-item-up'])).resolves.toBe(1);
      await expect(main(['ref', 'migrate-work-item-up', '--work-item', 'bad-id'])).resolves.toBe(1);
      await expect(main(['ref', 'migrate-work-item-up', '--work-item', 'WI-0999'])).resolves.toBe(1);
      await expect(main(['ref', 'migrate-work-item-up', '--work-item', 'WI-0099', '--work-item', 'WI-0100'])).resolves.toBe(1);
      await expect(main(['ref', 'migrate-work-item-up', '--path', '.'])).resolves.toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
    expect(output.join('\n')).toContain('Usage: sdlc ref migrate-work-item-up --work-item <work-item-id> [--json]');
    expect(errors).toEqual([
      'Usage: sdlc ref migrate-work-item-up --work-item <work-item-id> [--json]',
      'Invalid work-item ID: bad-id',
      'Migration path does not exist: .docs/work-items/WI-0999',
      'Duplicate --work-item option.',
      'Unknown option: --path',
    ]);
    expect(await readFile(marker, 'utf8')).toBe('{"workItemId":"WI-0099"}\n');
  });

  it('centralizes deterministic enumeration for every supported work-item object extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-supported-object-enumeration-'));
    const steps = join(root, '.docs', 'work-items', 'WI-0099', 'steps');
    await mkdir(steps, { recursive: true });
    for (const extension of SUPPORTED_WORK_ITEM_OBJECT_EXTENSIONS) {
      await writeFile(join(steps, `WI-0099-10000000-object${extension}`), `fixture-${extension}\n`);
    }
    const objects = await enumerateWorkItemObjects(steps);
    expect(objects.map((path) => path.slice(path.lastIndexOf('.')))).toEqual([...SUPPORTED_WORK_ITEM_OBJECT_EXTENSIONS].sort());
  });

  it.each([...SUPPORTED_WORK_ITEM_OBJECT_EXTENSIONS])('discovers migration task context for %s files', async (extension) => {
    const root = await mkdtemp(join(tmpdir(), `sdlc-migration-context-${extension.slice(1)}-`));
    const directory = join(root, '.docs', 'work-items', 'WI-0099');
    const steps = join(directory, 'steps');
    await mkdir(steps, { recursive: true });
    await writeFile(join(directory, 'work-item.json'), JSON.stringify({ workItemId: 'WI-0099', ref: 'WI-0099|10000000#work-item/WI-0099' }, null, 2));
    const taskValue = {
      taskUid: 'WI-0099-10000000',
      task: { intent: { objectives: [{ id: 'OBJ-001', statement: 'fixture' }] } },
      reference: '#objective/OBJ-001',
    };
    const content = extension === '.json'
      ? JSON.stringify(taskValue, null, 2)
      : ['taskUid: WI-0099-10000000', 'task:', '  intent:', '    objectives:', '      - id: OBJ-001', '        statement: fixture', 'reference: "#objective/OBJ-001"', ''].join('\n');
    const taskPath = join(steps, `WI-0099-10000000-task${extension}`);
    await writeFile(taskPath, content);
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(main(['ref', 'migrate-work-item-up', '--work-item', 'WI-0099', '--json'])).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
    const report = JSON.parse(output.at(-1)!) as { files: Array<{ path: string; changed: boolean }>; unresolvable: Array<{ reference: string }> };
    expect(report.files.some((file) => file.path.endsWith(`task${extension}`) && file.changed)).toBe(true);
    expect(report.unresolvable).toEqual([]);
    expect(await readFile(taskPath, 'utf8')).toContain('#intent/objectives/OBJ-001');
  });

  it('migrates a BTCUSD-style JSON task and no longer reports no-task-context for the JSON extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-btcusd-json-context-'));
    const directory = join(root, '.docs', 'work-items', 'BTCUSD-0000');
    const steps = join(directory, 'steps');
    await mkdir(steps, { recursive: true });
    await writeFile(join(directory, 'work-item.json'), JSON.stringify({ workItemId: 'BTCUSD-0000', ref: 'BTCUSD-0000|01000000#work-item/BTCUSD-0000' }, null, 2));
    await writeFile(join(steps, 'BTCUSD-0000-01000000-implement-schema-registry.json'), JSON.stringify({
      schema: 'https://schemas.handschuh.dev/sdlc/task-envelope/v1',
      taskUid: 'BTCUSD-0000-01000000',
      task: { intent: { objectives: [{ id: 'OBJ-001', statement: 'fixture' }] } },
      references: ['#objective/OBJ-001', '#objective/OBJ-999', 'BTCUSD-0000|01000000'],
    }, null, 2));
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(main(['ref', 'migrate-work-item-up', '--work-item', 'BTCUSD-0000', '--json'])).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
    const report = JSON.parse(output.at(-1)!) as { changedFiles: string[]; unresolvable: Array<{ context: string; reason: string }> };
    expect(report.changedFiles).toContain('.docs/work-items/BTCUSD-0000/steps/BTCUSD-0000-01000000-implement-schema-registry.json');
    expect(report.unresolvable).not.toEqual(expect.arrayContaining([expect.objectContaining({ context: 'no-task-context' })]));
    expect(report.unresolvable).toEqual(expect.arrayContaining([expect.objectContaining({ context: 'BTCUSD-0000-01000000' })]));
  });

  it('rehearses every existing WI-0000 through WI-0018 migration in a disposable worktree', async () => {
    const sourceRoot = process.cwd();
    const sourceStatus = (await execFileAsync('git', ['status', '--porcelain'], { cwd: sourceRoot })).stdout;
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'sdlc-all-work-item-migration-'));
    const worktree = join(temporaryRoot, 'worktree');
    let worktreeCreated = false;
    try {
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot })).stdout.trim();
      await execFileAsync('git', ['worktree', 'add', '--detach', worktree, head], { cwd: sourceRoot });
      worktreeCreated = true;
      await execFileAsync('ln', ['-s', join(sourceRoot, 'node_modules'), join(worktree, 'node_modules')]);
      await execFileAsync('yarn', ['build'], { cwd: worktree });

      const workItemEntries = await readdir(join(worktree, '.docs', 'work-items'), { withFileTypes: true });
      const workItemIds = workItemEntries
        .filter((entry) => entry.isDirectory() && /^WI-[0-9]+$/u.test(entry.name))
        .map((entry) => entry.name)
        .filter((id) => Number(id.slice(3)) <= 18)
        .sort();
      expect(workItemIds).toEqual(Array.from({ length: 18 }, (_, index) => `WI-${String(index + 1).padStart(4, '0')}`));

      const reports: Array<{ path: string; changedFiles: string[]; replacements: unknown[]; unresolvable: unknown[] }> = [];
      for (const workItemId of workItemIds) {
        const result = await execFileAsync('node', ['./bin/cli.js', 'ref', 'migrate-task-local-up', '--work-item', workItemId, '--json'], { cwd: worktree });
        const report = JSON.parse(result.stdout) as (typeof reports)[number];
        reports.push(report);
        expect(report.path).toBe(`.docs/work-items/${workItemId}`);
        expect(Array.isArray(report.changedFiles)).toBe(true);
        expect(Array.isArray(report.replacements)).toBe(true);
        expect(Array.isArray(report.unresolvable)).toBe(true);
      }
      expect(reports).toHaveLength(18);

      const changedPaths = (await execFileAsync('git', ['diff', '--name-only'], { cwd: worktree })).stdout.trim().split('\n').filter(Boolean);
      expect(changedPaths.length).toBeGreaterThan(0);
      expect(changedPaths.every((path) => /^\.docs\/work-items\/WI-00(?:0[1-9]|1[0-8])\//u.test(path))).toBe(true);

      const rehearsalStatus = (await execFileAsync('git', ['status', '--porcelain'], { cwd: sourceRoot })).stdout;
      expect(rehearsalStatus).toBe(sourceStatus);
    } finally {
      if (worktreeCreated) await execFileAsync('git', ['worktree', 'remove', '--force', worktree], { cwd: sourceRoot });
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    expect((await execFileAsync('git', ['status', '--porcelain'], { cwd: sourceRoot })).stdout).toBe(sourceStatus);
  });

  it('applies depth defaults and expands a flat deduplicated reference map by rounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-reference-depth-'));
    await mkdir(join(root, '.docs', 'work-items', 'WI-0099'), { recursive: true });
    await mkdir(join(root, '.docs', 'work-items', 'WI-0100'), { recursive: true });
    await mkdir(join(root, '.docs', 'work-items', 'WI-0101'), { recursive: true });
    await writeFile(join(root, '.docs', 'work-items', 'WI-0099', 'work-item.json'), JSON.stringify({ workItemId: 'WI-0099', sourceWorkItem: 'WI-0100', repeated: 'WI-0100', cycle: 'WI-0099' }));
    await writeFile(join(root, '.docs', 'work-items', 'WI-0100', 'work-item.json'), JSON.stringify({ workItemId: 'WI-0100', sourceWorkItem: 'WI-0101', repeated: 'WI-0101', cycle: 'WI-0099' }));
    await writeFile(join(root, '.docs', 'work-items', 'WI-0101', 'work-item.json'), JSON.stringify({ workItemId: 'WI-0101', sourceWorkItem: 'WI-0099' }));
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    await execFileAsync('git', ['-C', root, 'add', '--', '.docs']);

    const originalCwd = process.cwd();
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const run = async (extra: string[] = []) => {
      output.length = 0;
      process.chdir(root);
      await expect(main(['ref', 'resolve', '--ref', 'WI-0099', '--json', ...extra])).resolves.toBe(0);
      return JSON.parse(output.join('\n')) as { schema: string; resolution: { references: Record<string, { references?: unknown }> } };
    };
    try {
      const omitted = await run();
      const bare = await run(['--depth']);
      const one = await run(['--depth', '1']);
      expect(bare).toEqual(omitted);
      expect(one).toEqual(omitted);
      expect(omitted.schema).toBe('https://schemas.handschuh.dev/sdlc/ref/resolution/v2');
      expect(Object.keys(omitted.resolution.references)).toEqual([]);

      const two = await run(['--depth', '2']);
      expect(Object.keys(two.resolution.references)).toEqual(['WI-0100']);
      expect(two.resolution.references['WI-0100']!.references).toBeUndefined();

      const three = await run(['--depth', '3']);
      expect(Object.keys(three.resolution.references)).toEqual(['WI-0100', 'WI-0101']);
      expect(three.resolution.references['WI-0099']).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('rejects malformed and duplicate depth options', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));

    await expect(main(['ref', 'resolve', '--ref', 'WI-0007', '--depth', '0'])).resolves.toBe(1);
    expect(errors.at(-1)).toBe('--depth requires a positive integer.');
    await expect(main(['ref', 'resolve', '--ref', 'WI-0007', '--depth', '2', '--depth', '3'])).resolves.toBe(1);
    expect(errors.at(-1)).toBe('Duplicate --depth option.');
  });

  it('discovers repository information from nested files and directories', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    await expect(main(['repository', 'info', '--path', 'src/core/discovery.ts', '--json'])).resolves.toBe(0);
    const report = JSON.parse(output.join('\n')) as { schema: string; fullPath: string; repositoryRoot: string; gitDir: string; isBare: boolean; origin: string | null };
    expect(report.schema).toBe('https://schemas.handschuh.dev/sdlc/repository/info/v1');
    expect(report.fullPath).toBe(join(process.cwd(), 'src/core/discovery.ts'));
    expect(report.repositoryRoot).toBe(process.cwd());
    expect(report.gitDir).toBe(join(process.cwd(), '.git'));
    expect(report.isBare).toBe(false);
    expect(report.origin).toBeTruthy();
    const directoryReport = await repositoryInfo(join(process.cwd(), 'src/core'));
    expect(directoryReport.repositoryRoot).toBe(process.cwd());
  });

  it('rejects repository info paths without a repository and missing selectors', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));
    await expect(main(['repository', 'info'])).resolves.toBe(1);
    expect(errors.at(-1)).toBe('Usage: sdlc repository info --path <path> [--json]');
    await expect(main(['repository', 'info', '--path', '/tmp'])).resolves.toBe(1);
    expect(errors.at(-1)).toContain('No Git repository found from path');
  });

  it('validates every example from every schema-registered reference type dynamically', async () => {
    async function schemaFiles(directory: string): Promise<string[]> {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
      const files: string[] = [];
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await schemaFiles(path));
        else if (entry.isFile() && entry.name.endsWith('.schema.json')) files.push(path);
      }
      return files;
    }

    const schemas = [] as Array<{ id: string; examples: string[] }>;
    for (const path of await schemaFiles(join(process.cwd(), 'schemas'))) {
      const schema = JSON.parse(await readFile(path, 'utf8')) as { ['x-sdlc-reference-type']?: boolean; $id?: string; examples?: unknown };
      if (schema['x-sdlc-reference-type'] === true) schemas.push({ id: schema.$id!, examples: schema.examples as string[] });
    }
    expect(schemas.length).toBeGreaterThan(0);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    for (const schema of schemas) {
      expect(schema.examples.length, `${schema.id} must provide examples`).toBeGreaterThan(0);
      for (const example of schema.examples) {
        output.length = 0;
        await expect(main(['ref', 'validate', '--ref', example])).resolves.toBe(0);
        const report = JSON.parse(output.join('\n')) as { valid: boolean; matches: Array<{ schemaId: string }> };
        expect(report.valid).toBe(true);
        expect(report.matches.some((match) => match.schemaId === schema.id)).toBe(true);
      }
    }
  });
});

describe('discovery commands', () => {
  it('returns one stable stat envelope for tracked text, JSON, and YAML files', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const paths = ['README.md', 'package.json', '.docs/work-items/WI-0001/work-item.json'];
    const reports: Array<Record<string, unknown>> = [];

    for (const path of paths) {
      output.length = 0;
      await expect(main(['stat', '--path', path])).resolves.toBe(0);
      reports.push(JSON.parse(output.join('\n')) as Record<string, unknown>);
    }

    expect(reports.map((report) => Object.keys(report))).toEqual([Object.keys(reports[0]!), Object.keys(reports[0]!), Object.keys(reports[0]!)]);
    for (const report of reports) {
      expect(report.schema).toBe('sdlc/stat/v1');
      expect(report.tracked).toBe(true);
      expect(report.objectKind).toBe('file');
      expect(report.stat).toEqual(expect.objectContaining({ size: expect.any(Number), mtime: expect.any(String), mode: expect.any(Number) }));
    }
    expect(reports[0]).toEqual(expect.objectContaining({ ref: null, objectType: 'file', objectSchemaPath: null }));
    expect(reports[1]).toEqual(expect.objectContaining({ ref: null, objectType: 'file', objectSchemaPath: null }));
    expect(reports[2]).toEqual(expect.objectContaining({
      ref: 'WI-0001#work-item.json#work-item/WI-0001',
      objectType: 'work-item',
      objectSchemaPath: 'schemas/work-item/v2/work-item.schema.json',
    }));
  });

  it('returns object identity and schema metadata for task envelopes', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['stat', '--path', '.docs/work-items/WI-0007/steps/WI-0007-10000000-implementation.yaml'])).resolves.toBe(0);

    const report = JSON.parse(output.join('\n')) as Record<string, unknown>;
    expect(report).toEqual(expect.objectContaining({
      ref: 'WI-0007#steps/WI-0007-10000000-implementation.yaml#task/WI-0007-10000000',
      objectType: 'task',
      objectSchemaPath: 'schemas/sdlc-task-envelope/v1/sdlc-task-envelope.schema.json',
    }));
  });

  it('rejects invalid stat options and untracked or escaping paths', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));

    await expect(main(['stat'])).resolves.toBe(1);
    expect(errors.at(-1)).toBe('Usage: sdlc stat --path <file-path>');
    await expect(main(['stat', '--path', 'README.md', '--path', 'package.json'])).resolves.toBe(1);
    expect(errors.at(-1)).toBe('Duplicate --path option.');
    await expect(main(['stat', '--path', '/tmp/outside'])).resolves.toBe(1);
    expect(errors.at(-1)).toContain('Path must remain within the repository');
    await expect(main(['stat', '--path', 'node_modules/not-tracked.txt'])).resolves.toBe(1);
    expect(errors.at(-1)).toContain('Path is not tracked by sdlc');
  });

  it('does not modify the inspected file', async () => {
    const before = await readFile('README.md', 'utf8');
    const result = await statTrackedPath(process.cwd(), 'README.md');
    const after = await readFile('README.md', 'utf8');
    expect(result.repositoryPath).toBe('README.md');
    expect(result.fullPath).toBe(join(process.cwd(), 'README.md'));
    expect(after).toBe(before);
  });

  it('lists work items from the repository in deterministic order', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['work-item', 'list', '--work-item', 'WI-0001', '--json'])).resolves.toBe(0);

    const report = JSON.parse(output.join('\n')) as { schema: string; items: Array<{ workItemId: string; path: string }> };
    expect(report.schema).toBe('sdlc-work-item-list/v1');
    expect(report.items.map((item) => item.workItemId)).toEqual(['WI-0001']);
    expect(report.items[0]?.path).toBe('.docs/work-items/WI-0001/work-item.json');
  });

  it('lists selected work-item tasks from its declared steps path', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['task', 'list', '--work-item', 'WI-0001', '--json'])).resolves.toBe(0);

    const report = JSON.parse(output.join('\n')) as { schema: string; workItemId: string; items: Array<{ taskUid: string; path: string }> };
    expect(report.schema).toBe('sdlc-task-list/v1');
    expect(report.workItemId).toBe('WI-0001');
    expect(report.items.map((item) => item.taskUid)).toEqual([
      'WI-0001-10000000',
      'WI-0001-20000000',
      'WI-0001-30000000',
      'WI-0001-40000000',
    ]);
    expect(report.items[0]?.path).toBe('.docs/work-items/WI-0001/steps/WI-0001-10000000-implementation.yaml');
  });

  it('selects the first unprocessed task and reports no task when exhausted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-next-task-'));
    const workItems = join(root, '.docs', 'work-items', 'WI-0099', 'steps');
    await mkdir(workItems, { recursive: true });
    await writeFile(join(root, '.docs', 'work-items', 'WI-0099', 'work-item.json'), JSON.stringify({ workItemId: 'WI-0099', status: 'planned', title: 'Fixture', stepsPath: '.docs/work-items/WI-0099/steps/' }));
    const task = (uid: string, status: string) => [
      'schema: https://schemas.handschuh.dev/sdlc/task-envelope/v1',
      `workItemId: WI-0099`,
      `taskUid: ${uid}`,
      `orderKey: '${uid.slice(-8)}'`,
      'parentTaskUid: null',
      'taskType: implementation',
      `processingStatus: ${status}`,
      'title: Fixture task',
      'objective: Fixture task',
      'references:',
      '  required: []',
      '  informational: []',
      'dependsOn: []',
      'task:',
      '  status: planned',
      '  taskSchema: https://schemas.handschuh.dev/sdlc/task-implementation/v1',
      '  intentSchema: https://schemas.handschuh.dev/sdlc/task-implementation/v1#/properties/intent',
      '  resultSchema: https://schemas.handschuh.dev/sdlc/task-implementation/v1#/properties/result',
      '  intent: {}',
      '  result: {}',
      '',
    ].join('\n');
    await writeFile(join(workItems, 'WI-0099-10000000.yaml'), task('WI-0099-10000000', 'processing_completed'));
    await writeFile(join(workItems, 'WI-0099-20000000.yaml'), task('WI-0099-20000000', 'unprocessed'));
    await writeFile(join(workItems, 'WI-0099-30000000.yaml'), task('WI-0099-30000000', 'processing_blocked'));

    const selected = await discoverNextTask(root, 'WI-0099');
    expect(selected?.taskUid).toBe('WI-0099-20000000');
    const selectedBytes = await readFile(join(workItems, 'WI-0099-20000000.yaml'), 'utf8');
    expect(await readFile(join(workItems, 'WI-0099-20000000.yaml'), 'utf8')).toBe(selectedBytes);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    output.length = 0;
    await expect(main(['task', 'next', '--work-item', 'WI-0008', '--json'])).resolves.toBe(0);
    const none = JSON.parse(output.join('\n')) as { selection: string; task: null };
    expect(none.selection).toBe('none');
    expect(none.task).toBeNull();
  });

  it('rejects invalid task-next selectors', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));
    await expect(main(['task', 'next'])).resolves.toBe(1);
    expect(errors.at(-1)).toBe('Usage: sdlc task next --work-item <work-item> [--json]');
    await expect(main(['task', 'next', '--work-item', 'WI-0001', '--work-item', 'WI-0002'])).resolves.toBe(1);
    expect(errors.at(-1)).toBe('Duplicate --work-item option.');
  });

  it('documents the work-item inventory and normalized task option forms in command help', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['work-item', 'list', '--help'])).resolves.toBe(0);
    await expect(main(['task', 'list', '--help'])).resolves.toBe(0);

    expect(output).toContain('Usage: sdlc work-item list [--work-item <work-item>] [--json]');
    expect(output).toContain('Usage: sdlc task list --work-item <work-item> [--json]');
  });

  it.each([
    [['task', 'list'], 'Usage: sdlc task list --work-item <work-item> [--json]'],
    [['task', 'list', '--work-item', 'WI-0001', '--work-item', 'WI-0002'], 'Duplicate --work-item option.'],
    [['task', 'list', 'WI-0001'], 'Unknown option: WI-0001'],
  ] as const)('rejects invalid normalized option form %j', async (args, expected) => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));

    await expect(main(args)).resolves.toBe(1);
    expect(errors[0]).toBe(expected);
  });

  it('validates every object in a complete work item', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['work-item', 'validate', '--work-item', 'WI-0026', '--json'])).resolves.toBe(0);

    const report = JSON.parse(output.join('\n')) as { schema: string; valid: boolean; workItemId: string; objectCount: number; invalidObjectCount: number; objects: Array<Record<string, unknown>> };
    expect(report.schema).toBe('https://schemas.handschuh.dev/sdlc/work-item-validation/v2');
    expect(report.valid).toBe(true);
    expect(report.workItemId).toBe('WI-0026');
    expect(report.objectCount).toBe(3);
    expect(report.invalidObjectCount).toBe(0);
    expect(report.objects[0]).toEqual(expect.objectContaining({
      schema: 'sdlc/stat/v1',
      repositoryPath: '.docs/work-items/WI-0026/work-item.json',
      fullPath: join(process.cwd(), '.docs/work-items/WI-0026/work-item.json'),
      tracked: true,
      objectKind: 'file',
      ref: 'WI-0026#work-item.json#work-item/WI-0026',
      objectType: 'work-item',
      objectSchemaPath: 'schemas/work-item/v2/work-item.schema.json',
    }));
  });

  it('validates one canonical task and reports structured reference metrics', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    await expect(main(['task', 'validate', '--task', 'WI-0026-10000000', '--json'])).resolves.toBe(0);
    const report = JSON.parse(output.join('\n')) as { scope: string; taskUid: string; objectCount: number; referenceCount: number; references: Array<{ value: string; remediation: string }> };
    expect(report.scope).toBe('task');
    expect(report.taskUid).toBe('WI-0026-10000000');
    expect(report.objectCount).toBe(1);
    expect(report.referenceCount).toBeGreaterThan(0);
    expect(report.references.every((reference) => reference.remediation.length > 0)).toBe(true);
  });

  it('continues reference validation after schema failure and preserves remediation context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-validation-continuation-'));
    const workItem = join(root, '.docs', 'work-items', 'WI-0099');
    await mkdir(join(workItem, 'steps'), { recursive: true });
    await writeFile(join(workItem, 'work-item.json'), JSON.stringify({ workItemId: 'WI-0099', status: 'planned', title: 'Invalid fixture', objective: 'fixture', references: { required: ['#not-a-reference'] }, stepsPath: '.docs/work-items/WI-0099/steps/' }));
    await writeFile(join(workItem, 'steps', 'WI-0099-10000000.yaml'), 'not: a valid task envelope\n');
    await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    const before = await readFile(join(workItem, 'work-item.json'), 'utf8');
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(main(['work-item', 'validate', '--work-item', 'WI-0099', '--json'])).resolves.toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
    const report = JSON.parse(output.join('\n')) as { valid: boolean; invalidObjectCount: number; references: Array<{ category: string; value: string; remediation: string }>; findings: string[] };
    expect(report.valid).toBe(false);
    expect(report.invalidObjectCount).toBeGreaterThan(0);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.references.some((reference) => reference.value === '#not-a-reference')).toBe(true);
    expect(report.references.every((reference) => reference.remediation.length > 0)).toBe(true);
    expect(await readFile(join(workItem, 'work-item.json'), 'utf8')).toBe(before);
  });

  it('rejects non-canonical task validation identifiers', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));
    await expect(main(['task', 'validate', '--task', 'WI-0008|10000000'])).resolves.toBe(1);
    expect(errors.at(-1)).toBe('Invalid task identifier: WI-0008|10000000');
  });

  it('reports malformed work-item objects without mutating the fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-work-item-validation-'));
    const workItem = join(root, '.docs', 'work-items', 'WI-0098');
    await mkdir(join(workItem, 'steps'), { recursive: true });
    const workItemPath = join(workItem, 'work-item.json');
    await writeFile(workItemPath, JSON.stringify({ schema: 'https://schemas.handschuh.dev/sdlc/work-item/v2', workItemId: 'WI-0098', status: 'planned', title: 'Fixture', objective: 'Fixture', repository: { root, authority: 'local' }, context: { mergeTarget: { branch: 'main' }, branch: { name: 'main', created: false, rationale: 'fixture' } }, request: { source: 'test', text: 'fixture', sha256: 'fixture' }, scope: [], nonGoals: [], requirements: { items: [] }, stepsPath: '.docs/work-items/WI-0098/steps/' }));
    await writeFile(join(workItem, 'steps', 'WI-0098-10000000.yaml'), 'not: a valid task envelope\n');
    const before = await readFile(workItemPath, 'utf8');
    const report = await validateWorkItem(root, 'WI-0098');
    expect(report.valid).toBe(false);
    expect(report.invalidObjectCount).toBeGreaterThan(0);
    expect(await readFile(workItemPath, 'utf8')).toBe(before);
  });

  it('lists all work items without a selector in plain and JSON forms', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));
    const before = await readFile('.docs/work-items/WI-0001/work-item.json', 'utf8');

    await expect(main(['work-item', 'list'])).resolves.toBe(0);
    expect(output.join('\n')).toContain('Work items:');
    expect(output.join('\n')).toContain('WI-0001');
    output.length = 0;

    await expect(main(['work-item', 'list', '--json'])).resolves.toBe(0);
    const report = JSON.parse(output.join('\n')) as { schema: string; items: Array<{ workItemId: string }> };
    expect(report.schema).toBe('sdlc-work-item-list/v1');
    expect(report.items.map((item) => item.workItemId)).toContain('WI-0001');
    expect(await readFile('.docs/work-items/WI-0001/work-item.json', 'utf8')).toBe(before);
  });

  it('discovers fixture records and preserves their bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-discovery-'));
    const workItems = join(root, '.docs', 'work-items');
    const workItemDirectory = join(workItems, 'WI-0009');
    const stepsDirectory = join(workItemDirectory, 'steps');
    await mkdir(stepsDirectory, { recursive: true });
    const workItem = JSON.stringify({ workItemId: 'WI-0009', status: 'planned', title: 'Fixture', stepsPath: '.docs/work-items/WI-0009/steps/' });
    const workItemPath = join(workItemDirectory, 'work-item.json');
    await writeFile(workItemPath, workItem);
    await writeFile(join(stepsDirectory, 'WI-0009-10000000.yaml'), [
      'taskUid: WI-0009-10000000',
      'taskType: implementation',
      'processingStatus: unprocessed',
      'task:',
      '  status: planned',
      '',
    ].join('\n'));

    const before = await readFile(workItemPath, 'utf8');
    const report = await discoverWorkItems(root);
    const tasks = await discoverTasks(root, 'WI-0009');
    const after = await readFile(workItemPath, 'utf8');

    expect(report.items).toEqual([{ workItemId: 'WI-0009', status: 'planned', title: 'Fixture', path: '.docs/work-items/WI-0009/work-item.json' }]);
    expect(tasks.items[0]?.taskUid).toBe('WI-0009-10000000');
    expect(after).toBe(before);
  });

  it('reports malformed records and unknown work-item IDs without throwing from the CLI', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));

    await expect(main(['task', 'list', '--work-item', 'WI-9999'])).resolves.toBe(1);
    expect(errors).toEqual(['Work item not found: WI-9999']);

    const root = await mkdtemp(join(tmpdir(), 'sdlc-malformed-'));
    await mkdir(join(root, '.docs', 'work-items', 'WI-0001'), { recursive: true });
    await writeFile(join(root, '.docs', 'work-items', 'WI-0001', 'work-item.json'), '{');
    const report = await discoverWorkItems(root);
    expect(report.items).toEqual([]);
    expect(report.findings[0]).toContain('in JSON at position');
    expect(() => { throw new DiscoveryError('stable error vocabulary'); }).toThrow('stable error vocabulary');
  });
});
