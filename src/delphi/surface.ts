import type { MarketClient } from '../execution/market-client.js';
import type { ThufirConfig } from '../core/config.js';
import type { Timeframe } from '../technical/types.js';
import { getTechnicalSnapshot as fetchTechnicalSnapshot } from '../technical/snapshot.js';
import { buildTradeSignal as deriveTradeSignal } from '../technical/signals.js';
import type { DelphiRunOptions } from './command.js';

export interface DelphiPredictionPreview {
  symbol: string;
  horizon: string;
  direction: 'above' | 'below';
  referencePrice: number | null;
  targetPrice: number | null;
  confidence: number;
  combinedSignalScore: number;
  inputSource: 'real-signals' | 'experimental-fallback';
}

export interface DelphiSignalInputs {
  symbol: string;
  horizon: string;
  referencePrice: number | null;
  technicalScore: number;
  newsScore: number;
  onChainScore: number;
  signalConfidence: number;
  signalWeights?: {
    technical?: number;
    news?: number;
    onChain?: number;
  };
  inputSource: 'real-signals' | 'experimental-fallback';
}

export type DelphiSignalDependencies = {
  getTechnicalSnapshot: typeof fetchTechnicalSnapshot;
  buildTradeSignal: typeof deriveTradeSignal;
};

const DEFAULT_SIGNAL_DEPS: DelphiSignalDependencies = {
  getTechnicalSnapshot: fetchTechnicalSnapshot,
  buildTradeSignal: deriveTradeSignal,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseHorizonToHours(horizon: string): number | null {
  const match = horizon.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([mhdw])$/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const unit = match[2];
  if (unit === 'm') return value / 60;
  if (unit === 'h') return value;
  if (unit === 'd') return value * 24;
  if (unit === 'w') return value * 24 * 7;
  return null;
}

function selectTimeframe(horizon: string): Timeframe {
  const hours = parseHorizonToHours(horizon);
  if (hours == null) return '4h';
  if (hours <= 0.5) return '15m';
  if (hours <= 2) return '1h';
  if (hours <= 12) return '4h';
  return '1d';
}

function normalizeTechnicalSymbol(symbol: string, config: ThufirConfig): string {
  const normalized = symbol.trim().toUpperCase();
  if (normalized.includes('/')) {
    return normalized;
  }
  const configured = config.technical?.symbols ?? [];
  const direct = configured.find((entry) => entry.toUpperCase() === normalized);
  if (direct) {
    return direct;
  }
  const baseMatched = configured.find((entry) => entry.toUpperCase().startsWith(`${normalized}/`));
  if (baseMatched) {
    return baseMatched;
  }
  return `${normalized}/USDT`;
}

export function buildPredictionFromSignalInputs(input: DelphiSignalInputs): DelphiPredictionPreview {
  const weights = input.signalWeights ?? {};
  const technicalWeight = weights.technical ?? 0.5;
  const newsWeight = weights.news ?? 0.3;
  const onChainWeight = weights.onChain ?? 0.2;
  const totalWeight = technicalWeight + newsWeight + onChainWeight || 1;
  const combinedSignalScore = clamp(
    (input.technicalScore * technicalWeight +
      input.newsScore * newsWeight +
      input.onChainScore * onChainWeight) /
      totalWeight,
    -1,
    1
  );
  const baseConfidence = clamp(input.signalConfidence, 0, 1);
  const confidence = clamp(0.45 + Math.abs(combinedSignalScore) * 0.35 + baseConfidence * 0.2, 0, 1);
  const signedEdge =
    combinedSignalScore !== 0
      ? combinedSignalScore
      : (input.technicalScore + input.newsScore + input.onChainScore) / 3;
  const direction: 'above' | 'below' = signedEdge >= 0 ? 'above' : 'below';
  const delta = 0.003 + Math.abs(combinedSignalScore) * 0.016 + baseConfidence * 0.006;
  const targetPrice =
    input.referencePrice != null
      ? Number(
          (
            input.referencePrice *
            (direction === 'above' ? 1 + delta : 1 - delta)
          ).toFixed(2)
        )
      : null;
  return {
    symbol: input.symbol,
    horizon: input.horizon,
    direction,
    referencePrice: input.referencePrice,
    targetPrice,
    confidence: Number(confidence.toFixed(2)),
    combinedSignalScore: Number(combinedSignalScore.toFixed(4)),
    inputSource: input.inputSource,
  };
}

export async function generateDelphiPredictions(
  marketClient: MarketClient,
  config: ThufirConfig,
  options: DelphiRunOptions,
  deps: DelphiSignalDependencies = DEFAULT_SIGNAL_DEPS
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
                symbol: symbol.toUpperCase(),
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

  const signalInputs = await Promise.all(
    [...deduped.values()].slice(0, options.count).map(async (row) => {
      const timeframe = selectTimeframe(options.horizon);
      try {
        const technicalSymbol = normalizeTechnicalSymbol(row.symbol, config);
        const snapshot = await deps.getTechnicalSnapshot({
          config,
          symbol: technicalSymbol,
          timeframe,
          limit: 120,
        });
        const signal = await deps.buildTradeSignal({
          config,
          snapshot,
          timeframe: snapshot.timeframe,
        });
        return {
          symbol: row.symbol,
          horizon: options.horizon,
          referencePrice: row.markPrice ?? snapshot.price ?? null,
          technicalScore: signal.technicalScore,
          newsScore: signal.newsScore,
          onChainScore: signal.onChainScore,
          signalConfidence: signal.confidence,
          signalWeights: config.technical?.signals?.weights,
          inputSource: 'real-signals',
        } as DelphiSignalInputs;
      } catch {
        return {
          symbol: row.symbol,
          horizon: options.horizon,
          referencePrice: row.markPrice,
          technicalScore: 0,
          newsScore: 0,
          onChainScore: 0,
          signalConfidence: 0.2,
          signalWeights: config.technical?.signals?.weights,
          inputSource: 'experimental-fallback',
        } as DelphiSignalInputs;
      }
    })
  );

  return signalInputs.map((input) => buildPredictionFromSignalInputs(input));
}

export function formatDelphiPreview(
  options: DelphiRunOptions,
  predictions: DelphiPredictionPreview[]
): string {
  if (options.output === 'json') {
    return JSON.stringify(
      {
        mode: 'delphi',
        dryRun: options.dryRun,
        executing: false,
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
      'Delphi prediction preview (non-executing by default)',
      `- Horizon: ${options.horizon}`,
      `- Requested count: ${options.count}`,
      '- No symbols available from market data.',
    ].join('\n');
  }

  const fallbackCount = predictions.filter((row) => row.inputSource === 'experimental-fallback').length;
  const lines: string[] = [];
  lines.push('Delphi prediction preview (real signals; non-executing by default)');
  lines.push(`Horizon: ${options.horizon}`);
  lines.push(`Count: ${predictions.length}`);
  lines.push('');
  for (const row of predictions) {
    const ref = row.referencePrice != null ? row.referencePrice.toFixed(2) : 'n/a';
    const tgt = row.targetPrice != null ? row.targetPrice.toFixed(2) : 'n/a';
    const sourceNote = row.inputSource === 'experimental-fallback' ? ' [experimental fallback]' : '';
    lines.push(
      `- ${row.symbol}: ${Math.round(row.confidence * 100)}% confidence ${row.direction} target=${tgt} (ref=${ref}) in ${row.horizon}${sourceNote}`
    );
  }
  if (fallbackCount > 0) {
    lines.push('');
    lines.push(
      `Signal inputs were unavailable for ${fallbackCount} symbol(s); experimental preview fallback was used for those rows.`
    );
  }
  if (!options.dryRun) {
    lines.push('');
    lines.push(
      'Execution remains disabled until calibration thresholds pass; --no-dry-run currently enables experimental preview behavior only.'
    );
  }
  return lines.join('\n');
}
