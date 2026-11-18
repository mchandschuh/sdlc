import { repositoryInfo } from './repository.js';
import { DiscoveryError } from './discovery.js';

/**
 * Resolve the repository whose contents repository-dependent commands operate on.
 * Keep this policy boundary separate from command handlers so root selection can
 * change without coupling every command to the current working directory.
 */
export async function resolveOperativeRoot(): Promise<string> {
  try {
    const report = await repositoryInfo(process.cwd());
    return report.repositoryRoot;
  } catch (error) {
    throw new DiscoveryError(error instanceof Error ? error.message : 'Operative repository discovery failed');
  }
}