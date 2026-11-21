import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError } from '../../../core/discovery.js';
import { resolveOperativeRoot } from '../../../core/operative-root.js';
import { migrateWorkItemReferences } from '../../../core/task-local-migration.js';

export default function createMigrateWorkItemCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'ref migrate-work-item-up',
    describe: 'Migrate references under one complete work-item directory',
    builder: (argv) => argv
      .usage('Usage: sdlc ref migrate-work-item-up --work-item <work-item-id> [--json]')
      .option('work-item', { type: 'string', describe: 'Work-item ID' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.workItem)) throw new DiscoveryError('Duplicate --work-item option.');
      if (typeof argv.workItem !== 'string' || argv.workItem.length === 0) throw new DiscoveryError('Usage: sdlc ref migrate-work-item-up --work-item <work-item-id> [--json]');
      const report = await migrateWorkItemReferences(await resolveOperativeRoot(), argv.workItem);
      console.log(JSON.stringify(report, null, 2));
      return report.findings.length === 0 ? 0 : 1;
    },
  };
}