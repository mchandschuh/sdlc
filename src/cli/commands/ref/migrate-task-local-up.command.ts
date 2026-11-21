import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError } from '../../../core/discovery.js';
import { resolveOperativeRoot } from '../../../core/operative-root.js';
import { migrateTaskLocalReferences, migrateTaskLocalReferencesForWorkItem } from '../../../core/task-local-migration.js';

export default function createMigrateTaskLocalCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'ref migrate-task-local-up',
    describe: 'Migrate references under one bounded repository scope',
    builder: (argv) => argv
      .usage('Usage: sdlc ref migrate-task-local-up [--path <path> | --work-item <work-item-id>] [--json]')
      .option('path', { type: 'string', describe: 'Repository-relative path scope' })
      .option('work-item', { type: 'string', describe: 'Work-item scope' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.path)) throw new DiscoveryError('Duplicate --path option.');
      if (Array.isArray(argv.workItem)) throw new DiscoveryError('Duplicate --work-item option.');
      const path = typeof argv.path === 'string' ? argv.path : undefined;
      const workItem = typeof argv.workItem === 'string' ? argv.workItem : undefined;
      if (path && workItem) throw new DiscoveryError('--path and --work-item are mutually exclusive.');
      if (!path && !workItem) throw new DiscoveryError('Usage: sdlc ref migrate-task-local-up [--path <path> | --work-item <work-item-id>]');
      const root = await resolveOperativeRoot();
      const report = path ? await migrateTaskLocalReferences(root, path) : await migrateTaskLocalReferencesForWorkItem(root, workItem!);
      console.log(JSON.stringify(report, null, 2));
      return report.findings.length === 0 ? 0 : 1;
    },
  };
}