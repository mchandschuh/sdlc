# WI-0036 reference implementation contract

This document is a non-executable implementation reference. It defines the smallest reusable functions expected from the implementation while leaving module placement and exact TypeScript names to the implementation task.

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

interface CollectionSource {
  readonly fullPath: string;
  readonly repositoryPath: string;
  readonly format: 'json' | 'yaml';
}

interface CollectionListReport {
  readonly schema: 'https://schemas.handschuh.dev/sdlc/collection-list/v1';
  readonly valid: boolean;
  readonly documentType: string;
  readonly collection: string;
  readonly indexExpression: string;
  readonly source: CollectionSource | null;
  readonly data: readonly unknown[];
  readonly findings: readonly string[];
}
```

```ts
function readPath(value: unknown, expression: string): unknown
function resolveCollectionDefinition(
  documentType: string,
  collection: string,
): CollectionDefinition | undefined
function indexCollection(
  document: unknown,
  definition: CollectionDefinition,
  arguments: Readonly<Record<string, string>>,
): readonly unknown[]
function projectHumanItem(
  item: unknown,
  definition: CollectionDefinition,
): { identifier: string; title?: string; text: string }
function listCollection(
  sourceDocument: ParsedDocument,
  documentType: string,
  collection: string,
  arguments: Readonly<Record<string, string>>,
): CollectionListReport
```

The path reader must accept only absolute property paths with JSON Pointer escaping. It must reject array wildcards, recursive descent, predicates, expressions, and prototype-sensitive property traversal. A definition may navigate through a known array only when the parent-selection rule explicitly selects one item by its declared identifier path.

The list report always carries the original selected values in `data`. Human projection is performed only by the CLI formatter and never mutates the report values.

Tests must assert that JSON output retains fields not used by human projection, including references, status values, nested objects, and arrays.
