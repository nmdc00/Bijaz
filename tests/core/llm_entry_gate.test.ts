/**
 * Tests for LlmEntryGate.
 *
 * Validates:
 * - Conflict fast-path: hasConflict === true → rejects without calling LLM
 * - LLM returns valid JSON approve → returns approve
 * - LLM returns valid JSON reject → returns reject
 * - LLM returns valid JSON resize with adjustedSizeUsd → returns resize
 * - LLM times out → fallback called → notify called → fallback returns valid decision
 * - Both LLM and fallback fail → returns reject, does not throw
 * - Invalid JSON from LLM → fallback called
 * - DB log written for each decision (recordEntryGateDecision called)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRecordEntryGateDecision = vi.fn();

vi.mock('../../src/memory/llm_entry_gate_log.js', () => ({
  recordEntryGateDecision: (...args: unknown[]) => mockRecordEntryGateDecision(...args),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { LlmEntryGate, type EntryGateCandidate } from '../../src/core/llm_entry_gate.js';
import type { LlmClient } from '../../src/core/llm.js';
import type { PositionBook } from '../../src/core/position_book.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCandidate(overrides?: Partial<EntryGateCandidate>): EntryGateCandidate {
  return {
    symbol: 'BTC',
    side: 'buy',
    notionalUsd: 50,
    leverage: 3,
    edge: 0.08,
    confidence: 0.65,
    signalClass: 'momentum_breakout',
    regime: 'trending',
    session: 'us',
    entryReasoning: 'Strong breakout above resistance',
    ...overrides,
  };
}

function makeBook(overrides?: { hasConflict?: boolean; entries?: ReturnType<PositionBook['getAll']> }): PositionBook {
  return {
    hasConflict: vi.fn().mockReturnValue(overrides?.hasConflict ?? false),
    getAll: vi.fn().mockReturnValue(overrides?.entries ?? []),
    get: vi.fn(),
    refresh: vi.fn(),
    getInstance: vi.fn(),
  } as unknown as PositionBook;
}

function makeLlmClient(responseJson: object | null, shouldThrow?: boolean): LlmClient {
  const completeFn = shouldThrow
    ? vi.fn().mockRejectedValue(new Error('LLM timeout'))
    : vi.fn().mockResolvedValue({
        content: JSON.stringify(responseJson),
        model: 'test-model',
      });
  return { complete: completeFn } as unknown as LlmClient;
}

const dummyConfig = {} as any;
const markPrice = 50000;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LlmEntryGate', () => {
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    notify = vi.fn().mockResolvedValue(undefined);
  });

  describe('conflict fast-path', () => {
    it('returns reject without calling LLM when hasConflict is true', async () => {
      const book = makeBook({ hasConflict: true });
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fine' });
      const fallbackLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fine' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect(result.reasoning).toMatch(/opposite-side/i);
      expect((mainLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('records DB log entry on conflict reject', async () => {
      const book = makeBook({ hasConflict: true });
      const gate = new LlmEntryGate(
        makeLlmClient(null),
        makeLlmClient(null),
        notify,
        book,
        dummyConfig
      );

      await gate.evaluate(makeCandidate({ symbol: 'ETH', side: 'sell' }), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      const call = mockRecordEntryGateDecision.mock.calls[0][0];
      expect(call.verdict).toBe('reject');
      expect(call.symbol).toBe('ETH');
    });
  });

  describe('LLM approve path', () => {
    it('returns approve when LLM responds with approve verdict', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'Strong setup' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('approve');
      expect(result.reasoning).toBe('Strong setup');
    });

    it('records DB log for approve', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'ok' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      expect(mockRecordEntryGateDecision.mock.calls[0][0].verdict).toBe('approve');
    });
  });

  describe('LLM reject path', () => {
    it('returns reject when LLM responds with reject verdict', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'reject', reasoning: 'Choppy conditions' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect(result.reasoning).toBe('Choppy conditions');
    });

    it('records DB log for reject', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'reject', reasoning: 'no' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      expect(mockRecordEntryGateDecision.mock.calls[0][0].verdict).toBe('reject');
    });
  });

  describe('LLM resize path', () => {
    it('returns resize with adjustedSizeUsd when LLM responds with resize', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({
        verdict: 'resize',
        reasoning: 'Reduce size for risk',
        adjustedSizeUsd: 25,
      });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('resize');
      expect(result.adjustedSizeUsd).toBe(25);
      expect(result.reasoning).toBe('Reduce size for risk');
    });

    it('records DB log for resize with adjustedSizeUsd', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'resize', reasoning: 'smaller', adjustedSizeUsd: 20 });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      const call = mockRecordEntryGateDecision.mock.calls[0][0];
      expect(call.verdict).toBe('resize');
      expect(call.adjustedSizeUsd).toBe(20);
    });
  });

  describe('fallback and error handling', () => {
    it('uses fallback LLM when main LLM fails, and calls notify', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient(null, /* shouldThrow */ true);
      const fallbackLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fallback ok' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('approve');
      expect(notify).toHaveBeenCalledOnce();
      expect(notify.mock.calls[0][0]).toContain('fallback LLM');
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it('records usedFallback=true in DB log when fallback is used', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient({ verdict: 'reject', reasoning: 'fallback reject' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      expect(mockRecordEntryGateDecision.mock.calls[0][0].usedFallback).toBe(true);
    });

    it('returns safe reject when both main and fallback fail, does not throw', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient(null, true);
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      let result: Awaited<ReturnType<typeof gate.evaluate>>;
      await expect(async () => {
        result = await gate.evaluate(makeCandidate(), markPrice);
      }).not.toThrow();

      result = await gate.evaluate(makeCandidate(), markPrice);
      expect(result.verdict).toBe('reject');
      expect(result.reasoning).toMatch(/unavailable/i);
    });

    it('records DB log even when fallback is used', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient({ verdict: 'approve', reasoning: 'ok' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalled();
    });

    it('uses fallback when main LLM returns invalid JSON', async () => {
      const book = makeBook();
      const mainLlm: LlmClient = {
        complete: vi.fn().mockResolvedValue({ content: 'not valid json }{', model: 'test' }),
      } as unknown as LlmClient;
      const fallbackLlm = makeLlmClient({ verdict: 'reject', reasoning: 'fallback after parse error' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect(notify).toHaveBeenCalled();
    });

    it('does not throw when both fail and records DB log with safe reject', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient(null, true);
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect(mockRecordEntryGateDecision).toHaveBeenCalled();
      const call = mockRecordEntryGateDecision.mock.calls[0][0];
      expect(call.verdict).toBe('reject');
    });
  });

  describe('DB logging', () => {
    it('always calls recordEntryGateDecision with correct fields', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'good' });
      const candidate = makeCandidate({
        symbol: 'SOL',
        side: 'sell',
        notionalUsd: 75,
        signalClass: 'mean_reversion',
        regime: 'choppy',
        session: 'asia',
        edge: 0.05,
      });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(candidate, markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      const call = mockRecordEntryGateDecision.mock.calls[0][0];
      expect(call.symbol).toBe('SOL');
      expect(call.side).toBe('sell');
      expect(call.notionalUsd).toBe(75);
      expect(call.signalClass).toBe('mean_reversion');
      expect(call.regime).toBe('choppy');
      expect(call.session).toBe('asia');
      expect(call.edge).toBe(0.05);
      expect(call.usedFallback).toBe(false);
    });
  });
});
