import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, resolveConfigJson } from 'nodejs-common/dist/src/config/index.js';
import { DiscoveryError } from './discovery.js';
import { resolveRepositoryRoot } from './repository-root.js';

export const SDLC_CONFIG_SCHEMA = 'https://schemas.handschuh.dev/sdlc/config/v1';

export interface SdlcConfig {
  readonly schema?: typeof SDLC_CONFIG_SCHEMA;
  /** Deprecated legacy field; retained for config compatibility but never selected. */
  readonly repositoryRoot?: string;
  readonly schemaRegistryRoot?: string;
}

export interface SdlcCommandContext {
  readonly repositoryRoot: string;
  readonly schemaRegistryRoot: string;
  readonly config?: SdlcConfig;
  readonly configSource?: string;
  readonly configSourcePath?: string;
}

export interface SdlcConfigResolutionOptions {
  readonly applicationSourceDirectory?: string;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface SdlcConfigResolution {
  readonly config?: SdlcConfig;
  readonly source?: string;
  readonly sourcePath?: string;
}

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function existingDirectory(value: unknown, label: string): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.startsWith('/')) throw new DiscoveryError(`${label} must be an absolute path.`);
  const path = resolve(value);
  try {
    if (!(await stat(path)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new DiscoveryError(`${label} does not exist or is not a directory: ${path}`);
  }
  return path;
}

function assertConfigPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.split('/').includes('..')) throw new DiscoveryError(`${label} must be an absolute path without parent traversal.`);
  return value;
}

function assertConfig(value: Record<string, unknown>): SdlcConfig {
  const allowed = new Set(['schema', 'repositoryRoot', 'schemaRegistryRoot']);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new DiscoveryError(`Unsupported sdlc config property: ${unexpected}`);
  if (value.schema !== SDLC_CONFIG_SCHEMA) throw new DiscoveryError(`Configuration schema must be ${SDLC_CONFIG_SCHEMA}.`);
  const repositoryRoot = value.repositoryRoot === undefined ? undefined : assertConfigPath(value.repositoryRoot, 'repositoryRoot');
  const schemaRegistryRoot = value.schemaRegistryRoot === undefined ? undefined : assertConfigPath(value.schemaRegistryRoot, 'schemaRegistryRoot');
  return { schema: SDLC_CONFIG_SCHEMA, ...(repositoryRoot ? { repositoryRoot } : {}), ...(schemaRegistryRoot ? { schemaRegistryRoot } : {}) };
}

export async function resolveSdlcConfig(options: SdlcConfigResolutionOptions = {}): Promise<SdlcConfigResolution> {
  try {
    const result = await resolveConfigJson({
      applicationSourceDirectory: options.applicationSourceDirectory ?? packageRoot,
      appSlug: 'sdlc',
      homeDirectory: options.homeDirectory,
      environment: options.environment,
    });
    const value = objectValue(result.value);
    if (!value) throw new DiscoveryError('SDLC configuration must be a JSON object.');
    const config = assertConfig(value);
    return {
      config,
      source: result.layers.at(-1)?.source,
      sourcePath: result.layers.at(-1)?.absolutePath,
    };
  } catch (error) {
    if (error instanceof ConfigError && error.code === 'CONFIGURATION_FILE_NOT_FOUND') return {};
    throw new DiscoveryError(error instanceof Error ? error.message : 'Unable to resolve sdlc configuration.');
  }
}

export async function commandContext(explicitRepositoryRoot?: string, options: SdlcConfigResolutionOptions = {}): Promise<SdlcCommandContext> {
  const selected = await resolveSdlcConfig(options);
  const repositoryRoot = (await resolveRepositoryRoot({ startingPath: explicitRepositoryRoot ?? process.cwd() })).repositoryRoot;
  const schemaRegistryRoot = await existingDirectory(selected.config?.schemaRegistryRoot, 'schemaRegistryRoot') ?? packageRoot;
  const schemas = resolve(schemaRegistryRoot, 'schemas');
  if (!(await stat(schemas).catch(() => undefined))?.isDirectory()) throw new DiscoveryError(`Schema registry does not contain schemas/: ${schemas}`);
  return { repositoryRoot, schemaRegistryRoot, config: selected.config, configSource: selected.source, configSourcePath: selected.sourcePath };
}
