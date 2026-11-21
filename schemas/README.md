# SDLC schema conventions

## Task lifecycle metadata

Task-specific schemas declare lifecycle behavior with the root
`x-sdlc-task-lifecycle` object. The common task envelope owns identity,
routing, `processingStatus`, and the selected task wrapper; each task schema owns
its task-specific `status` enum and lifecycle meaning.

Required metadata:

```json
{
  "x-sdlc-task-lifecycle": {
    "statusProperty": "/status",
    "resultProperty": "/result",
    "statuses": {
      "planned": {"kind": "transitional", "result": "optional"},
      "complete": {"kind": "terminal", "result": "required"}
    }
  }
}
```

- `statusProperty` and `resultProperty` are JSON Pointers within the task-specific
  payload. The current task contracts use `/status` and `/result`.
- `statuses` keys must match the task schema's root `status` enum.
- `kind` describes the lifecycle category and is not an outcome or approval.
- `result: optional` allows incomplete results; `result: required` enables the
  generic validator's result-presence checks.
- Task-specific schemas may add `requiredResultPaths` arrays for milestone or
  terminal statuses. Paths are JSON Pointers relative to the task payload; the
  current contracts use `/result/<field>` paths derived from the result schema's
  required fields.
- Unknown `x-sdlc-*` metadata is invalid until documented here and covered by the
  schema-audit tests.

The envelope `processingStatus`, task lifecycle `status`, and result-specific
`status` are independent values. Validation must never derive one from another.
Ordinary JSON Schema keywords remain authoritative for types, enums, required
fields, formats, and additional properties; metadata adds lifecycle policy only.

## Reference schemas

A standalone string schema supported by `ref validate --ref` must declare
the `x-sdlc-reference-type` convention with value `true`, have a stable absolute `$id`, and provide at least
one root-level string example. Reference-schema discovery is recursive under the
installed schema registry and is separate from the target repository root.

## Field roles and registry

The `x-field-role` convention documents whether a schema field is authoritative or derived. Schema
registries are resolved by the installed schema validator; target repositories do
not need to contain a `schemas/` directory. Keep schema IDs versioned under
`https://schemas.handschuh.dev/sdlc/` and use repository-relative schema paths when
invoking `schema-validate --root`.

## Convention audit

The schema audit enumerates every `x-sdlc-*` key in the registry. A new key must
be added to this document with its location, shape, consumer, interpretation,
and validation behavior before it is introduced. Unknown metadata is ignored by
ordinary JSON Schema but is rejected by lifecycle-aware host validation unless it
has an explicitly documented interpretation.

The `x-identifier-prefix-conventions` convention may be attached to a
reference schema to declare entity-kind prefixes, examples, and naming guidance
for repository-unique identifiers. Reference discovery treats it as descriptive
metadata; identifier validation and migration consume the declared conventions
where the selected reference type supports them.
