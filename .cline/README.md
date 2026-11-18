# Repository Agent Conventions

## Persist schemas for every input and output object

Every input or output object introduced, persisted, serialized, or exposed by
this repository **must have a versioned schema persisted under the repository's
`schemas/` directory**.

This applies to, at minimum:

- CLI JSON input and output objects;
- work-item, task, evidence, and result records;
- configuration and command-file objects;
- library request and response objects; and
- HTTP request, response, and error envelopes.

### Required practice

1. Add the schema before or with the code that introduces the object.
2. Store it below the canonical high-level-object/version path, for example:
   `schemas/sdlc-stat/v1/sdlc-state.schema.json`.
3. Give the schema a stable versioned `$id` under
   `https://schemas.handschuh.dev/sdlc/`.
4. Use JSON Schema 2020-12 and keep the contract closed unless an explicit
   extension boundary is documented.
5. Reference the persisted schema from implementation, task records, or
   response metadata when consumers need to select the contract.
6. Validate the schema itself and at least one representative instance before
   committing the feature.

### Reference schema registry convention

Every standalone string schema that is supported by `sdlc ref validate --ref
<reference>` **must** declare the root metadata property
`"x-sdlc-reference-type": true`.

The marked schema must also:

- have `type: "string"`;
- have a stable `$id` under `https://schemas.handschuh.dev/sdlc/`; and
- provide at least one valid root-level `examples` value.

The reference validator and its tests must discover marked schemas recursively
under `schemas/`; they must not maintain a hardcoded filename or type list. Each
root example is an executable fixture for the dynamic reference-validation test,
so adding a new marked reference schema and example automatically expands that
test's coverage. A schema that only wraps a reference inside an object is not a
direct `<reference>` type unless the command explicitly supports that whole
object form and the schema is marked accordingly.

An inline TypeScript interface, a string such as `sdlc-example/v1`, a README
example, or an unversioned ad hoc JSON shape is not a substitute for a persisted
schema. If an object has multiple versions, persist each version separately and
never silently change an existing version's meaning.

### Completion rule

A feature that introduces an input or output object is incomplete until its
corresponding schema is present under `schemas/`, included in the repository
schema audit, and covered by the feature's validation evidence.
