import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError, discoverNextTask, type TaskSummary } from '../../../core/discovery.js';
import { resolveOperativeRoot } from '../../../core/operative-root.js';

function printNextTask(workItemId: string, task: TaskSummary | null, json: boolean): void {
  const response = { schema: 'https://schemas.handschuh.dev/sdlc/task-next/v1', workItemId, selection: task ? 'selected' : 'none', task } as const;
  if (json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (task) {
    console.log(`Next task for ${workItemId}:`);
    console.log(`  ${task.taskUid}  ${task.taskType.padEnd(14)} ${task.processingStatus.padEnd(22)} ${task.path}`);
  } else console.log(`No task requires processing for ${workItemId}.`);
}

export default function createTaskNextCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'task next',
    describe: 'Select the next unprocessed task',
    builder: (argv) => argv
      .usage('Usage: sdlc task next --work-item <work-item> [--json]')
      .option('work-item', { type: 'string', describe: 'Work-item ID' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.workItem)) throw new DiscoveryError('Duplicate --work-item option.');
      if (typeof argv.workItem !== 'string' || argv.workItem.length === 0) throw new DiscoveryError('Usage: sdlc task next --work-item <work-item> [--json]');
      if (!/^[A-Z]{1,10}-[0-9]+$/u.test(argv.workItem)) throw new DiscoveryError(`Invalid work-item ID: ${argv.workItem}`);
      const task = await discoverNextTask(await resolveOperativeRoot(), argv.workItem);
      printNextTask(argv.workItem, task, argv.json === true);
      return 0;
    },
  };
}