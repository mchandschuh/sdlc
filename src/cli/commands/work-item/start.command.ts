import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError } from '../../../core/discovery.js';
import { resolveCommandContext } from '../../../core/operative-root.js';
import { startWorkItem } from '../../../core/work-item-start.js';

export default function createWorkItemStartCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'work-item start',
    describe: 'Start processing on the declared context branch',
    builder: (argv) => argv
      .usage('Usage: sdlc work-item start --work-item <work-item>')
      .option('work-item', { type: 'string', describe: 'Work-item ID' })
      .option('repository-root', { type: 'string', describe: 'Use an explicit repository root' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.workItem)) throw new DiscoveryError('Duplicate --work-item option.');
      if (typeof argv.workItem !== 'string' || argv.workItem.length === 0) throw new DiscoveryError('Usage: sdlc work-item start --work-item <work-item>');
      const context = await resolveCommandContext(typeof argv.repositoryRoot === 'string' ? argv.repositoryRoot : undefined);
      const report = await startWorkItem(context.repositoryRoot, argv.workItem);
      if (argv.json === true) console.log(JSON.stringify(report, null, 2));
      else console.log(report.message);
      return 0;
    },
  };
}