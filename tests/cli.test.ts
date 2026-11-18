import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';
import { discoverNextTask, discoverTasks, discoverWorkItems, DiscoveryError, statTrackedPath } from '../src/core/discovery.js';
import { validateWorkItem } from '../src/core/work-item-validation.js';

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

  it.each(['-v', '--version'])('prints the package version for %s', async (argument) => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main([argument])).resolves.toBe(0);

    expect(output).toEqual(['0.1.0']);
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

    await expect(main(['work-item', 'validate', '--work-item', 'WI-0008', '--json'])).resolves.toBe(0);

    const report = JSON.parse(output.join('\n')) as { schema: string; valid: boolean; workItemId: string; objectCount: number; invalidObjectCount: number; objects: Array<Record<string, unknown>> };
    expect(report.schema).toBe('https://schemas.handschuh.dev/sdlc/work-item-validation/v1');
    expect(report.valid).toBe(true);
    expect(report.workItemId).toBe('WI-0008');
    expect(report.objectCount).toBe(3);
    expect(report.invalidObjectCount).toBe(0);
    expect(report.objects[0]).toEqual(expect.objectContaining({
      schema: 'sdlc/stat/v1',
      requestedPath: '.docs/work-items/WI-0008/work-item.json',
      repositoryPath: '.docs/work-items/WI-0008/work-item.json',
      tracked: true,
      objectKind: 'file',
      ref: 'WI-0008#work-item.json#work-item/WI-0008',
      objectType: 'work-item',
      objectSchemaPath: 'schemas/work-item/v2/work-item.schema.json',
    }));
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
