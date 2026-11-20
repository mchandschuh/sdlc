import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError } from '../../../core/discovery.js';
import { resolveCommandContext } from '../../../core/operative-root.js';
import { validateWorkItem, type WorkItemValidationReport } from '../../../core/work-item-validation.js';

function printReport(report: WorkItemValidationReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Work item validation for ${report.workItemId}: ${report.valid ? 'passed' : 'failed'}`);
  console.log(`  Objects: ${report.validObjectCount}/${report.objectCount} valid`);
  for (const object of report.objects) {
    console.log(`  ${object.valid ? 'PASS' : 'FAIL'} ${object.objectType} ${object.path}`);
    for (const finding of object.findings) console.error(`Finding: ${finding}`);
  }
}

export default function createWorkItemValidateCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'work-item validate',
    describe: 'Validate one complete work item',
    builder: (argv) => argv
      .usage('Usage: sdlc work-item validate --work-item <work-item> [--repository-root <path>] [--json]')
      .option('work-item', { type: 'string', describe: 'Work-item ID' })
      .option('repository-root', { type: 'string', describe: 'Use an explicit repository root' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.workItem)) throw new DiscoveryError('Duplicate --work-item option.');
      if (typeof argv.workItem !== 'string' || argv.workItem.length === 0) throw new DiscoveryError('Usage: sdlc work-item validate --work-item <work-item> [--repository-root <path>] [--json]');
      const context = await resolveCommandContext(typeof argv.repositoryRoot === 'string' ? argv.repositoryRoot : undefined);
      const report = await validateWorkItem(context.repositoryRoot, argv.workItem, undefined, context.schemaRegistryRoot);
      printReport(report, argv.json === true);
      return report.valid ? 0 : 1;
    },
  };
}