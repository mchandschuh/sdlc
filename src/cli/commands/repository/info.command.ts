import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { repositoryInfo } from '../../../core/repository.js';

export default function createRepositoryInfoCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'repository info',
    describe: 'Find the nearest Git repository',
    builder: (argv) => argv
      .usage('Usage: sdlc repository info --path <path> [--json]')
      .option('path', { type: 'string', describe: 'Path from which to search' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (typeof argv.path !== 'string' || argv.path.length === 0) throw new Error('Usage: sdlc repository info --path <path> [--json]');
      const report = await repositoryInfo(argv.path);
      if (argv.json === true) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`Repository: ${report.repositoryRoot}`);
        console.log(`Git directory: ${report.gitDir}`);
      }
      return 0;
    },
  };
}