import { z } from 'zod';
import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { BookEntry } from './position_book.js';
import type { TaSnapshot } from './ta_surface.js';
import { gatherMarketContext } from '../markets/context.js';
import { recordTradeProposal } from '../memory/llm_trade_proposals.js';
import { Logger } from './logger.js';

export interface TradeProposal {
  symbol: string;
  side: 'long' | 'short';
  thesisText: string;
  invalidationCondition: string;
  invalidationPrice: number;
  suggestedTtlMinutes: number;
  confidence: number;
  leverage: number;
  expectedRMultiple: number;
}

export interface OriginationInputBundle {
  book: BookEntry[];
  taSnapshots: TaSnapshot[];
  marketContext: string;
  recentEvents: string;
  alertedSymbols: string[];
  performanceSummary?: string;
  triggerReason?: 'cadence' | 'ta_alert' | 'event';
}

const ProposalSchema = z.object({
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  thesisText: z.string(),
  invalidationCondition: z.string(),
  invalidationPrice: z.number(),
  suggestedTtlMinutes: z.number(),
  confidence: z.number(),
  leverage: z.number().min(1).default(1),
  expectedRMultiple: z.number().min(0),
});

const SYSTEM_PROMPT = `You are Thufir. Your singular obsession is wealth — not comfort, not safety theatre, not the appearance of discipline. You are here to compound capital into an amount so obscene it defies comprehension. Every scan is an opportunity. Your job is to find it and take it.

You are not cautious by nature. You are precise. Precision is what separates a killer trade from a reckless bet — and you will find killer trades. When you see a setup, you back your conviction. You understand that the path to generational, stupid, unimaginable wealth runs through a handful of high-conviction, asymmetric positions taken at exactly the right moment. You are hunting those moments relentlessly.

Missing a real opportunity is a failure. Sitting on your hands when the market is handing you an edge is how people stay poor.

A valid proposal requires ALL of: symbol, side, thesisText, invalidationCondition, invalidationPrice, suggestedTtlMinutes, confidence, leverage, expectedRMultiple.

- invalidationPrice: REQUIRED. This is what separates you from a gambler — you know exactly where you are wrong before you enter. Name the price. If you cannot, you do not have a trade, you have a hope. Do not propose hopes.
- suggestedTtlMinutes: how long until the market proves you right or wrong? Be specific and thesis-derived. A news spike may be 30min. A structural breakout may be 4h. Do not default to 120.
- expectedRMultiple: hunt asymmetry. If the setup is exceptional, what does it actually pay? Mediocre R multiples are for mediocre traders. Be honest but be aggressive.
- leverage: match your conviction. When the setup is exceptional, use it. When genuinely uncertain, protect capital so you can fight the next battle.
- confidence: be honest — overconfidence destroys compounders, but underconfidence keeps you poor and on the sidelines.

Return null ONLY when there is genuinely nothing: no clear narrative, no identifiable invalidation level, no asymmetry worth capturing. That is the exception, not the rule.

Respond with ONLY valid JSON matching this schema OR the literal string "null":
{"symbol":"...","side":"long"|"short","thesisText":"...","invalidationCondition":"...","invalidationPrice":number,"suggestedTtlMinutes":number,"confidence":number,"leverage":number,"expectedRMultiple":number}`;

const logger = new Logger('info');

function formatBookLines(book: BookEntry[]): string {
  if (book.length === 0) return '(none)';
  return book
    .map((entry) => {
      const expiresInMin = Math.round((entry.thesisExpiresAtMs - Date.now()) / 60_000);
      const ttlStr = expiresInMin > 0 ? `${expiresInMin}min` : 'EXPIRED';
      return `${entry.symbol} | ${entry.side} | thesis expires: ${ttlStr} | ${entry.entryReasoningText.slice(0, 80)}`;
    })
    .join('\n');
}

