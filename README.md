# sdlc

Schema-first SDLC process definitions and, eventually, a CLI built on top of
[`langgraph-exec`](https://github.com/mchandschuh/langgraph-exec).

## Current seed

This repository contains the SDLC type system under [`schemas/`](./schemas) and
the initial TypeScript/ESM plumbing for the `sdlc` CLI. The implementation
follows the conventions from the `nodejs-cli-pattern` skill. The CLI is
intentionally a small runtime boundary: it currently exposes stable help and
version behavior while leaving command registration and application services
for later work.

The initial seed does **not** include the previous SDLC implementation, CLI,
tests, CUE definitions, generated output, or LangGraph runtime code. The
previous implementation remains at
`/home/michael/.cline/skills/sdlc` as a reference until the migration reaches a
later checkpoint.

## CLI plumbing

The package uses native ESM, TypeScript, and Yarn through Corepack:

```bash
yarn install
yarn build
node ./bin/cli.js --help
node ./bin/cli.js --version
yarn test

# After local registration:
sdlc --help
sdlc --version
sdlc work-item list --work-item WI-0001
sdlc task list --work-item WI-0001
```

The short aliases `-h` and `-v` are equivalent to `--help` and `--version`.
The launcher runs compiled JavaScript from `dist/`; local TypeScript execution
is available through `yarn dev`.

The schema set currently covers:

- work items and work-item assessments;
- task envelopes and task-specific intent/result contracts;
- requirements, references, evidence, and lifecycle vocabulary;
- research, decision, design, implementation, test-strategy, validation,
  review, rework, and delivery tasks; and
- classification and policy-review records.

## Planned direction

The future application will ship a default process catalog and allow repository
or user process directories to be registered, for example through a future
configuration mechanism such as:

```text
~/.sdlc/
./.sdlc/
```

Those processes will be YAML or JSON definitions consumed through the public
`langgraph-exec` package. The application layer will own process registration,
CLI interaction, work-item/task persistence, and status reporting; the process
definitions will own declarative topology and state flow.

That runtime and configuration surface is intentionally not part of this seed.

## Schema validation

The schemas are JSON Schema 2020-12 documents. Validate the complete tree with
the locally installed schema validator:

```bash
schema-validate \
  --root schemas \
  $(find schemas -type f -name '*.schema.json' -print | sort)
```

Schema validation establishes static contract evidence only. It does not prove
runtime execution, provider availability, process completeness, persistence,
deployment, or production readiness.
