import { z } from 'zod';
import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { BookEntry } from './position_book.js';
import { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ExitConsultDecision {
  action: 'hold' | 'reduce' | 'close' | 'extend_ttl' | 'update_invalidation';
  reasoning: string;
  newTimeStopAtMs?: number;
  newInvalidationPrice?: number;
  reduceToFraction?: number;
}

// ---------------------------------------------------------------------------
// Zod schema for LLM response validation
// ---------------------------------------------------------------------------

const ExitConsultResponseSchema = z.object({
  action: z.enum(['hold', 'reduce', 'close', 'extend_ttl', 'update_invalidation']),
  reasoning: z.string(),
  newTimeStopAtMs: z.number().optional(),
  newInvalidationPrice: z.number().optional(),
  reduceToFraction: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const ROE_THRESHOLDS = [0.03, 0.07, 0.15];        // 3%, 7%, 15%
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

function normalizeExitConsultOptionalFields(
  parsed: Record<string, unknown>
): Record<string, unknown> {
  for (const field of ['newTimeStopAtMs', 'newInvalidationPrice', 'reduceToFraction']) {
    if (parsed[field] === null) {
      delete parsed[field];
    }
  }
  return parsed;
}

function resolveFirstConsultMs(config: ThufirConfig): number {
  return Math.max(1, Number(config.heartbeat?.llmExitConsult?.firstConsultMinutes ?? 20)) * 60_000;
}

function resolveCadenceMs(config: ThufirConfig): number {
  return Math.max(1, Number(config.heartbeat?.llmExitConsult?.cadenceMinutes ?? 20)) * 60_000;
}

function resolveTtlApproachMs(config: ThufirConfig): number {
  return Math.max(0, Number(config.heartbeat?.llmExitConsult?.approachTtlMinutes ?? 15)) * 60_000;
}

function resolveTimeoutMs(config: ThufirConfig): number {
  return Math.max(1, Number(config.heartbeat?.llmExitConsult?.timeoutMs ?? 8_000));
}

function resolveRoeThresholds(config: ThufirConfig): number[] {
  const configured = config.heartbeat?.llmExitConsult?.roeThresholds;
  if (!Array.isArray(configured) || configured.length === 0) {
    return ROE_THRESHOLDS;
  }
  return configured
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => (value > 1 ? value / 100 : value))
    .sort((a, b) => a - b);
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

// ---------------------------------------------------------------------------
// LlmExitConsultant
// ---------------------------------------------------------------------------

export class LlmExitConsultant {
  constructor(
    private mainLlm: LlmClient,
    private fallbackLlm: LlmClient,
    private notify: (msg: string) => Promise<void>,
    private config: ThufirConfig,
  ) {}

  /**
   * Returns true if the position should be consulted right now.
   *
   * Triggers (any one suffices):
   * - 20+ min since last consult (or position age ≥ 20 min and never consulted)
   * - |ROE| crossed 3%, 7%, or 15% since last consult
   * - < 15 min remain before thesisExpiresAtMs
   */
  shouldConsult(
    position: BookEntry,
    _currentPrice: number,
    roe: number,
    nowMs: number,
  ): boolean {
    const absRoe = Math.abs(roe);
    const firstConsultMs = resolveFirstConsultMs(this.config);
    const cadenceMs = resolveCadenceMs(this.config);
    const roeThresholds = resolveRoeThresholds(this.config);
    const ttlApproachMs = resolveTtlApproachMs(this.config);

    // Time-based trigger
    if (position.lastConsultAtMs === null) {
      // Never consulted — trigger once position is at least 20 min old
      const entryAge = nowMs - (position.thesisExpiresAtMs - 2 * 60 * 60 * 1000);
      if (entryAge < 0 || entryAge >= firstConsultMs) {
        return true;
      }
    } else if (nowMs - position.lastConsultAtMs >= cadenceMs) {
      return true;
    }

    // ROE threshold crossing
    // Determine what the last consulted ROE abs value was (use 0 if never consulted)
    let lastAbsRoe = 0;
    if (position.lastConsultDecision != null) {
      try {
        const prev = JSON.parse(position.lastConsultDecision) as { roeAtConsult?: number };
        if (typeof prev.roeAtConsult === 'number') {
          lastAbsRoe = Math.abs(prev.roeAtConsult);
        }
      } catch {
        // ignore parse errors
      }
    }
    for (const threshold of roeThresholds) {
      if (absRoe >= threshold && lastAbsRoe < threshold) {
        return true;
      }
    }

    // TTL approach trigger
    const remainingMs = position.thesisExpiresAtMs - nowMs;
    if (remainingMs <= ttlApproachMs) {
      return true;
    }

    return false;
  }

  /**
   * Ask the LLM for an exit decision. Falls back to fallbackLlm on timeout/error.
   * If both fail, returns safe default `hold`.
   */
  async consult(
    position: BookEntry,
    currentPrice: number,
    roe: number,
    freshContext: string,
  ): Promise<ExitConsultDecision> {
    const nowMs = Date.now();
    const timeHeldMs = nowMs - (position.thesisExpiresAtMs - 2 * 60 * 60 * 1000);
    const timeHeldMin = Math.max(0, Math.round(timeHeldMs / 60_000));
    const remainingMs = position.thesisExpiresAtMs - nowMs;
    const remainingMin = Math.round(remainingMs / 60_000);

    const messages = buildMessages(position, currentPrice, roe, timeHeldMin, remainingMin, freshContext);
    // Respect trivial prompt budget if configured (default 300 tokens for exit decisions).
    const maxTokens = Math.min(
      300,
      Math.floor((this.config.agent?.promptBudget?.trivial ?? 10000) / 4)
    );

    // Try main LLM — no maxTokens cap, matching AgenticOpenAiClient behaviour
    try {
      const decision = await callWithTimeout(
        this.mainLlm,
        messages,
        resolveTimeoutMs(this.config),
      );
      await this.logDecision({ position, roe, nowMs, decision, usedFallback: false });
      return decision;
    } catch (error) {
      const summary = summarizeLlmError(error);
      logger.warn('Exit consultant main LLM failed; falling back', {
        provider: this.mainLlm.meta?.provider ?? 'unknown',
        model: this.mainLlm.meta?.model ?? 'unknown',
        symbol: position.symbol,
        side: position.side,
        failureType: summary.type,
        reason: summary.message,
      });
      // Fall through to fallback
    }

    // Try fallback LLM
    try {
      await this.notify('⚠️ Exit consultant: using fallback LLM — decision quality may be lower');
    } catch {
      // best-effort
    }
    try {
      const decision = await callWithTimeout(
        this.fallbackLlm,
        messages,
        resolveTimeoutMs(this.config),
        maxTokens
      );
      await this.logDecision({ position, roe, nowMs, decision, usedFallback: true });
      return decision;
    } catch (fallbackError) {
      const summary = summarizeLlmError(fallbackError);
      logger.warn('Exit consultant fallback LLM failed; using safe default', {
        provider: this.fallbackLlm.meta?.provider ?? 'unknown',
        model: this.fallbackLlm.meta?.model ?? 'unknown',
        symbol: position.symbol,
        side: position.side,
        failureType: summary.type,
        reason: summary.message,
      });
      // Fall through to safe default
    }

    // Both failed
    const safeDecision: ExitConsultDecision = {
      action: 'hold',
      reasoning: 'LLM unavailable — defaulting to hold (safe)',
    };
    await this.logDecision({ position, roe, nowMs, decision: safeDecision, usedFallback: true });
    return safeDecision;
  }

  private async logDecision(params: {
    position: BookEntry;
    roe: number;
    nowMs: number;
    decision: ExitConsultDecision;
    usedFallback: boolean;
  }): Promise<void> {
    const timeHeldMs = params.nowMs - (params.position.thesisExpiresAtMs - 2 * 60 * 60 * 1000);
    try {
      const { recordExitConsultDecision } = await import('../memory/llm_exit_consult_log.js');
      recordExitConsultDecision({
        symbol: params.position.symbol,
        side: params.position.side,
        roeAtConsult: params.roe,
        timeHeldMs: Math.max(0, timeHeldMs),
        action: params.decision.action,
        reasoning: params.decision.reasoning,
        newTimeStopAtMs: params.decision.newTimeStopAtMs ?? null,
        newInvalidationPrice: params.decision.newInvalidationPrice ?? null,
        reduceToFraction: params.decision.reduceToFraction ?? null,
        usedFallback: params.usedFallback ? 1 : 0,
      });
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMessages(
  position: BookEntry,
  currentPrice: number,
  roe: number,
  timeHeldMin: number,
  remainingMin: number,
  freshContext: string,
): import('./llm.js').ChatMessage[] {
  const system =
    `You are Thufir, an LLM-primary trading agent managing an open position. ` +
    `Your job: decide whether to hold, reduce, close, extend the thesis TTL, or update the invalidation price. ` +
    `You have the original entry reasoning and current market context. Use both. ` +
    `Be willing to exit early if the narrative has changed. Be willing to extend if the thesis is intact and there is more to go.`;

  const roePct = (roe * 100).toFixed(2);
  const user =
    `## Position state\n` +
    `symbol: ${position.symbol}\n` +
    `side: ${position.side}\n` +
    `size: ${position.size}\n` +
    `entry price: ${position.entryPrice}\n` +
    `current price: ${currentPrice}\n` +
    `ROE: ${roePct}%\n` +
    `time held: ${timeHeldMin} minutes\n` +
    `time remaining on thesis: ${remainingMin} minutes\n\n` +
    `## Original entry reasoning\n${position.entryReasoningText || '(none recorded)'}\n\n` +
    `## Exit contract\n${position.exitContractSummary || '(none recorded)'}\n\n` +
    `## Current market context\n${freshContext || '(none)'}\n\n` +
    `## Instruction\n` +
    `Respond ONLY with valid JSON matching this schema:\n` +
    `{"action":"hold"|"reduce"|"close"|"extend_ttl"|"update_invalidation","reasoning":"...","newTimeStopAtMs":number|undefined,"newInvalidationPrice":number|undefined,"reduceToFraction":number|undefined}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function callWithTimeout(
  llm: LlmClient,
  messages: import('./llm.js').ChatMessage[],
  timeoutMs: number,
  maxTokens?: number,
): Promise<ExitConsultDecision> {
  const response = await Promise.race([
    llm.complete(messages, maxTokens !== undefined ? { maxTokens } : {}),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`exit consultant timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);

  const text = typeof response.content === 'string' ? response.content.trim() : '';
  // Extract JSON from response (may be wrapped in markdown fences)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in LLM response');
  const normalized = normalizeOptionalFieldPseudoJson(
    jsonMatch[0],
    ['newTimeStopAtMs', 'newInvalidationPrice', 'reduceToFraction']
  );
  const parsed = normalizeExitConsultOptionalFields(
    JSON.parse(normalized) as Record<string, unknown>
  );
  return ExitConsultResponseSchema.parse(parsed);
}
