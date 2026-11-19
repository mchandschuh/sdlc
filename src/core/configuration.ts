import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigError, resolveConfigJson } from 'nodejs-common/dist/src/config/index.js';
import { DiscoveryError } from './discovery.js';
import { repositoryInfo } from './repository.js';

export const SDLC_CONFIG_SCHEMA = 'https://schemas.handschuh.dev/sdlc/config/v1';

export interface SdlcConfig {
  readonly schema?: typeof SDLC_CONFIG_SCHEMA;
  readonly repositoryRoot?: string;
  readonly schemaRegistryRoot?: string;
}

export interface SdlcCommandContext {
  readonly repositoryRoot: string;
  readonly schemaRegistryRoot: string;
  readonly config?: SdlcConfig;
  readonly configSource?: string;
}

const packageRoot = resolve(new URL('../..', import.meta.url).pathname);

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

async function configured(): Promise<{ readonly config?: SdlcConfig; readonly source?: string }> {
  try {
    const result = await resolveConfigJson({ applicationSourceDirectory: packageRoot, appSlug: 'sdlc' });
    const value = objectValue(result.value) ?? {};
    return {
      config: value as SdlcConfig,
      source: result.layers.at(-1)?.absolutePath,
    };
  } catch (error) {
    if (error instanceof ConfigError && error.code === 'CONFIGURATION_FILE_NOT_FOUND') return {};
    throw new DiscoveryError(error instanceof Error ? error.message : 'Unable to resolve sdlc configuration.');
  }
}

export async function commandContext(explicitRepositoryRoot?: string): Promise<SdlcCommandContext> {
  const selected = await configured();
  const explicit = await existingDirectory(explicitRepositoryRoot, '--repository-root');
  let current: string | undefined;
  let currentError: unknown;
  try {
    current = (await repositoryInfo(process.cwd())).repositoryRoot;
  } catch (error) {
    currentError = error;
  }
  const configuredRoot = await existingDirectory(selected.config?.repositoryRoot, 'repositoryRoot');
  const repositoryRoot = explicit ?? current ?? configuredRoot;
  if (!repositoryRoot) {
    throw new DiscoveryError(currentError instanceof Error ? currentError.message : 'No repository root was found. Run from a Git repository, pass --repository-root, or configure ~/.sdlc/config.json.');
  }
  const schemaRegistryRoot = await existingDirectory(selected.config?.schemaRegistryRoot, 'schemaRegistryRoot') ?? packageRoot;
  const schemas = resolve(schemaRegistryRoot, 'schemas');
  if (!(await stat(schemas).catch(() => undefined))?.isDirectory()) throw new DiscoveryError(`Schema registry does not contain schemas/: ${schemas}`);
  return { repositoryRoot, schemaRegistryRoot, config: selected.config, configSource: selected.source };
}

export async function installDefaultConfig(repositoryRoot: string, overwrite = false): Promise<{ readonly path: string; readonly created: boolean }> {
  const directory = join(homedir(), '.sdlc');
  const path = join(directory, 'config.json');
  const exists = await readFile(path, 'utf8').then(() => true).catch(() => false);
  if (exists && !overwrite) return { path, created: false };
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify({ schema: SDLC_CONFIG_SCHEMA, repositoryRoot }, null, 2)}\n`, 'utf8');
  return { path, created: true };
}