import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI interface', () => {
  it.each(['-h', '--help'])('prints help for %s', async (argument) => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main([argument])).resolves.toBe(0);

    expect(output.join('\n')).toContain('Usage: nodejs-cli-pattern [options]');
    expect(output.join('\n')).toContain('-h, --help');
    expect(output.join('\n')).toContain('-v, --version');
  });

  it.each(['-v', '--version'])('prints the package version for %s', async (argument) => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main([argument])).resolves.toBe(0);

    expect(output).toEqual(['0.1.0']);
  });

  it('prints help when no option is supplied', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => output.push(values.join(' ')));

    await expect(main([])).resolves.toBe(0);

    expect(output.join('\n')).toContain('Usage: nodejs-cli-pattern [options]');
  });

  it('fails with a stable message for an unknown option', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => errors.push(values.join(' ')));

    await expect(main(['--unknown'])).resolves.toBe(2);

    expect(errors).toEqual([
      'Unknown option: --unknown',
      'Run "nodejs-cli-pattern --help" to see available options.',
    ]);
  });
});
