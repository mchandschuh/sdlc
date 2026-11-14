# sdlc

Schema-first SDLC process definitions and, eventually, a CLI built on top of
[`langgraph-exec`](https://github.com/mchandschuh/langgraph-exec).

## Current seed

This repository is intentionally a schema-only seed. It contains the SDLC type
system under [`schemas/`](./schemas) and no application runtime yet.

The initial seed does **not** include the previous SDLC implementation, CLI,
tests, CUE definitions, generated output, package dependencies, or LangGraph
runtime code. The previous implementation remains at
`/home/michael/.cline/skills/sdlc` as a reference until the migration reaches a
later checkpoint.

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