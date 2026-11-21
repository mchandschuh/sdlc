import type { SdlcCommandContext, SdlcCommandModule } from '../command-types.js';
import { DiscoveryError, statTrackedPath } from '../../core/discovery.js';
import { resolveOperativeRoot } from '../../core/operative-root.js';

export default function createStatCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'stat',
    describe: 'Inspect one repository-tracked file',
    builder: (argv) => argv
      .usage('Usage: sdlc stat --path <file-path>')
      .option('path', { type: 'string', describe: 'Repository-relative file path' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.path)) throw new DiscoveryError('Duplicate --path option.');
      if (typeof argv.path !== 'string' || argv.path.length === 0) throw new DiscoveryError('Usage: sdlc stat --path <file-path>');
      const report = await statTrackedPath(await resolveOperativeRoot(), argv.path);
      console.log(JSON.stringify(report, null, 2));
      return 0;
    },
  };
}