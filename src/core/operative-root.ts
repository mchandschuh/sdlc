import { commandContext, type SdlcCommandContext } from './configuration.js';

/**
 * Resolve the repository whose contents repository-dependent commands operate on.
 * Keep this policy boundary separate from command handlers so root selection can
 * change without coupling every command to the current working directory.
 */
export async function resolveOperativeRoot(explicitRepositoryRoot?: string): Promise<string> {
  return (await commandContext(explicitRepositoryRoot)).repositoryRoot;
}

export async function resolveSchemaRoot(explicitRepositoryRoot?: string): Promise<string> {
  return (await commandContext(explicitRepositoryRoot)).schemaRegistryRoot;
}

export async function resolveCommandContext(explicitRepositoryRoot?: string): Promise<SdlcCommandContext> {
  return commandContext(explicitRepositoryRoot);
}