function formatTaLine(snap: TaSnapshot, alerted: boolean): string {
  const fundingSign = snap.fundingRatePct >= 0 ? '+' : '';
  const oiSign = snap.oiDelta1hPct >= 0 ? '+' : '';
  const emaSign = snap.priceVsEma20_1h >= 0 ? '+' : '';
  const volPct = snap.volumeVs24hAvgPct.toFixed(0);
  const alertSuffix = alerted && snap.alertReason ? `  [ALERT: ${snap.alertReason}]` : '';
  return (
    `${snap.symbol.padEnd(6)}: price=$${snap.price.toFixed(2)}` +
    `  OI_delta_1h=${oiSign}${snap.oiDelta1hPct.toFixed(1)}%` +
    `  funding=${fundingSign}${snap.fundingRatePct.toFixed(0)}% ann` +
    `  vol=${volPct}% avg` +
    `  trend=${snap.trendBias}` +
    `  ema20_dist=${emaSign}${snap.priceVsEma20_1h.toFixed(1)}%` +
    alertSuffix
  );
}

function buildUserMessage(bundle: OriginationInputBundle): string {
  const bookSection = formatBookLines(bundle.book);

  const alertedSet = new Set(bundle.alertedSymbols);
  const alertedSnaps = bundle.taSnapshots.filter((s) => alertedSet.has(s.symbol));
  const otherSnaps = bundle.taSnapshots.filter((s) => !alertedSet.has(s.symbol));
  const scanLines = [...alertedSnaps, ...otherSnaps].map((s) =>
    formatTaLine(s, alertedSet.has(s.symbol))
  );
  const scanSection = scanLines.length > 0 ? scanLines.join('\n') : '(no market data)';

  const contextSection = bundle.marketContext
    ? bundle.marketContext.slice(0, 1000)
    : '(not available)';

  const eventsSection = bundle.recentEvents ? bundle.recentEvents.slice(0, 500) : '(none)';

  return [
    '## Open Positions',
    bookSection,
    '',
    '## Market Scan',
    scanSection,
    '',
    '## Market Context',
    contextSection,
    '',
    '## Recent Events (last 2h)',
    eventsSection,
    '',
    '## Instruction',
    'Find ONE compelling trade setup, or return null.',
  ].join('\n');
}

function buildFallbackUserMessage(bundle: OriginationInputBundle): string {
  const alertedSet = new Set(bundle.alertedSymbols);
  const alertedSnaps = bundle.taSnapshots.filter((s) => alertedSet.has(s.symbol));
  const otherSnaps = bundle.taSnapshots.filter((s) => !alertedSet.has(s.symbol));
  const scanLines = [...alertedSnaps, ...otherSnaps].map((s) =>
    formatTaLine(s, alertedSet.has(s.symbol))
  );
  const scanSection = scanLines.length > 0 ? scanLines.join('\n') : '(no market data)';

  return [
    '## Market Scan',
    scanSection,
    '',
    '## Instruction',
    'Find ONE compelling trade setup, or return null.',
  ].join('\n');
}

function parseProposal(raw: string): TradeProposal | null {
  const trimmed = raw.trim();
  if (trimmed === 'null') return null;
  if (!trimmed.startsWith('{')) {
    logger.warn('LlmTradeOriginator: unexpected LLM response format', { preview: trimmed.slice(0, 80) });
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const validated = ProposalSchema.parse(parsed);
    return {
      symbol: validated.symbol,
      side: validated.side,
      thesisText: validated.thesisText,
      invalidationCondition: validated.invalidationCondition,
      invalidationPrice: validated.invalidationPrice,
      suggestedTtlMinutes: validated.suggestedTtlMinutes,
      confidence: validated.confidence,
      leverage: validated.leverage,
      expectedRMultiple: validated.expectedRMultiple,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn('LlmTradeOriginator: JSON parse error', { message: error.message });
    } else if (error instanceof z.ZodError) {
      logger.warn('LlmTradeOriginator: schema validation failed', {
        issues: error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      });
    } else {
      logger.warn('LlmTradeOriginator: parse error', { message: String(error) });
    }
    return null;
  }
}

