import { describe, expect, it } from 'vitest';

import { parseDelphiCliArgs, parseDelphiSlashCommand } from '../../src/delphi/command.js';

describe('delphi command surface parsing', () => {
  it('parses /delphi defaults', () => {
    const parsed = parseDelphiSlashCommand('/delphi');
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') return;
    expect(parsed.options.horizon).toBe('24h');
    expect(parsed.options.count).toBe(5);
    expect(parsed.options.symbols).toEqual([]);
    expect(parsed.options.dryRun).toBe(true);
    expect(parsed.options.output).toBe('text');
  });

  it('parses /delphi run with explicit options', () => {
    const parsed = parseDelphiSlashCommand(
      '/delphi run --horizon 6h --symbols btc,eth --count 3 --no-dry-run --output json'
    );
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') return;
    expect(parsed.options.horizon).toBe('6h');
    expect(parsed.options.symbols).toEqual(['BTC', 'ETH']);
    expect(parsed.options.count).toBe(3);
    expect(parsed.options.dryRun).toBe(false);
    expect(parsed.options.output).toBe('json');
  });

  it('parses CLI delphi run variants with positional symbols', () => {
    const parsed = parseDelphiCliArgs(['run', 'BTC', 'ETH', '--count', '2']);
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') return;
    expect(parsed.options.symbols).toEqual(['BTC', 'ETH']);
    expect(parsed.options.count).toBe(2);
  });

  it('parses CLI delphi default command without run keyword', () => {
    const parsed = parseDelphiCliArgs(['--horizon', '12h', '--symbols', 'SOL,AVAX']);
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') return;
    expect(parsed.options.horizon).toBe('12h');
    expect(parsed.options.symbols).toEqual(['SOL', 'AVAX']);
  });

  it('rejects invalid count', () => {
    expect(() => parseDelphiSlashCommand('/delphi --count 0')).toThrow(/positive integer/i);
  });

  it('supports help command variants', () => {
    expect(parseDelphiSlashCommand('/delphi help')).toEqual({ kind: 'help' });
    expect(parseDelphiCliArgs(['help'])).toEqual({ kind: 'help' });
  });
});
