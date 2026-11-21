import yargs from 'yargs/yargs';
import type { ArgumentsCamelCase } from 'yargs';
import type { SdlcCommandContext, SdlcCommandModule } from './command-types.js';
import { collectionNamesForCommand } from '../core/collection-list.js';
import { commandMatchesArguments, discoverCommands } from './command-discovery.js';

function rootHelpOrVersion(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  return args.every((argument) => argument === '-h' || argument === '--help' || argument === '-v' || argument === '--version');
}

function parameterizedCommandMatches(command: string, args: readonly string[]): boolean {
  if (!command.includes('<') && !command.includes('[')) return false;
  const expected = command.split(/\s+/u).filter((token) => !token.startsWith('-'));
  const actual = args.slice(0, args.findIndex((argument) => argument.startsWith('-')) === -1 ? args.length : args.findIndex((argument) => argument.startsWith('-')));
  if (expected.length !== actual.length) return false;
  return expected.every((token, index) => token.startsWith('<') || token.startsWith('[') || token === actual[index]);
}

export async function runDiscoveredCommands(
  args: readonly string[],
  moduleUrl: string,
  schemaRegistryRoot: string,
  version: string,
): Promise<number | undefined> {
  const context: SdlcCommandContext = { schemaRegistryRoot };
  const commands = await discoverCommands(moduleUrl, context);

  let exitCode = 0;
  let parseFailed = false;
  let suppressNextFailureUsage = false;
  const parser = yargs(args)
    .scriptName('sdlc')
    .exitProcess(false)
    .usage('Usage: sdlc [options]')
    .wrap(160)
    .help()
    .showHelpOnFail(false)
    .alias('h', 'help')
    .version(version)
    .alias('v', 'version')
    .strict()
    .fail((message, error, failedParser) => {
      failedParser.showHelpOnFail(false);
      const normalized = message?.replace(/^Unknown (?:argument|command):/u, 'Unknown option:');
      const restored = normalized?.replace(/Unknown option: ([A-Za-z0-9_-]+)/u, (_match, name: string) => {
        const original = args.find((argument) => argument === `--${name}` || argument === `-${name}`);
        return `Unknown option: ${original ?? name}`;
      });
      parseFailed = true;
      suppressNextFailureUsage = true;
      console.error(restored ?? error?.message ?? 'Invalid command invocation.');
      if (!commands.some((command) => commandMatchesArguments(command.command, args))) {
        console.error('Run \"sdlc --help\" to see available options.');
      }
    });
  const parameterizedCommand = commands.find((command) => parameterizedCommandMatches(command.command, args));
  if (parameterizedCommand) {
    let parameterizedExitCode = 0;
    let parameterizedParseFailed = false;
    const parameterizedParser = yargs(args)
      .scriptName('sdlc')
      .exitProcess(false)
      .usage(`Usage: sdlc ${parameterizedCommand.command}`)
      .wrap(160)
      .help()
      .showHelpOnFail(false)
      .alias('h', 'help')
      .version(version)
      .alias('v', 'version')
      .strict()
      .fail((message, error) => {
        parameterizedParseFailed = true;
        console.error(message ?? error?.message ?? 'Invalid command invocation.');
      });
    parameterizedParser.command(
      parameterizedCommand.command,
      parameterizedCommand.describe,
      parameterizedCommand.builder as any,
      async (argv: ArgumentsCamelCase<Record<string, unknown>>) => {
        try {
          const result = await parameterizedCommand.handler(argv);
          if (typeof result === 'number') parameterizedExitCode = result;
        } catch (error) {
          console.error(error instanceof Error ? error.message : 'Command failed');
          parameterizedExitCode = 1;
        }
      },
    );
    await parameterizedParser.parseAsync();
    return parameterizedParseFailed ? 2 : parameterizedExitCode;
  }
  const groups = new Map<string, readonly SdlcCommandModule[]>();
  for (const command of commands) {
    const isCollectionCommand = command.command === 'task <collection> list' || command.command === 'work-item <collection> list';
    if (!isCollectionCommand && (command.command.includes('<') || command.command.includes('['))) continue;
    const [group] = command.command.split(/\s+/u);
    groups.set(group!, [...(groups.get(group!) ?? []), command]);
  }
  for (const [group, groupCommands] of groups) {
    const rootCommand = groupCommands.find((command) => !command.command.includes(' '));
    if (rootCommand) {
      parser.command(
        rootCommand.command,
        rootCommand.describe,
        rootCommand.builder as any,
        async (argv: ArgumentsCamelCase<Record<string, unknown>>) => {
          try {
            const result = await rootCommand.handler(argv);
            if (typeof result === 'number') exitCode = result;
          } catch (error) {
            console.error(error instanceof Error ? error.message : 'Command failed');
            exitCode = 1;
          }
        },
      );
      continue;
    }
    parser.command(
      group,
      `${group} commands`,
      (groupArgv) => {
        groupArgv.showHelpOnFail(false);
        for (const command of groupCommands) {
          if (command.command === `${group} <collection> list`) {
            for (const collection of collectionNamesForCommand(group as 'task' | 'work-item')) {
              groupArgv.command(
                `${collection} list`,
                command.describe,
                (childArgv) => childArgv.showHelpOnFail(false),
                () => undefined,
              );
            }
            continue;
          }
          const child = command.command.split(/\s+/u).slice(1).join(' ');
          groupArgv.command(
            child,
            command.describe,
            (childArgv) => command.builder(childArgv).showHelpOnFail(false),
            async (argv: ArgumentsCamelCase<Record<string, unknown>>) => {
              try {
                const result = await command.handler(argv);
                if (typeof result === 'number') exitCode = result;
              } catch (error) {
                console.error(error instanceof Error ? error.message : 'Command failed');
                exitCode = 1;
              }
            },
          );
        }
        return groupArgv;
      },
      () => undefined,
    );
  }
  parser.epilogue([
    '',
    'Resolved commands:',
    ...commands.map((command) => `  sdlc ${command.command}  ${command.describe}`),
  ].join('\n'));
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
    const originalError = console.error;
    try {
      console.error = (...values: unknown[]) => {
        if (suppressNextFailureUsage && values.length === 1 && typeof values[0] === 'string' && values[0].startsWith('Usage: sdlc ')) {
          suppressNextFailureUsage = false;
          return;
        }
        originalError(...values);
      };
      await parser.parseAsync();
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
  }
  if (!parseFailed) return exitCode;
  return commands.some((command) => commandMatchesArguments(command.command, args)) ? 1 : 2;
}