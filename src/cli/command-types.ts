import type { Argv, ArgumentsCamelCase } from 'yargs';

export interface SdlcCommandContext {
  readonly repositoryRoot?: string;
  readonly schemaRegistryRoot: string;
}

export type SdlcCommandArguments = Record<string, unknown>;

export interface SdlcCommandModule {
  readonly command: string;
  readonly describe: string;
  readonly builder: (argv: Argv<SdlcCommandArguments>) => Argv<SdlcCommandArguments>;
  readonly handler: SdlcCommandHandler;
}

export type SdlcCommandFactory = (context: SdlcCommandContext) => SdlcCommandModule;

export type SdlcCommandBuilder = (argv: Argv<SdlcCommandArguments>) => Argv<SdlcCommandArguments>;

export type SdlcCommandHandler = (
  argv: ArgumentsCamelCase<SdlcCommandArguments>,
) => Promise<void | number> | void | number;