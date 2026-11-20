import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError } from '../../../core/discovery.js';
import { discoverTasks } from '../../../core/discovery.js';
import { resolveOperativeRoot } from '../../../core/operative-root.js';

function printTasks(workItemId: string, report: Awaited<ReturnType<typeof discoverTasks>>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ schema: 'sdlc-task-list/v1', workItemId, ...report }, null, 2));
    return;
  }
  console.log(`Tasks for ${workItemId}:`);
  for (const task of report.items) console.log(`  ${task.taskUid}  ${task.taskType.padEnd(14)} ${task.processingStatus.padEnd(22)} ${task.path}`);
  if (report.items.length === 0) console.log('  none');
  for (const finding of report.findings) console.error(`Finding: ${finding}`);
}

export default function createTaskListCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'task list',
    describe: 'List the selected work-item task records',
    builder: (argv) => argv
      .usage('Usage: sdlc task list --work-item <work-item> [--json]')
      .option('work-item', { type: 'string', describe: 'Work-item ID' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.workItem)) throw new DiscoveryError('Duplicate --work-item option.');
      if (typeof argv.workItem !== 'string' || argv.workItem.length === 0) throw new DiscoveryError('Usage: sdlc task list --work-item <work-item> [--json]');
      const report = await discoverTasks(await resolveOperativeRoot(), argv.workItem);
      printTasks(argv.workItem, report, argv.json === true);
      return report.findings.length > 0 ? 1 : 0;
    },
  };
}