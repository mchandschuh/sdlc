import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError } from '../../../core/discovery.js';
import { formatHumanItem, listTaskCollection, resolveCollectionDefinition } from '../../../core/collection-list.js';
import { resolveOperativeRoot } from '../../../core/operative-root.js';

export default function createTaskCollectionListCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'task <collection> list',
    describe: 'List a schema-backed task collection',
    builder: (argv) => argv
      .usage('Usage: sdlc task <collection> list --task <task-id> [--json]')
      .positional('collection', { type: 'string', describe: 'Registered collection name' })
      .option('task', { type: 'string', describe: 'Canonical task ID' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.collection) || typeof argv.collection !== 'string' || argv.collection.length === 0) throw new DiscoveryError('Usage: sdlc task <collection> list --task <task-id> [--json]');
      if (Array.isArray(argv.task) || typeof argv.task !== 'string' || argv.task.length === 0) throw new DiscoveryError('Usage: sdlc task <collection> list --task <task-id> [--json]');
      const report = await listTaskCollection(await resolveOperativeRoot(), argv.task, argv.collection);
      const definition = resolveCollectionDefinition(report.documentType, report.collection);
      if (argv.json === true) console.log(JSON.stringify(report, null, 2));
      else {
        if (!definition) throw new DiscoveryError(report.findings[0] ?? `Unknown collection: ${argv.collection}`);
        console.log(`Task ${argv.task} ${argv.collection}:`);
        for (const item of report.data) console.log(`  ${formatHumanItem(item, definition)}`);
        if (report.data.length === 0) console.log('  none');
      }
      for (const finding of report.findings) console.error(`Finding: ${finding}`);
      return report.valid ? 0 : 1;
    },
  };
}