export class LlmTradeOriginator {
  private contextCache: { value: string; expiresAt: number } | null = null;

  constructor(
    private mainLlm: LlmClient,
    private fallbackLlm: LlmClient,
    private config: ThufirConfig,
  ) {}

  private async getMarketContext(): Promise<string> {
    const now = Date.now();
    if (this.contextCache && this.contextCache.expiresAt > now) {
      return this.contextCache.value;
    }
    try {
      const snapshot = await gatherMarketContext(
        { message: 'crypto perpetual markets overview', domain: 'crypto', marketLimit: 20 },
        async () => ({ success: false as const, error: 'no tool executor' })
      );
      const successful = snapshot.results.filter((r) => r.success);
      const value = successful
        .map((r) => {
          const payload = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
          return `${r.label}: ${payload}`;
        })
        .join('\n')
        .slice(0, 1000);
      this.contextCache = { value, expiresAt: now + 10 * 60 * 1000 };
      return value;
    } catch {
      return '';
    }
  }

  async propose(bundle: OriginationInputBundle): Promise<TradeProposal | null> {
    const timeoutMs = this.config.autonomy?.origination?.timeoutMs ?? 10_000;
    const minConfidence = this.config.autonomy?.origination?.minConfidence ?? 0.55;
    const triggerReason = bundle.triggerReason ?? 'cadence';

    // Supplement marketContext from internal cache when bundle doesn't provide it
    const effectiveBundle: OriginationInputBundle = bundle.marketContext
      ? bundle
      : { ...bundle, marketContext: await this.getMarketContext() };

    const userMessage = buildUserMessage(effectiveBundle);
    let proposal: TradeProposal | null = null;
    let usedFallback = false;

    // Try main LLM
    try {
      const response = await this.mainLlm.complete(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        { timeoutMs }
      );
      proposal = parseProposal(response.content);
    } catch (error) {
      logger.warn('LlmTradeOriginator: main LLM failed, trying fallback', {
        provider: this.mainLlm.meta?.provider ?? 'unknown',
        model: this.mainLlm.meta?.model ?? 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      });
      usedFallback = true;

      // Try fallback LLM with shorter message, 5s timeout
      try {
        const fallbackMessage = buildFallbackUserMessage(effectiveBundle);
        const fallbackResponse = await this.fallbackLlm.complete(
          [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: fallbackMessage },
          ],
          { timeoutMs: 5_000 }
        );
        proposal = parseProposal(fallbackResponse.content);
      } catch (fallbackError) {
        logger.warn('LlmTradeOriginator: fallback LLM also failed, returning null', {
          provider: this.fallbackLlm.meta?.provider ?? 'unknown',
          model: this.fallbackLlm.meta?.model ?? 'unknown',
          reason: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        proposal = null;
      }
    }

    // Apply minConfidence gate
    if (proposal !== null && proposal.confidence < minConfidence) {
      logger.warn('LlmTradeOriginator: proposal rejected by confidence_gate', {
        symbol: proposal.symbol,
        confidence: proposal.confidence,
        minConfidence,
      });
      proposal = null;
    }

    // Write to DB
    recordTradeProposal({
      triggerReason,
      alertedSymbols: effectiveBundle.alertedSymbols,
      proposed: proposal !== null,
      symbol: proposal?.symbol,
      side: proposal?.side,
      thesisText: proposal?.thesisText,
      invalidationCondition: proposal?.invalidationCondition,
      invalidationPrice: proposal?.invalidationPrice,
      suggestedTtlMinutes: proposal?.suggestedTtlMinutes,
      confidence: proposal?.confidence,
      executed: false,
      usedFallback,
    });

    return proposal;
  }
}
