import yargs from 'yargs/yargs';
import type { ArgumentsCamelCase } from 'yargs';
import type { SdlcCommandContext, SdlcCommandModule } from './command-types.js';
import { commandMatchesArguments, discoverCommands } from './command-discovery.js';

function commandPath(command: SdlcCommandModule): string { return command.command; }

function rootHelpOrVersion(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  return args.every((argument) => argument === '-h' || argument === '--help' || argument === '-v' || argument === '--version');
}

export async function runDiscoveredCommands(
  args: readonly string[],
  moduleUrl: string,
  schemaRegistryRoot: string,
  version: string,
): Promise<number | undefined> {
  // The first task migrates only the work-item and repository command families;
  // leave all other command families on the legacy dispatcher until their
  // dedicated command-module tasks move them into the discovered registry.
  const dynamicFamily = (args[0] === 'work-item' && ['list', 'start', 'validate'].includes(args[1] ?? ''))
    || (args[0] === 'task' && ['list', 'validate', 'next'].includes(args[1] ?? ''))
    || (args[0] === 'repository' && args[1] === 'info')
    || (args[0] === 'ref' && ['validate', 'resolve', 'migrate-task-local-up', 'migrate-work-item-up'].includes(args[1] ?? ''));
  if (!rootHelpOrVersion(args) && !dynamicFamily) return undefined;
  const context: SdlcCommandContext = { schemaRegistryRoot };
  const commands = await discoverCommands(moduleUrl, context);
  const dynamicMatch = commands.some((command) => commandMatchesArguments(commandPath(command), args));
  if (!rootHelpOrVersion(args) && !dynamicMatch) return undefined;

  let exitCode = 0;
  const parser = yargs(args)
    .scriptName('sdlc')
    .exitProcess(false)
    .usage('Usage: sdlc [options]')
    .wrap(160)
    .help()
    .alias('h', 'help')
    .version(version)
    .alias('v', 'version')
    .strict()
    .fail((message, error) => {
      const normalized = message?.replace(/^Unknown argument:/u, 'Unknown option:');
      const restored = normalized?.replace(/Unknown option: ([A-Za-z0-9_-]+)/u, (_match, name: string) => {
        const original = args.find((argument) => argument === `--${name}` || argument === `-${name}`);
        return `Unknown option: ${original ?? name}`;
      });
      throw error ?? new Error(restored ?? 'Invalid command invocation.');
    });
  const groups = new Map<string, readonly SdlcCommandModule[]>();
  for (const command of commands) {
    const [group] = command.command.split(/\s+/u);
    groups.set(group!, [...(groups.get(group!) ?? []), command]);
  }
  for (const [group, groupCommands] of groups) {
    parser.command(
      group,
      `${group} commands`,
      (groupArgv) => {
        for (const command of groupCommands) {
          const child = command.command.split(/\s+/u).slice(1).join(' ');
          groupArgv.command(
            child,
            command.describe,
            command.builder as any,
            async (argv: ArgumentsCamelCase<Record<string, unknown>>) => {
              const result = await command.handler(argv);
              if (typeof result === 'number') exitCode = result;
            },
          );
        }
        return groupArgv;
      },
      () => undefined,
    );
  }
  if (args.length === 0) {
    const help = await parser.getHelp();
    for (const line of help.replace(/^sdlc \[command\]/u, 'Usage: sdlc [options]').split('\n')) console.log(line);
  }
  else {
    const originalLog = console.log;
    const splitHelpOutput = args.includes('-h') || args.includes('--help');
    console.log = (...values: unknown[]) => {
      if (splitHelpOutput && values.length === 1 && typeof values[0] === 'string' && values[0].includes('\n')) {
        for (const line of values[0].split('\n')) originalLog(line);
      } else originalLog(...values);
    };
    try {
      await parser.parseAsync();
    } finally {
      console.log = originalLog;
    }
  }
  return exitCode;
}