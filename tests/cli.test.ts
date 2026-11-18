import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';
import { discoverTasks, discoverWorkItems, DiscoveryError, statTrackedPath } from '../src/core/discovery.js';

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
      expect(report.schema).toBe('sdlc-stat/v1');
      expect(report.tracked).toBe(true);
      expect(report.objectKind).toBe('file');
      expect(report.stat).toEqual(expect.objectContaining({ size: expect.any(Number), mtime: expect.any(String), mode: expect.any(Number) }));
    }
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

  it('documents the normalized work-item option forms in command help', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['work-item', 'list', '--help'])).resolves.toBe(0);
    await expect(main(['task', 'list', '--help'])).resolves.toBe(0);

    expect(output).toContain('Usage: sdlc work-item list --work-item <work-item> [--json]');
    expect(output).toContain('Usage: sdlc task list --work-item <work-item> [--json]');
  });

  it.each([
    [['work-item', 'list'], 'Usage: sdlc work-item list --work-item <work-item> [--json]'],
    [['task', 'list'], 'Usage: sdlc task list --work-item <work-item> [--json]'],
    [['task', 'list', '--work-item', 'WI-0001', '--work-item', 'WI-0002'], 'Duplicate --work-item option.'],
    [['task', 'list', 'WI-0001'], 'Unknown option: WI-0001'],
  ] as const)('rejects invalid normalized option form %j', async (args, expected) => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));

    await expect(main(args)).resolves.toBe(1);
    expect(errors[0]).toBe(expected);
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
