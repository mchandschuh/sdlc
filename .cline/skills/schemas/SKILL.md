# SDLC schema naming and authoring conventions

## Purpose

Use this guide whenever adding or changing a persisted schema, task contract, CLI
response, work-item record, or other structured SDLC object.

## Every structured object needs a persisted schema

Every input or output object that is introduced, persisted, serialized, or exposed
by the repository must have a versioned JSON Schema under `schemas/`.

Use JSON Schema 2020-12, add the schema before or with the implementation, and
validate both the schema and at least one representative instance before
committing.

## Filesystem naming

Use this layout:

```text
schemas/<high-level-object>/v<major>/<descriptive-name>.schema.json
```

Examples:

```text
schemas/sdlc-task-implementation/v1/sdlc-task-implementation.schema.json
schemas/sdlc-cli-task-next/v1/sdlc-cli-task-next.schema.json
schemas/work-item/v3/work-item.schema.json
```

The directory and filename should identify the same high-level contract family.
Keep each schema version in its own directory. Never silently change the meaning
of an existing version.

## `$id` naming

Every public schema needs a stable absolute `$id` under:

```text
https://schemas.handschuh.dev/sdlc/
```

The `$id` should use the contract family and version:

```text
https://schemas.handschuh.dev/sdlc/task-implementation/v1
https://schemas.handschuh.dev/sdlc/cli-task-next/v1
https://schemas.handschuh.dev/sdlc/work-item/v3
```

## Task-type schemas versus CLI response schemas

Task-specific contracts use the `sdlc-task-<task-type>` family:

```text
schemas/sdlc-task-implementation/v1/
https://schemas.handschuh.dev/sdlc/task-implementation/v1
```

CLI response contracts use the `sdlc-cli-<response-name>` family:

```text
schemas/sdlc-cli-task-next/v1/
https://schemas.handschuh.dev/sdlc/cli-task-next/v1
```

The `cli-` prefix distinguishes a command response from a task-type payload. Do
not name a CLI response as `task-<name>` when it is not a task-specific contract.

## Contract shape

Prefer closed objects:

```json
{
  "type": "object",
  "additionalProperties": false
}
```

Document any intentional extension boundary. Persisted responses should include a
versioned `schema` property whose value is the canonical schema ID when that field
is part of the response envelope.

## Registry and validation

The complete schema tree must pass the repository schema audit. New schemas must
be discovered by the audit rather than added to hard-coded filename lists.

Validate:

```bash
node /home/michael/.cline/skills/sdlc/bin/dev.js schema validate
```

For repository objects, also run the applicable CLI validation command and validate
representative success and failure response instances against their persisted
schemas.

## Reference schemas

Standalone string schemas used by reference validation must declare:

```json
"x-sdlc-reference-type": true
```

They must be string schemas with a stable absolute `$id` and at least one valid
root-level example. Reference-schema discovery is recursive and must remain
separate from target repository-root resolution.

## Lifecycle metadata

Task-specific lifecycle metadata uses the documented `x-sdlc-task-lifecycle`
convention. New metadata keys require documentation of their location, shape,
consumer, interpretation, and validation behavior before use.

## Versioning

Use a new major directory when an existing schema's meaning or compatibility
contract changes incompatibly. Use additive changes within the documented policy
for the current version only when existing consumers remain valid. Record version
impact in the governing work item and never silently rewrite an existing schema's
meaning.