import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';
import { discoverTasks, discoverWorkItems, DiscoveryError } from '../src/core/discovery.js';

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
  it('lists work items from the repository in deterministic order', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['work-item', 'list', '--json'])).resolves.toBe(0);

    const report = JSON.parse(output.join('\n')) as { schema: string; items: Array<{ workItemId: string; path: string }> };
    expect(report.schema).toBe('sdlc-work-item-list/v1');
    expect(report.items.map((item) => item.workItemId)).toEqual(['WI-0001', 'WI-0002']);
    expect(report.items[0]?.path).toBe('.docs/work-items/WI-0001/work-item.json');
  });

  it('lists selected work-item tasks from its declared steps path', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main(['task', 'list', 'WI-0001', '--json'])).resolves.toBe(0);

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

    await expect(main(['task', 'list', 'WI-9999'])).resolves.toBe(1);
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
