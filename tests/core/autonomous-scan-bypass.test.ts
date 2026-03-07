/**
 * autonomous-scan-bypass.test.ts
 *
 * Verifies that the autonomous scan pipeline (discovery → filter → evaluate) does NOT
 * invoke the LLM. Only the synthesis/enrichment step after trade execution may use it.
 * This is the v1.91 scan bypass: one direct LLM call (trivial client) instead of the
 * full orchestrator (2 calls: plan + execute).
 */
import { describe, expect, it, vi } from 'vitest';

const dbRun = vi.fn(() => ({}));
const dbPrepare = vi.fn((sql: string) => {
  if (sql.includes('COUNT(*)')) {
    return { get: () => ({ c: 0 }) };
  }
  return { run: dbRun, all: () => [] };
});
const dbExec = vi.fn();

vi.mock('../../src/discovery/engine.js', () => ({
  runDiscovery: async () => ({
    clusters: [
      {
        id: 'c1',
        symbol: 'BTC/USDT',
        directionalBias: 'up',
        confidence: 0.8,
        timeHorizon: 'hours',
        signals: [],
      },
    ],
    hypotheses: [],
    expressions: [
      {
        id: 'expr_1',
        hypothesisId: 'hyp_BTC_trend',
        symbol: 'BTC/USDT',
        side: 'buy',
        signalClass: 'momentum_breakout',
        confidence: 0.8,
        expectedEdge: 0.12,
        entryZone: 'market',
        invalidation: 'x',
        expectedMove: 'BTC sees upside continuation',
        orderType: 'market',
        leverage: 3,
        probeSizeUsd: 20,
        newsTrigger: null,
      },
    ],
  }),
}));

vi.mock('../../src/memory/perp_trades.js', () => ({
  recordPerpTrade: vi.fn(() => 1),
}));

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  recordPerpTradeJournal: vi.fn(),
  listPerpTradeJournals: () => [],
}));

vi.mock('../../src/execution/perp-risk.js', () => ({
  checkPerpRiskLimits: async () => ({ allowed: true }),
}));

vi.mock('../../src/core/autonomy_policy.js', () => ({
  applyReflectionMutation: () => ({ mutated: false, state: {} }),
  classifyMarketRegime: () => 'trending',
  classifySignalClass: () => 'momentum_breakout',
  computeFractionalKellyFraction: () => 0.25,
  evaluateGlobalTradeGate: () => ({ allowed: true }),
  evaluateNewsEntryGate: () => ({ allowed: true }),
  isSignalClassAllowedForRegime: () => true,
  resolveLiquidityBucket: () => 'normal',
  resolveVolatilityBucket: () => 'medium',
}));

vi.mock('../../src/core/signal_performance.js', () => ({
  summarizeSignalPerformance: () => ({ sampleCount: 0, expectancy: 0.5, variance: 0.5 }),
}));

vi.mock('../../src/memory/autonomy_policy_state.js', () => ({
  getAutonomyPolicyState: () => ({
    minEdgeOverride: null,
    maxTradesPerScanOverride: null,
    leverageCapOverride: null,
    observationOnlyUntilMs: null,
    reason: null,
    updatedAt: new Date().toISOString(),
  }),
}));

vi.mock('../../src/memory/trades.js', () => ({
  listOpenPositionsFromTrades: () => [],
}));

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({
    exec: dbExec,
    prepare: dbPrepare,
  }),
}));

const baseConfig = {
  autonomy: {
    enabled: true,
    fullAuto: true,
    scanIntervalSeconds: 300,
    minEdge: 0.05,
    maxTradesPerScan: 1,
  },
  hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 },
} as any;

describe('autonomous scan bypass — LLM not called for discovery/filter/evaluate', () => {
  it('completes a full scan without any LLM calls when async enrichment is disabled', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llmComplete = vi.fn(async () => ({ content: 'enrichment', model: 'test' }));
    const llm = { complete: llmComplete } as any;
    const executor = {
      execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })),
    } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: vi.fn(),
      release: vi.fn(),
    } as any;

    const manager = new AutonomousManager(llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan();

    // LLM must NOT be called during discovery → filter → evaluate pipeline
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it('calls LLM exactly once for async enrichment (synthesis step) after trade execution', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llmComplete = vi.fn(async () => ({ content: 'trade annotated', model: 'test' }));
    const llm = { complete: llmComplete } as any;
    const executor = {
      execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })),
    } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: vi.fn(),
      release: vi.fn(),
    } as any;

    const configWithEnrichment = {
      ...baseConfig,
      autonomy: {
        ...baseConfig.autonomy,
        asyncEnrichment: { enabled: true, timeoutMs: 2000, maxChars: 200 },
      },
    };

    const manager = new AutonomousManager(
      llm,
      marketClient,
      executor,
      limiter,
      configWithEnrichment
    );
    await manager.runScan();

    // Wait for the async enrichment fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 50));

    // Exactly one synthesis call — not two (orchestrator plan + execute)
    expect(llmComplete).toHaveBeenCalledTimes(1);
    // The messages sent to the direct client are simple role-based messages, not a plan payload
    const [messages] = llmComplete.mock.calls[0]!;
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[1]).toMatchObject({ role: 'user' });
  });

  it('scan returns expression results without touching LLM when no trades meet threshold', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llmComplete = vi.fn();
    const llm = { complete: llmComplete } as any;
    const executor = { execute: vi.fn() } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: {} }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: false, reason: 'test limit' }),
      confirm: vi.fn(),
      release: vi.fn(),
    } as any;

    const manager = new AutonomousManager(llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan();

    expect(result).toBeTruthy();
    expect(llmComplete).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
