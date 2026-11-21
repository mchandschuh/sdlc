import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError } from '../../../core/discovery.js';
import { resolveCommandContext } from '../../../core/operative-root.js';
import { validateWorkItem, type WorkItemValidationReport } from '../../../core/work-item-validation.js';

function printReport(report: WorkItemValidationReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Task validation: ${report.valid ? 'passed' : 'failed'}`);
  for (const object of report.objects) {
    console.log(`  ${object.valid ? 'PASS' : 'FAIL'} ${object.objectType} ${object.path}`);
    for (const finding of object.findings) console.error(`Finding: ${finding}`);
  }
}

export default function createTaskValidateCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'task validate',
    describe: 'Validate one canonical task',
    builder: (argv) => argv
      .usage('Usage: sdlc task validate --task <task-identifier> [--repository-root <path>] [--json]')
      .option('task', { type: 'string', describe: 'Canonical task identifier' })
      .option('repository-root', { type: 'string', describe: 'Use an explicit repository root' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.task)) throw new DiscoveryError('Duplicate --task option.');
      if (typeof argv.task !== 'string' || argv.task.length === 0) throw new DiscoveryError('Usage: sdlc task validate --task <task-identifier> [--repository-root <path>] [--json]');
      if (!/^[A-Z]{1,10}-[0-9]+-[0-9]{8}$/u.test(argv.task)) throw new DiscoveryError(`Invalid task identifier: ${argv.task}`);
      const workItemId = argv.task.slice(0, argv.task.lastIndexOf('-'));
      const context = await resolveCommandContext(typeof argv.repositoryRoot === 'string' ? argv.repositoryRoot : undefined);
      const report = await validateWorkItem(context.repositoryRoot, workItemId, argv.task, context.schemaRegistryRoot);
      printReport(report, argv.json === true);
      return report.valid ? 0 : 1;
    },
  };
}