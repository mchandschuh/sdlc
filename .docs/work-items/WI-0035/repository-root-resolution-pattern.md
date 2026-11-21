# WI-0035 Git repository-root resolution pattern

This document is the design contract for replacing the current repository-root
selection logic.

## Responsibility boundary

`repositoryRoot` means the target repository whose files and Git state commands
operate on. It is not a schema registry root.

The reusable resolver must:

- use Git to locate the nearest repository root;
- accept an explicit starting path or default to the current working directory;
- normalize the resolved root;
- support nested paths, files, worktrees, and repository-specific Git layouts;
- return a stable result/error contract suitable for command modules and core code;
- never silently select a different repository from a singleton user config file.

The resolver must not:

- parse or select `schemaRegistryRoot`;
- locate JSON schemas;
- invoke `schema-validate`;
- resolve package-owned schema paths;
- choose a repository from `~/.sdlc/config.json`.

## Schema registry separation

Schema validation is a separate boundary:

```text
repositoryRoot      target work-item files, Git state, relative paths
schemaRegistryRoot   installed schemas passed to schema-validate --root
```

Every `schema-validate` invocation must use the installed schema registry root
and a registry-relative schema path. External target repositories must not need a
local `schemas/` directory merely to validate their work-item/task documents.

Reference-schema discovery must use the registry root too. Repository-local
reference resolution may use `repositoryRoot` to load the referenced document,
but schema matching must not read `repositoryRoot/schemas`.

## Proposed component boundary

The implementation should provide one reusable module under `src/core/` with a
small API that commands and core code can consume. The exact names may follow
the repository conventions, but the API must support the following shape:

```ts
export interface RepositoryRootResolution {
  readonly repositoryRoot: string;
  readonly startingPath: string;
  readonly gitDirectory: string;
}

export interface RepositoryRootResolutionOptions {
  readonly startingPath?: string;
}

export async function resolveRepositoryRoot(
  options?: RepositoryRootResolutionOptions,
): Promise<RepositoryRootResolution>;
```

The component should use `git -C <starting-path> rev-parse --show-toplevel`
and a safe Git-directory query, avoid shell interpolation, and translate common
Git failures into a stable repository-root error with the starting path and
remediation. Consumers should call the component rather than duplicate Git
root discovery.

## Selection policy

Selection order should be explicit and narrow:

1. A command-level explicit repository path, when the command supports one.
2. The nearest Git repository resolved from the command's target/current path.
3. No implicit configured repository-root fallback.

When no Git repository can be resolved and no explicit path was provided, fail
with guidance to run inside a repository or pass the command's explicit path
option. A future named repository profile may be added separately, but this work
item must not invent ambiguous automatic selection.

## Migration requirements

Route these operations through the component:

- `commandContext` / operative-root helpers;
- repository info and Git branch checks;
- work-item/task discovery and validation;
- stat and repository-relative path handling;
- reference resolution and migration scope;
- work-item start and branch operations;
- hook/installer repository selection where a repository is required.

Remove or stop using:

- `repositoryRoot` as a global fallback from `~/.sdlc/config.json`;
- configuration precedence that can select a stale repository outside Git;
- default schema paths derived from `resolve(repositoryRoot, 'schemas')`;
- reference schema discovery rooted at `repositoryRoot/schemas`.

## Required evidence

Tests must prove two or more repositories on one machine, nested directory
invocation, non-repository failure, explicit path selection, Git worktrees,
stale singleton configuration, installed schema registry use, and representative
command behavior. The evidence must distinguish target repository paths from
schema registry paths and must not claim remote deployment or production readiness.