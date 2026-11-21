import type { SdlcCommandContext, SdlcCommandModule } from '../../command-types.js';
import { DiscoveryError } from '../../../core/discovery.js';
import { resolveCommandContext } from '../../../core/operative-root.js';
import { resolveReference } from '../../../core/reference-resolution.js';

export default function createReferenceResolveCommand(context: SdlcCommandContext): SdlcCommandModule {
  return {
    command: 'ref resolve',
    describe: 'Resolve a repository-local reference',
    builder: (argv) => argv
      .usage('Usage: sdlc ref resolve --ref <reference> [--depth [positive-integer]] [--json]')
      .option('ref', { type: 'string', describe: 'Reference to resolve' })
      .option('depth', { type: 'number', default: 1, describe: 'Reference expansion depth' })
      .option('json', { type: 'boolean', default: false, describe: 'Emit JSON output' }),
    handler: async (argv) => {
      if (Array.isArray(argv.ref)) throw new DiscoveryError('Duplicate --ref option.');
      if (typeof argv.ref !== 'string' || argv.ref.length === 0) throw new DiscoveryError('Usage: sdlc ref resolve --ref <reference>');
      if (Array.isArray(argv.depth)) throw new DiscoveryError('Duplicate --depth option.');
      const depth = argv.depth === undefined ? 1 : Number(argv.depth);
      if (!Number.isSafeInteger(depth) || depth < 1) throw new DiscoveryError('--depth requires a positive integer.');
      const repository = await resolveCommandContext();
      const report = await resolveReference(repository.repositoryRoot, context.schemaRegistryRoot, argv.ref, depth);
      console.log(JSON.stringify(report, null, 2));
      return report.valid ? 0 : 1;
    },
  };
}