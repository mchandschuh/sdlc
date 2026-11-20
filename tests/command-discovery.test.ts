import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverCommands, enumerateCommandFiles } from '../src/cli/command-discovery.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('dynamic command discovery', () => {
  it('enumerates current command modules deterministically', async () => {
    const files = await enumerateCommandFiles(new URL('../src/cli/main.ts', import.meta.url).href);
    expect(files.map((file) => file.replaceAll('\\', '/').split('/src/').at(-1))).toEqual([
      'cli/commands/repository/info.command.ts',
      'cli/commands/work-item/list.command.ts',
      'cli/commands/work-item/start.command.ts',
    ]);
  });

  it('loads valid descriptors and rejects duplicate command paths', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp-command-discovery-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'commands', 'nested'), { recursive: true });
    const valid = 'export default () => ({ command: "alpha one", describe: "Alpha", builder: (argv) => argv, handler: () => undefined });\n';
    await writeFile(join(root, 'commands', 'nested', 'one.command.js'), valid);
    const commands = await discoverCommands(pathToFileURL(join(root, 'entry.js')).href, { schemaRegistryRoot: root });
    expect(commands.map((command) => command.command)).toEqual(['alpha one']);

    await writeFile(join(root, 'commands', 'two.command.js'), valid);
    await expect(discoverCommands(pathToFileURL(join(root, 'entry.js')).href, { schemaRegistryRoot: root }))
      .rejects.toThrowError('Duplicate command path: alpha one');
  });
});