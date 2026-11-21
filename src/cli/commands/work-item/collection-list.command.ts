import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError } from '../../../core/discovery.js';
import { formatHumanItem, listWorkItemCollection, resolveCollectionDefinition } from '../../../core/collection-list.js';
import { resolveCommandContext } from '../../../core/operative-root.js';

export default function createWorkItemCollectionListCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'work-item <collection> list',
    describe: 'List a schema-backed work-item collection',
    builder: (argv) => argv
      .usage('Usage: sdlc work-item <collection> list --work-item <work-item> [--requirement <requirement>] [--json]')
      .positional('collection', { type: 'string', describe: 'Registered collection name' })
      .option('work-item', { type: 'string', describe: 'Work-item ID' })
      .option('requirement', { type: 'string', describe: 'Parent requirement ID for nested collections' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.collection) || typeof argv.collection !== 'string' || argv.collection.length === 0) throw new DiscoveryError('Usage: sdlc work-item <collection> list --work-item <work-item> [--requirement <requirement>] [--json]');
      if (Array.isArray(argv.workItem) || typeof argv.workItem !== 'string' || argv.workItem.length === 0) throw new DiscoveryError('Usage: sdlc work-item <collection> list --work-item <work-item> [--requirement <requirement>] [--json]');
      if (Array.isArray(argv.requirement)) throw new DiscoveryError('Duplicate --requirement option.');
      const context = await resolveCommandContext();
      const report = await listWorkItemCollection(context.repositoryRoot, argv.workItem, argv.collection, typeof argv.requirement === 'string' ? { requirement: argv.requirement } : {});
      const definition = resolveCollectionDefinition(report.documentType, report.collection);
      if (argv.json === true) console.log(JSON.stringify(report, null, 2));
      else {
        if (!definition) throw new DiscoveryError(report.findings[0] ?? `Unknown collection: ${argv.collection}`);
        console.log(`Work-item ${argv.workItem} ${argv.collection}:`);
        for (const item of report.data) console.log(`  ${formatHumanItem(item, definition)}`);
        if (report.data.length === 0) console.log('  none');
      }
      for (const finding of report.findings) console.error(`Finding: ${finding}`);
      return report.valid ? 0 : 1;
    },
  };
}