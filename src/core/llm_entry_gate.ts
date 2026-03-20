import { z } from 'zod';
import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { PositionBook } from './position_book.js';
import { recordEntryGateDecision } from '../memory/llm_entry_gate_log.js';
import { Logger } from './logger.js';

export interface EntryGateCandidate {
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  leverage: number;
  edge: number;
  confidence: number;
  signalClass: string;
  regime: string;
  session: string;
  entryReasoning: string;
}

export interface EntryGateDecision {
  verdict: 'approve' | 'reject' | 'resize';
  reasoning: string;
  adjustedSizeUsd?: number;
}

const DecisionSchema = z.object({
  verdict: z.enum(['approve', 'reject', 'resize']),
  reasoning: z.string(),
  adjustedSizeUsd: z.number().optional(),
});

const logger = new Logger('info');

function normalizeOptionalFieldPseudoJson(
  raw: string,
  optionalFields: string[]
): string {
  let normalized = raw;
  for (const field of optionalFields) {
    const pattern = new RegExp(`("${field}"\\s*:)\\s*undefined(?=\\s*[,}])`, 'g');
    normalized = normalized.replace(pattern, '$1 null');
  }
  return normalized;
}

function formatBookTable(entries: ReturnType<PositionBook['getAll']>): string {
  if (entries.length === 0) return '(no open positions)';
  const header = 'symbol | side  | size     | entry price | thesis expires';
  const divider = '-------|-------|----------|-------------|----------------';
  const rows = entries.map((e) => {
    const ttlMin = Math.round((e.thesisExpiresAtMs - Date.now()) / 60_000);
    const ttlStr = ttlMin > 0 ? `${ttlMin}min` : 'EXPIRED';
    return `${e.symbol.padEnd(6)} | ${e.side.padEnd(5)} | ${e.size.toPrecision(5).padEnd(8)} | ${e.entryPrice.toFixed(4).padEnd(11)} | ${ttlStr}`;
  });
  return [header, divider, ...rows].join('\n');
}

function resolveTimeoutMs(config: ThufirConfig): number {
  return Math.max(1, Number(config.autonomy?.llmEntryGate?.timeoutMs ?? 5_000));
}

function shouldRejectOnBothFail(config: ThufirConfig): boolean {
  return config.autonomy?.llmEntryGate?.rejectOnBothFail !== false;
}

function buildPrompt(
  candidate: EntryGateCandidate,
  bookEntries: ReturnType<PositionBook['getAll']>
): { system: string; user: string } {
  const system = `You are Thufir, an LLM-primary trading agent. Your job is to decide whether to approve, reject, or resize a trade candidate.

The default is no trade. You need a compelling reason to approve. When in doubt, reject.

You are not a quant system. You reason about narrative, market context, and whether this setup makes sense right now.

Respond ONLY with valid JSON matching this schema:
{"verdict":"approve"|"reject"|"resize","reasoning":"...","adjustedSizeUsd":number|undefined}`;

  const bookTable = formatBookTable(bookEntries);

  const user = `## Current Open Book

${bookTable}

## Trade Candidate

- Symbol: ${candidate.symbol}
- Side: ${candidate.side}
- Notional USD: $${candidate.notionalUsd.toFixed(2)}
- Leverage: ${candidate.leverage}x
- Edge: ${(candidate.edge * 100).toFixed(2)}%
- Confidence: ${(candidate.confidence * 100).toFixed(1)}%
- Signal class: ${candidate.signalClass}
- Regime: ${candidate.regime}
- Session: ${candidate.session}
- Entry reasoning: ${candidate.entryReasoning}

## Signal Performance Context

Signal performance data will be populated in Phase 2. Use your judgment based on the candidate's signal class and regime.

## Instruction

Respond ONLY with valid JSON:
{"verdict":"approve"|"reject"|"resize","reasoning":"<your reasoning>","adjustedSizeUsd":<number if resize, omit otherwise>}`;

  return { system, user };
}

