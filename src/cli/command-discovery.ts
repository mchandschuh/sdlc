import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Argv, ArgumentsCamelCase } from 'yargs';
import type { SdlcCommandArguments, SdlcCommandContext, SdlcCommandModule } from './command-types.js';

export class CommandDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandDiscoveryError';
  }
}

function commandSuffix(moduleUrl: string): string {
  return fileURLToPath(moduleUrl).endsWith('.ts') ? '.command.ts' : '.command.js';
}

function commandRoot(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), 'commands');
}

async function filesUnder(directory: string, suffix: string, root = directory): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path, suffix, root));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
  }
  return files.sort((left, right) => left.slice(root.length).localeCompare(right.slice(root.length), undefined, { numeric: true }));
}

export async function enumerateCommandFiles(moduleUrl: string): Promise<string[]> {
  const root = commandRoot(moduleUrl);
  try {
    return await filesUnder(root, commandSuffix(moduleUrl));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new CommandDiscoveryError(error instanceof Error ? error.message : `Unable to enumerate command modules below ${root}.`);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validDescriptor(value: unknown): value is SdlcCommandModule {
  const descriptor = objectValue(value);
  return Boolean(
    descriptor
    && typeof descriptor.command === 'string'
    && descriptor.command.trim().length > 0
    && typeof descriptor.describe === 'string'
    && descriptor.describe.trim().length > 0
    && typeof descriptor.builder === 'function'
    && typeof descriptor.handler === 'function',
  );
}

export async function discoverCommands(moduleUrl: string, context: SdlcCommandContext): Promise<readonly SdlcCommandModule[]> {
  const files = await enumerateCommandFiles(moduleUrl);
  const commands: SdlcCommandModule[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let loaded: { readonly default?: unknown };
    try {
      loaded = await import(pathToFileURL(file).href) as { readonly default?: unknown };
    } catch (error) {
      throw new CommandDiscoveryError(`Unable to load command module ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof loaded.default !== 'function') throw new CommandDiscoveryError(`Command module ${file} must export a default factory.`);
    let command: unknown;
    try {
      command = (loaded.default as (value: SdlcCommandContext) => unknown)(context);
    } catch (error) {
      throw new CommandDiscoveryError(`Command factory ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!validDescriptor(command)) throw new CommandDiscoveryError(`Command factory ${file} returned an invalid descriptor.`);
    const commandPath = command.command as string;
    if (seen.has(commandPath)) throw new CommandDiscoveryError(`Duplicate command path: ${commandPath}`);
    seen.add(commandPath);
    commands.push(command);
  }
  return commands;
}

export function commandMatchesArguments(command: string, args: readonly string[]): boolean {
  const commandTokens = command.split(/\s+/u).filter((token) => !token.startsWith('-') && !token.startsWith('[') && !token.startsWith('<'));
  return commandTokens.every((token, index) => args[index] === token);
}

export function commandModuleForContext(
  command: string,
  builder: (argv: Argv<SdlcCommandArguments>) => Argv<SdlcCommandArguments>,
  handler: (argv: ArgumentsCamelCase<SdlcCommandArguments>) => Promise<void | number> | void | number,
): SdlcCommandModule {
  return { command, describe: command, builder, handler: async (argv) => { await handler(argv); } } as SdlcCommandModule;
}