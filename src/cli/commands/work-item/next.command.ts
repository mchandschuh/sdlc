import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { resolveCommandContext } from '../../../core/operative-root.js';
import { discoverWorkItems } from '../../../core/discovery.js';

export default function createWorkItemNextCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'work-item next',
    describe: 'Select the first non-complete work item',
    builder: (argv) => argv
      .usage('Usage: sdlc work-item next [--json]')
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      const report = await discoverWorkItems((await resolveCommandContext()).repositoryRoot);
      const workItem = report.items.find((item) => item.status !== 'complete') ?? null;
      const response = { schema: 'https://schemas.handschuh.dev/sdlc/cli-work-item-next/v1', selection: workItem ? 'selected' : 'none', workItem, findings: report.findings } as const;
      if (argv.json === true) console.log(JSON.stringify(response, null, 2));
      else if (workItem) console.log(`Next work item: ${workItem.workItemId}  ${workItem.status}  ${workItem.title}`);
      else console.log('No incomplete work item found.');
      return report.findings.length === 0 ? 0 : 1;
    },
  };
}