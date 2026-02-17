import type { MarketClient } from '../execution/market-client.js';
import type { DelphiRunOptions } from './command.js';

export interface DelphiPredictionPreview {
  symbol: string;
  horizon: string;
  direction: 'above' | 'below';
  referencePrice: number | null;
  targetPrice: number | null;
  confidence: number;
}

function scoreSymbol(symbol: string): number {
  return symbol.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
}

function buildPrediction(symbol: string, markPrice: number | null, horizon: string): DelphiPredictionPreview {
  const score = scoreSymbol(symbol);
  const confidence = 0.52 + ((score % 16) / 100);
  const direction: 'above' | 'below' = score % 2 === 0 ? 'above' : 'below';
  const delta = 0.004 + ((score % 8) / 1000);
  const targetPrice = markPrice != null ? Number((markPrice * (direction === 'above' ? 1 + delta : 1 - delta)).toFixed(2)) : null;
  return {
    symbol,
    horizon,
    direction,
    referencePrice: markPrice,
    targetPrice,
    confidence: Number(confidence.toFixed(2)),
  };
}

export async function generateDelphiPredictions(
  marketClient: MarketClient,
  options: DelphiRunOptions
): Promise<DelphiPredictionPreview[]> {
  const symbols = options.symbols.length > 0 ? options.symbols : undefined;

  const rows =
    symbols && symbols.length > 0
      ? (
          await Promise.all(
            symbols.map(async (symbol) => {
              const matches = await marketClient.searchMarkets(symbol, 1);
              const first = matches[0];
              return {
                symbol,
                markPrice: typeof first?.markPrice === 'number' ? first.markPrice : null,
              };
            })
          )
        ).slice(0, options.count)
      : (await marketClient.listMarkets(Math.max(options.count, 1))).map((market) => ({
          symbol: String(market.symbol ?? market.id).toUpperCase(),
          markPrice: typeof market.markPrice === 'number' ? market.markPrice : null,
        }));

  const deduped = new Map<string, { symbol: string; markPrice: number | null }>();
  for (const row of rows) {
    if (!row.symbol || deduped.has(row.symbol)) {
      continue;
    }
    deduped.set(row.symbol, row);
  }

  return [...deduped.values()]
    .slice(0, options.count)
    .map((row) => buildPrediction(row.symbol, row.markPrice, options.horizon));
}

export function formatDelphiPreview(
  options: DelphiRunOptions,
  predictions: DelphiPredictionPreview[]
): string {
  if (options.output === 'json') {
    return JSON.stringify(
      {
        mode: 'delphi',
        dryRun: true,
        requested: {
          horizon: options.horizon,
          symbols: options.symbols,
          count: options.count,
          output: options.output,
        },
        predictions,
      },
      null,
      2
    );
  }

  if (predictions.length === 0) {
    return [
      'Delphi dry-run preview',
      `- Horizon: ${options.horizon}`,
      `- Requested count: ${options.count}`,
      '- No symbols available from market data.',
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push('Delphi dry-run preview (prediction-only; no execution adapter used)');
  lines.push(`Horizon: ${options.horizon}`);
  lines.push(`Count: ${predictions.length}`);
  lines.push('');
  for (const row of predictions) {
    const ref = row.referencePrice != null ? row.referencePrice.toFixed(2) : 'n/a';
    const tgt = row.targetPrice != null ? row.targetPrice.toFixed(2) : 'n/a';
    lines.push(
      `- ${row.symbol}: ${Math.round(row.confidence * 100)}% confidence ${row.direction} target=${tgt} (ref=${ref}) in ${row.horizon}`
    );
  }
  if (!options.dryRun) {
    lines.push('');
    lines.push('Note: persistence/resolution is not part of task 5; emitted as preview only.');
  }
  return lines.join('\n');
}
