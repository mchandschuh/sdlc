import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError } from '../../../core/discovery.js';
import { buildDependencyGraph } from '../../../core/dependency-graph.js';
import { resolveOperativeRoot } from '../../../core/operative-root.js';

export default function createTaskLinearizeCommand(_context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'task linearize',
    describe: 'Linearize explicit task dependencies',
    builder: (argv) => argv
      .usage('Usage: sdlc task linearize --work-item <work-item> [--json]')
      .option('work-item', { type: 'string', describe: 'Work-item ID' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.workItem)) throw new DiscoveryError('Duplicate --work-item option.');
      if (typeof argv.workItem !== 'string' || argv.workItem.length === 0) throw new DiscoveryError('Usage: sdlc task linearize --work-item <work-item> [--json]');
      const report = await buildDependencyGraph(await resolveOperativeRoot(), argv.workItem);
      if (argv.json === true) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`Task linearization for ${argv.workItem}:`);
        if (report.valid) for (const item of report.linearization) console.log(`  ${item.rank}. ${item.taskUid}${item.dependencies.length ? ` depends-on ${item.dependencies.join(', ')}` : ''}`);
        else for (const item of report.findings) console.error(`Finding [${item.code}]: ${item.message}`);
      }
      return report.valid ? 0 : 1;
    },
  };
}