async function callLlm(
  client: LlmClient,
  candidate: EntryGateCandidate,
  bookEntries: ReturnType<PositionBook['getAll']>,
  timeoutMs?: number
): Promise<EntryGateDecision> {
  const { system, user } = buildPrompt(candidate, bookEntries);
  const response = await client.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    timeoutMs !== undefined ? { timeoutMs } : {}
  );

  const normalized = normalizeOptionalFieldPseudoJson(
    response.content.trim(),
    ['adjustedSizeUsd']
  );
  const parsed = JSON.parse(normalized) as Record<string, unknown>;
  if (parsed.adjustedSizeUsd === null) {
    delete parsed.adjustedSizeUsd;
  }
  const validated = DecisionSchema.parse(parsed);
  return {
    verdict: validated.verdict,
    reasoning: validated.reasoning,
    ...(validated.adjustedSizeUsd !== undefined ? { adjustedSizeUsd: validated.adjustedSizeUsd } : {}),
  };
}

function summarizeLlmError(error: unknown): { type: string; message: string } {
  if (error instanceof SyntaxError) {
    return { type: 'json_parse', message: error.message };
  }
  if (error instanceof z.ZodError) {
    return {
      type: 'schema_validation',
      message: error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { type: 'llm_call', message };
}

export class LlmEntryGate {
  constructor(
    private mainLlm: LlmClient,
    private fallbackLlm: LlmClient,
    private notify: (msg: string) => Promise<void>,
    private book: PositionBook,
    private config: ThufirConfig,
  ) {}

  async evaluate(
    candidate: EntryGateCandidate,
    _markPrice: number,
  ): Promise<EntryGateDecision> {
    // Conflict fast-path: no LLM call needed
    if (this.book.hasConflict(candidate.symbol, candidate.side)) {
      const decision: EntryGateDecision = {
        verdict: 'reject',
        reasoning: 'Opposite-side position already open on this symbol. Cannot open conflicting trade.',
      };
      recordEntryGateDecision({
        symbol: candidate.symbol,
        side: candidate.side,
        notionalUsd: candidate.notionalUsd,
        verdict: decision.verdict,
        reasoning: decision.reasoning,
        adjustedSizeUsd: undefined,
        usedFallback: false,
        signalClass: candidate.signalClass,
        regime: candidate.regime,
        session: candidate.session,
        edge: candidate.edge,
      });
      return decision;
    }

    const bookEntries = this.book.getAll();
    const timeoutMs = resolveTimeoutMs(this.config);
    let usedFallback = false;
    let decision: EntryGateDecision;

    // Try main LLM — no timeoutMs cap, matching AgenticOpenAiClient behaviour
    try {
      decision = await callLlm(this.mainLlm, candidate, bookEntries);
    } catch (error) {
      const summary = summarizeLlmError(error);
      logger.warn('Entry gate main LLM failed; falling back', {
        provider: this.mainLlm.meta?.provider ?? 'unknown',
        model: this.mainLlm.meta?.model ?? 'unknown',
        symbol: candidate.symbol,
        side: candidate.side,
        failureType: summary.type,
        reason: summary.message,
      });
      usedFallback = true;
      try {
        await this.notify('⚠️ Entry gate: using fallback LLM — decision quality may be lower');
      } catch { /* best-effort */ }
      try {
        decision = await callLlm(this.fallbackLlm, candidate, bookEntries, timeoutMs);
      } catch (fallbackError) {
        const summary = summarizeLlmError(fallbackError);
        logger.warn('Entry gate fallback LLM failed; using safe default', {
          provider: this.fallbackLlm.meta?.provider ?? 'unknown',
          model: this.fallbackLlm.meta?.model ?? 'unknown',
          symbol: candidate.symbol,
          side: candidate.side,
          failureType: summary.type,
          reason: summary.message,
        });
        decision = shouldRejectOnBothFail(this.config)
          ? {
              verdict: 'reject',
              reasoning: 'LLM unavailable — defaulting to reject (safe)',
            }
          : {
              verdict: 'approve',
              reasoning: 'LLM unavailable and rejectOnBothFail=false — allowing execution',
            };
      }
    }

    recordEntryGateDecision({
      symbol: candidate.symbol,
      side: candidate.side,
      notionalUsd: candidate.notionalUsd,
      verdict: decision.verdict,
      reasoning: decision.reasoning,
      adjustedSizeUsd: decision.adjustedSizeUsd,
      usedFallback,
      signalClass: candidate.signalClass,
      regime: candidate.regime,
      session: candidate.session,
      edge: candidate.edge,
    });

    return decision;
  }
}
