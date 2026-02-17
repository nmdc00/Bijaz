export type DelphiOutputFormat = 'text' | 'json';

export interface DelphiRunOptions {
  horizon: string;
  symbols: string[];
  count: number;
  dryRun: boolean;
  output: DelphiOutputFormat;
}

export type DelphiCommand =
  | { kind: 'run'; options: DelphiRunOptions }
  | { kind: 'help' };

const DEFAULT_OPTIONS: DelphiRunOptions = {
  horizon: '24h',
  symbols: [],
  count: 5,
  dryRun: true,
  output: 'text',
};

function tokenize(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((part) => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1);
    }
    return part;
  });
}

function parseSymbolValue(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function readOptionValue(tokens: string[], index: number, option: string): string {
  const value = tokens[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function parseRunTokens(tokens: string[]): DelphiRunOptions {
  const options: DelphiRunOptions = {
    horizon: DEFAULT_OPTIONS.horizon,
    symbols: [...DEFAULT_OPTIONS.symbols],
    count: DEFAULT_OPTIONS.count,
    dryRun: DEFAULT_OPTIONS.dryRun,
    output: DEFAULT_OPTIONS.output,
  };

  const positionalSymbols: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    switch (token) {
      case '--horizon':
      case '-h': {
        const value = readOptionValue(tokens, i, token);
        options.horizon = value;
        i += 1;
        break;
      }
      case '--symbols':
      case '--symbol-set':
      case '-s': {
        const value = readOptionValue(tokens, i, token);
        options.symbols.push(...parseSymbolValue(value));
        i += 1;
        break;
      }
      case '--count':
      case '-c': {
        const value = readOptionValue(tokens, i, token);
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error('`count` must be a positive integer.');
        }
        options.count = parsed;
        i += 1;
        break;
      }
      case '--dry-run': {
        options.dryRun = true;
        break;
      }
      case '--no-dry-run': {
        options.dryRun = false;
        break;
      }
      case '--output':
      case '-o': {
        const value = readOptionValue(tokens, i, token).toLowerCase();
        if (value !== 'text' && value !== 'json') {
          throw new Error('`output` must be one of: text, json.');
        }
        options.output = value;
        i += 1;
        break;
      }
      case 'run':
      case 'help':
        break;
      default: {
        if (token.startsWith('-')) {
          throw new Error(`Unknown option: ${token}`);
        }
        positionalSymbols.push(token.toUpperCase());
      }
    }
  }

  if (positionalSymbols.length > 0) {
    options.symbols.push(...positionalSymbols);
  }

  options.symbols = [...new Set(options.symbols)];
  return options;
}

export function parseDelphiCliArgs(args: string[]): DelphiCommand {
  const tokens = [...args];
  const first = tokens[0]?.toLowerCase();
  if (first === 'help' || first === '--help' || first === '-?') {
    return { kind: 'help' };
  }
  if (first === 'run') {
    tokens.shift();
  }
  return { kind: 'run', options: parseRunTokens(tokens) };
}

export function parseDelphiSlashCommand(input: string): DelphiCommand {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith('/delphi')) {
    throw new Error('Not a /delphi command.');
  }
  const tokens = tokenize(trimmed);
  tokens.shift(); // /delphi
  if (tokens[0]?.toLowerCase() === 'help') {
    return { kind: 'help' };
  }
  return { kind: 'run', options: parseRunTokens(tokens) };
}

export function formatDelphiHelp(prefix: '/delphi' | 'thufir delphi'): string {
  return [
    `${prefix} command options:`,
    `${prefix} [run] [SYMBOL ...] [--horizon <window>] [--symbols BTC,ETH] [--count <n>] [--dry-run] [--output text|json]`,
    '',
    'Examples:',
    `${prefix} --horizon 12h --symbols BTC,ETH --count 4 --dry-run`,
    `${prefix} run BTC ETH -h 6h -c 2 --output json`,
  ].join('\n');
}
