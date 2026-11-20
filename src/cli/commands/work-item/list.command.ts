import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { discoverWorkItems } from '../../../core/discovery.js';
import { resolveCommandContext } from '../../../core/operative-root.js';

export default function createWorkItemListCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'work-item list',
    describe: 'List .docs/work-items/*',
    builder: (argv) => argv
      .usage('Usage: sdlc work-item list [--work-item <work-item>] [--json]')
      .option('work-item', { type: 'string', describe: 'Limit output to one work-item ID' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      const context = await resolveCommandContext();
      const discovered = await discoverWorkItems(context.repositoryRoot);
      const report = typeof argv.workItem === 'string'
        ? { ...discovered, items: discovered.items.filter((item) => item.workItemId === argv.workItem) }
        : discovered;
      if (argv.json === true) console.log(JSON.stringify({ schema: 'sdlc-work-item-list/v1', ...report }, null, 2));
      else {
        console.log('Work items:');
        for (const item of report.items) console.log(`  ${item.workItemId}  ${item.status.padEnd(12)} ${item.title} (${item.path})`);
        if (report.items.length === 0) console.log('  none');
        for (const finding of report.findings) console.error(`Finding: ${finding}`);
      }
      return report.findings.length === 0 ? 0 : 1;
    },
  };
}