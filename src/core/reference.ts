import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const REFERENCE_VALIDATION_SCHEMA = 'https://schemas.handschuh.dev/sdlc/ref/validation/v1';

export interface ReferenceSchema {
  readonly id: string;
  readonly path: string;
  readonly examples: readonly string[];
  readonly schema: Record<string, unknown>;
}

export interface ReferenceMatch {
  readonly schemaId: string;
  readonly path: string;
}

export interface ReferenceValidationReport {
  readonly schema: typeof REFERENCE_VALIDATION_SCHEMA;
  readonly ref: string;
  readonly valid: boolean;
  readonly matches: readonly ReferenceMatch[];
  readonly globalResourceId?: string;
  readonly repositoryPath?: string;
  readonly findings: readonly string[];
}

const schemaCache = new Map<string, Promise<ReferenceSchema[]>>();

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function schemaFiles(directory: string): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await schemaFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.schema.json')) files.push(path);
  }
  return files;
}

export async function discoverReferenceSchemas(repositoryRoot: string): Promise<ReferenceSchema[]> {
  const cached = schemaCache.get(repositoryRoot);
  if (cached) return cached;
  const pending = discoverReferenceSchemasUncached(repositoryRoot);
  schemaCache.set(repositoryRoot, pending);
  return pending;
}

async function discoverReferenceSchemasUncached(repositoryRoot: string): Promise<ReferenceSchema[]> {
  const root = join(repositoryRoot, 'schemas');
  const schemas: ReferenceSchema[] = [];
  for (const path of await schemaFiles(root)) {
    const schema = objectValue(JSON.parse(await readFile(path, 'utf8')));
    if (!schema || schema['x-sdlc-reference-type'] !== true) continue;
    if (schema.type !== 'string' || typeof schema.$id !== 'string') throw new Error(`Invalid reference schema metadata: ${path}`);
    if (!Array.isArray(schema.examples) || schema.examples.length === 0 || schema.examples.some((example) => typeof example !== 'string')) {
      throw new Error(`Reference schema requires string examples: ${path}`);
    }
    schemas.push({
      id: schema.$id,
      path: relative(repositoryRoot, path).split('\\').join('/'),
      examples: schema.examples as string[],
      schema,
    });
  }
  return schemas.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
}

function matchesSchema(schema: unknown, value: string): boolean {
  const object = objectValue(schema);
  if (!object) return false;
  if (typeof object.pattern === 'string' && new RegExp(object.pattern, 'u').test(value)) return true;
  for (const key of ['oneOf', 'anyOf'] as const) {
    const alternatives = object[key];
    if (Array.isArray(alternatives) && alternatives.some((alternative) => matchesSchema(alternative, value))) return true;
  }
  const allOf = object.allOf;
  return Array.isArray(allOf) && allOf.every((alternative) => matchesSchema(alternative, value));
}

export async function validateReference(repositoryRoot: string, ref: string): Promise<ReferenceValidationReport> {
  const schemas = await discoverReferenceSchemas(repositoryRoot);
  const matches = schemas
    .filter((candidate) => matchesSchema(candidate.schema, ref))
    .map(({ id, path }) => ({ schemaId: id, path }));
  return {
    schema: REFERENCE_VALIDATION_SCHEMA,
    ref,
    valid: matches.length > 0,
    matches,
    findings: matches.length > 0 ? [] : ['No registered reference schema matched the supplied reference.'],
  };
}