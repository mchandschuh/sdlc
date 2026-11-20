# WI-0033 command-module pattern

This document is the required design contract for the dynamic command refactor.
Every WI-0033 implementation, review, aggregate-validation, and release task must
read it before processing. A task must not claim conformance from a descriptor
shape alone; it must also verify discovery, yargs registration, help generation,
dispatch, and command-file encapsulation.

## Problem and root cause

The current `src/cli/main.ts` contains a manually maintained `printHelp()` table,
while command handlers are dispatched through separate `handle...` functions. A
command can therefore exist and execute without appearing in `sdlc -h`. In the
current 0.7.3 package, `work-item validate` and `task validate` are implemented
but omitted from root help, and their handlers do not provide command-specific
`--help` handling.

## Command roots and file naming

Source command modules live under:

```text
src/cli/commands/**/*.command.ts
```

Compiled command modules live under:

```text
dist/cli/commands/**/*.command.js
```

The loader resolves the command root relative to the executing CLI module, not the
caller working directory. It recursively enumerates files, selects only the
expected suffix, sorts paths using a stable ordering, and imports every module
before exposing help or dispatch.

## Command-module interface

`src/cli/command-types.ts` owns the shared TypeScript types. Every command module
exports a default factory with a yargs-compatible descriptor:

```ts
export interface SdlcCommandContext {
  readonly repositoryRoot?: string;
  readonly schemaRegistryRoot: string;
}

export interface SdlcCommandModule<TArguments extends object = Record<string, unknown>> {
  readonly command: string;
  readonly describe: string;
  readonly builder: (argv: Argv<Record<string, unknown>>) => Argv<TArguments>;
  readonly handler: (
    argv: ArgumentsCamelCase<TArguments>,
  ) => Promise<void | number> | void | number;
}

export type SdlcCommandFactory<
  TArguments extends object = Record<string, unknown>,
> = (
  context: SdlcCommandContext,
) => SdlcCommandModule<TArguments>;
```

The implementation may extend the exact local type to match the installed yargs
types, but these public members and their meaning are mandatory.

## Encapsulation rule

Each command file owns all command-specific behavior. The command file must contain
its option-specific normalization, domain-service orchestration, output shaping,
error translation, and handler implementation. For example,
`work-item/validate.command.ts` contains `runWorkItemValidation`; it must not leave
that function in `src/cli/main.ts`.

`src/cli/main.ts` is composition-only. It may:

1. create the root yargs parser;
2. resolve the operative context;
3. enumerate and import command modules;
4. validate descriptors and reject duplicates;
5. register descriptors with yargs;
6. configure global `--help`, `-h`, `--version`, and `-v` behavior; and
7. map the parsed command result to the process exit code.

It must not contain command-specific `run...`, `handle...`, option parsing,
command output, or business logic functions after migration.

## Resolution and registration

The loader must:

- reject a module with no default factory;
- reject a factory that does not return a non-empty command and description;
- reject a descriptor without a callable builder and handler;
- reject duplicate canonical command paths;
- fail closed rather than register a partial command set;
- register every descriptor before parsing arguments or rendering help; and
- use the same registry for root help, command-specific help, and dispatch.

The registry is the authority for the command inventory. There must not be a second
hand-maintained list in `printHelp()` or another root dispatcher table.

## Help and dispatch contract

Yargs supplies root and command-specific help from the registered descriptors.
At minimum, these commands must be resolved and documented:

```text
work-item list
work-item validate
work-item start
repository info
task list
task validate
task next
ref validate
ref resolve
ref migrate-task-local-up
ref migrate-work-item-up
stat
```

Both forms must work where applicable:

```bash
sdlc -h
sdlc --help
sdlc work-item validate --help
sdlc task validate --help
```

Help must not resolve repository-dependent state merely to print command usage.
Execution handlers may resolve repository context only after yargs has parsed a
non-help invocation.

## Testing contract

Tests must cover:

- deterministic recursive command-file enumeration;
- source and compiled suffix selection;
- malformed descriptor rejection;
- duplicate command rejection;
- failure-closed module loading;
- root help containing every registered command;
- command-specific help for every current command;
- representative dispatch for every command family;
- preservation of JSON output and exit codes;
- command-specific functions remaining in their command files; and
- the installed user-local executable reporting the expected version after build
  and link verification.

Static or unit tests do not prove external deployment or production readiness.
The final validation and release tasks must retain that evidence limitation.