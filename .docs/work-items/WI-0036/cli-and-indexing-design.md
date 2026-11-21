# WI-0036 declarative collection indexing and CLI design

## Boundary

The feature consists of one declarative collection registry, one constrained document indexer, one collection response envelope, and thin CLI command adapters. The registry is keyed by effective document schema and collection name. Work-item documents use their root `schema`; task documents use `task.taskSchema` from the common task envelope.

The index expression is an exact JSON Pointer-like property path. It does not support recursive descent, wildcards, filters, executable expressions, or arbitrary user-supplied JSONPath. Nested collections declare a parent collection, a parent identifier path, a command argument, and a child path.

## Declarative definition

```ts
interface CollectionDefinition {
  readonly documentType: string;
  readonly name: string;
  readonly index: {
    readonly collectionPath: string;
    readonly parent?: {
      readonly argument: string;
      readonly identifierPath: string;
    };
    readonly childPath?: string;
  };
  readonly display: {
    readonly identifier: string;
    readonly title?: string;
    readonly text: string;
  };
  readonly identity: {
    readonly mode: 'field' | 'reference' | 'index';
    readonly referenceKind?: string;
  };
}
```

Example:

```ts
{
  documentType: 'https://schemas.handschuh.dev/sdlc/task-implementation/v1',
  name: 'objective',
  index: { collectionPath: '/task/intent/objectives' },
  display: { identifier: '/id', text: '/statement' },
  identity: { mode: 'field', referenceKind: 'objective' },
}
```

## Indexing behavior

1. Load the document using the existing JSON/YAML document-loading boundary.
2. Determine its effective document schema.
3. Resolve the registry entry by `(documentType, collection)`.
4. Resolve the exact collection path.
5. If a parent selector is declared, require its CLI argument, find exactly one parent by its declared identifier path, and resolve the child path.
6. Require the selected value to be an array.
7. Preserve source order and return complete item values.
8. For object-backed entity collections, reject missing or duplicate authoritative identifiers.
9. Return structured findings for unknown definitions, invalid paths, missing parents, non-arrays, and unsupported identity modes.

## Human and JSON output

Human-readable mode projects each item to:

```text
<identifier>  [<title>]  <text>
```

The formatter uses only declared selectors. It must not guess between `statement`, `description`, `question`, `summary`, `name`, or other fields.

JSON mode returns the complete indexed objects without projection:

```json
{
  "schema": "https://schemas.handschuh.dev/sdlc/collection-list/v1",
  "valid": true,
  "documentType": "https://schemas.handschuh.dev/sdlc/task-implementation/v1",
  "collection": "objective",
  "indexExpression": "/task/intent/objectives",
  "source": {
    "fullPath": "/absolute/document.yaml",
    "repositoryPath": ".docs/work-items/WI-0036/steps/task.yaml",
    "format": "yaml"
  },
  "data": [
    {
      "id": "WI-0036-10000000_OBJ-001",
      "statement": "Implement the declarative index registry."
    }
  ],
  "findings": []
}
```

## CLI contract

The ergonomic command shape is:

```text
sdlc work-item <collection> list --work-item <work-item-id> [--json]
sdlc task <collection> list --task <task-id> [--json]
```

Nested work-item collections add their parent argument:

```text
sdlc work-item acceptance-criterion list \
  --work-item WI-0036 \
  --requirement WI-0036_REQ_001 \
  --json
```

Task collection selection is schema-aware. A generic `task objective list` resolves implementation, design, test-strategy, and rework definitions according to `task.taskSchema`, rather than branching on task type in each command.

## Response contract

A collection-list response is distinct from single-reference resolution. Existing `sdlc-ref/resolution/v2` behavior remains unchanged and continues to represent one selected resource. Collection listing introduces `schemas/sdlc-collection-list/v1/sdlc-collection-list.schema.json` with source metadata, effective document schema, collection name, index expression, complete `data`, and structured findings.

## Error behavior

The command returns a non-zero exit status when the document cannot be loaded, the collection definition is unknown, an index path is invalid, a nested parent is absent or ambiguous, the resolved value is not an array, or an entity collection lacks unique authoritative identity. Valid empty arrays return zero with an empty `data` array.

## Plain-string arrays

Collections whose items are plain strings and have no authoritative identifier are not entity-style list definitions. They remain available through complete JSON output unless a definition explicitly declares positional identity and the CLI documents that the position is not a stable resource identifier.
