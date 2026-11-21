import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError } from '../../../core/discovery.js';
import { validateReference, type ReferenceValidationReport } from '../../../core/reference.js';
import { resolveCommandContext } from '../../../core/operative-root.js';
import { validateReferenceResource } from '../../../core/reference-resolution.js';

export default function createReferenceValidateCommand(context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'ref validate',
    describe: 'Validate one schema-registered reference',
    builder: (argv) => argv
      .usage('Usage: sdlc ref validate --ref <reference> [--json]')
      .option('ref', { type: 'string', describe: 'Reference to validate' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.ref)) throw new DiscoveryError('Duplicate --ref option.');
      if (typeof argv.ref !== 'string' || argv.ref.length === 0) throw new DiscoveryError('Usage: sdlc ref validate --ref <reference>');
      let repositoryRoot: string | undefined;
      try {
        const repository = await resolveCommandContext();
        repositoryRoot = repository.repositoryRoot;
      } catch {
        const report = await validateReference(context.schemaRegistryRoot, argv.ref);
        console.log(JSON.stringify(report, null, 2));
        return report.valid ? 0 : 1;
      }
      const report: ReferenceValidationReport | Awaited<ReturnType<typeof validateReferenceResource>> = await validateReferenceResource(repositoryRoot, context.schemaRegistryRoot, argv.ref);
      console.log(JSON.stringify(report, null, 2));
      return report.valid ? 0 : 1;
    },
  };
}