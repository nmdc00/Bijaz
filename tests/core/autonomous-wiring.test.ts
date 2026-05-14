/**
 * autonomous-wiring.test.ts
 *
 * Tests for the v1.98 originator wiring inside AutonomousManager:
 * - LlmTradeOriginator + OriginationTrigger + TaSurface integrated into runScan
 * - Symbol cooldown logic
 * - Quant fallback on cadence trigger
 * - Gate reject / resize
 * - Exit policy uses LLM TTL and invalidation price
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveSessionWeightContext } from '../../src/core/session-weight.js';

// ── Hoisted mock functions (available before vi.mock calls) ───────────────────

const mocks = vi.hoisted(() => {
  const dbRun = vi.fn(() => ({}));
  const dbPrepare = vi.fn((sql: string) => {
    if (sql.includes('COUNT(*)')) return { get: () => ({ c: 0 }) };
    return { run: dbRun, all: () => [], get: () => undefined };
  });
  const dbExec = vi.fn();

  const taComputeAll = vi.fn();
  const triggerShouldFire = vi.fn();
  const originatorPropose = vi.fn();
  const upsertExitPolicy = vi.fn();
  const updateTradeProposalOutcome = vi.fn();
  const updateTradeProposalStatus = vi.fn();
  const recordDecisionAudit = vi.fn();
  const recordPerpTradeJournal = vi.fn();
  const upsertTradeDossier = vi.fn(() => ({ id: 'dossier-mock-id' }));
  const createPrediction = vi.fn(() => 'pred-mock-id');
  const createLearningCase = vi.fn(() => ({ id: 'case-mock-id' }));
  const getSignalWeights = vi.fn(() => ({ technical: 0.5, news: 0.3, onChain: 0.2 }));
  const runDiscovery = vi.fn(async () => ({
    clusters: [],
    hypotheses: [],
    expressions: [],
    selector: { source: 'configured', symbols: [] },
  }));
  const getLatestThought = vi.fn(() => null);
  const listForecastsForEvent = vi.fn(() => []);
  const listOutcomesForEvent = vi.fn(() => []);
  const searchHistoricalCases = vi.fn(() => []);

  // Stable mock objects — replaced entirely on each TaSurface/OriginationTrigger/LlmTradeOriginator construction
  // by capturing via the constructor mock
  const taSurfaceInstance = {
    computeAll: (...args: unknown[]) => taComputeAll(...args),
    hasAlert: (snap: any) => snap.alertReason !== undefined,
    summarizeCoverage: (markets: string[], snapshots: Array<{ symbol: string }>) => {
      const requestedMarkets = Array.from(
        new Set(markets.map((market) => String(market ?? '').trim()).filter(Boolean))
      );
      const snapshotSymbols = new Set(
        snapshots.map((snapshot) => String(snapshot.symbol ?? '').trim()).filter(Boolean)
      );
      return {
        requestedMarkets,
        requestedCount: requestedMarkets.length,
        snapshotCount: snapshotSymbols.size,
        coverageRatio: requestedMarkets.length > 0 ? snapshotSymbols.size / requestedMarkets.length : 0,
        missingMarkets: requestedMarkets.filter((market) => !snapshotSymbols.has(market)),
      };
    },
  };
  const triggerInstance = {
    shouldFire: (...args: unknown[]) => triggerShouldFire(...args),
  };
  const originatorInstance = {
    propose: (...args: unknown[]) => originatorPropose(...args),
  };
  const positionBookInstance = {
    refresh: vi.fn(async () => {}),
    getAll: vi.fn(() => []),
    get: vi.fn(() => undefined),
    hasPosition: vi.fn(() => false),
    hasConflict: vi.fn(() => false),
    findOppositeSideLosers: vi.fn(() => []),
  };

  return {
    dbRun, dbPrepare, dbExec,
    taComputeAll, triggerShouldFire, originatorPropose,
    upsertExitPolicy, updateTradeProposalOutcome, updateTradeProposalStatus, recordDecisionAudit, recordPerpTradeJournal, upsertTradeDossier,
    createPrediction, createLearningCase, getSignalWeights, runDiscovery,
    getLatestThought, listForecastsForEvent, listOutcomesForEvent, searchHistoricalCases,
    taSurfaceInstance, triggerInstance, originatorInstance, positionBookInstance,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({ exec: mocks.dbExec, prepare: mocks.dbPrepare }),
}));

vi.mock('../../src/memory/predictions.js', () => ({
  createPrediction: (...args: unknown[]) => mocks.createPrediction(...args),
  findOpenPerpPrediction: vi.fn(() => null),
}));

vi.mock('../../src/memory/learning_cases.js', () => ({
  createLearningCase: (...args: unknown[]) => mocks.createLearningCase(...args),
}));

vi.mock('../../src/memory/learning.js', () => ({
  getSignalWeights: (...args: unknown[]) => mocks.getSignalWeights(...args),
}));

vi.mock('../../src/core/ta_surface.js', () => ({
  TaSurface: vi.fn(() => mocks.taSurfaceInstance),
}));

vi.mock('../../src/core/origination_trigger.js', () => ({
  OriginationTrigger: vi.fn(() => mocks.triggerInstance),
}));

vi.mock('../../src/core/llm_trade_originator.js', () => ({
  LlmTradeOriginator: vi.fn(() => mocks.originatorInstance),
}));

vi.mock('../../src/memory/llm_trade_proposals.js', () => ({
  updateTradeProposalOutcome: (...args: unknown[]) => mocks.updateTradeProposalOutcome(...args),
  updateTradeProposalStatus: (...args: unknown[]) => mocks.updateTradeProposalStatus(...args),
}));

vi.mock('../../src/memory/decision_audit.js', () => ({
  recordDecisionAudit: (...args: unknown[]) => mocks.recordDecisionAudit(...args),
}));

vi.mock('../../src/discovery/engine.js', () => ({
  runDiscovery: (...args: unknown[]) => mocks.runDiscovery(...args),
}));

vi.mock('../../src/discovery/market_selector.js', () => ({
  selectDiscoveryMarkets: vi.fn(async () => ({
    source: 'full_universe' as const,
    candidates: [
      { symbol: 'BTC', score: 1, liquidityScore: 1, executionScore: 1, fundingScore: 1, openInterestUsd: 1e9, dayVolumeUsd: 1e8, fundingRate: 0, spreadProxyBps: 0 },
      { symbol: 'ETH', score: 0.9, liquidityScore: 1, executionScore: 1, fundingScore: 1, openInterestUsd: 5e8, dayVolumeUsd: 5e7, fundingRate: 0, spreadProxyBps: 0 },
    ],
  })),
}));

vi.mock('../../src/memory/perp_trades.js', () => ({
  recordPerpTrade: vi.fn(() => 1),
  setActivePerpPositionLifecycle: vi.fn(),
}));

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  recordPerpTradeJournal: (...args: unknown[]) => mocks.recordPerpTradeJournal(...args),
  listPerpTradeJournals: vi.fn(() => []),
}));

vi.mock('../../src/memory/trade_dossiers.js', () => ({
  upsertTradeDossier: (...args: unknown[]) => mocks.upsertTradeDossier(...args),
}));

vi.mock('../../src/execution/perp-risk.js', () => ({
  checkPerpRiskLimits: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../../src/core/autonomy_policy.js', () => ({
  applyReflectionMutation: vi.fn(() => ({ mutated: false, state: {} })),
  classifyMarketRegime: vi.fn(() => 'trending'),
  classifySignalClass: vi.fn(() => 'momentum_breakout'),
  computeFractionalKellyFraction: vi.fn(() => 0.25),
  evaluateGlobalTradeGate: vi.fn(() => ({ allowed: true })),
  evaluateNewsEntryGate: vi.fn(() => ({ allowed: true })),
  inferBroadMarketPosture: vi.fn(() => 'neutral'),
  isSignalClassAllowedForRegime: vi.fn(() => true),
  resolveLiquidityBucket: vi.fn(() => 'normal'),
  resolveVolatilityBucket: vi.fn(() => 'medium'),
}));

vi.mock('../../src/core/signal_performance.js', () => ({
  summarizeSignalPerformance: vi.fn(() => ({ sampleCount: 0, expectancy: 0.5, variance: 0.5 })),
  summarizeAllSignalClasses: vi.fn(() => ({})),
}));

vi.mock('../../src/memory/autonomy_policy_state.js', () => ({
  getAutonomyPolicyState: vi.fn(() => ({
    minEdgeOverride: null,
    maxTradesPerScanOverride: null,
    leverageCapOverride: null,
    observationOnlyUntilMs: null,
    reason: null,
    updatedAt: new Date().toISOString(),
  })),
}));

vi.mock('../../src/memory/trades.js', () => ({
  listOpenPositionsFromTrades: vi.fn(() => []),
}));

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  upsertPositionExitPolicy: (...args: unknown[]) => mocks.upsertExitPolicy(...args),
  getPositionExitPolicy: vi.fn(() => null),
  clearPositionExitPolicy: vi.fn(),
}));

vi.mock('../../src/memory/paper_perps.js', () => ({
  listPaperPerpPositions: vi.fn(() => []),
  listPaperPerpPositionsWithMark: vi.fn(() => []),
  getPaperPerpBookSummary: vi.fn(() => ({ cashBalanceUsdc: 200 })),
}));

vi.mock('../../src/memory/portfolio.js', () => ({
  getCashBalance: vi.fn(() => null),
}));

vi.mock('../../src/memory/llm_entry_gate_log.js', () => ({
  recordEntryGateDecision: vi.fn(),
}));

vi.mock('../../src/memory/events.js', () => ({
  listEvents: vi.fn(() => []),
  getLatestThought: (...args: unknown[]) => mocks.getLatestThought(...args),
  listForecastsForEvent: (...args: unknown[]) => mocks.listForecastsForEvent(...args),
  listOutcomesForEvent: (...args: unknown[]) => mocks.listOutcomesForEvent(...args),
}));

vi.mock('../../src/events/casebase.js', () => ({
  searchHistoricalCases: (...args: unknown[]) => mocks.searchHistoricalCases(...args),
}));

vi.mock('../../src/markets/context.js', () => ({
  gatherMarketContext: vi.fn(async () => ({ results: [], domain: 'crypto', primarySource: '', sources: [] })),
  classifyMarketContextDomain: vi.fn(() => 'crypto'),
}));

vi.mock('../../src/core/exit_contract.js', () => ({
  buildLegacyExitContract: vi.fn((input: any) => ({ thesis: input.thesis, side: input.side })),
  serializeExitContract: vi.fn((ec: any) => JSON.stringify(ec)),
  parseExitContract: vi.fn(() => null),
  summarizeExitContract: vi.fn(() => null),
}));

vi.mock('../../src/core/position_book.js', () => {
  const PositionBook = {
    _instance: mocks.positionBookInstance,
    getInstance() { return this._instance; },
  };
  return { PositionBook };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeGateLlm(verdict: 'approve' | 'reject' | 'resize', adjustedSizeUsd?: number) {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify({
        verdict,
        reasoning: `test verdict: ${verdict}`,
        stopLevelPrice: null,
        equityAtRiskPct: 2.5,
        targetRR: 2.0,
        ...(adjustedSizeUsd !== undefined ? { adjustedSizeUsd } : {}),
      }),
      model: 'test',
    })),
  } as any;
}

function makeLimiter(remaining = 1000) {
  return {
    getRemainingDaily: vi.fn(() => remaining),
    checkAndReserve: vi.fn(async () => ({ allowed: true })),
    confirm: vi.fn(),
    release: vi.fn(),
  } as any;
}

const BASE_SNAPSHOT = {
  symbol: 'BTC',
  price: 70000,
  priceVs24hHigh: -1,
  priceVs24hLow: 5,
  oiUsd: 1_000_000,
  oiDelta1hPct: 12,
  oiDelta4hPct: 5,
  fundingRatePct: 10,
  volumeVs24hAvgPct: 200,
  priceVsEma20_1h: 1.5,
  trendBias: 'up' as const,
  alertReason: 'oi_spike_1h:12.0%',
};

const BASE_PROPOSAL = {
  proposalRecordId: 42,
  symbol: 'BTC',
  side: 'long' as const,
  leverage: 5,
  thesisText: 'BTC breaking out with OI spike',
  invalidationCondition: 'close below 68000',
  invalidationPrice: 68000,
  suggestedTtlMinutes: 45,
  confidence: 0.72,
};

const baseConfig = {
  execution: { mode: 'paper' },
  paper: { initialCashUsdc: 200 },
  autonomy: {
    enabled: true,
    fullAuto: true,
    scanIntervalSeconds: 300,
    minEdge: 0.05,
    maxTradesPerScan: 1,
    origination: {
      enabled: true,
      cadenceMinutes: 15,
      topMarketsCount: 20,
      quantFallbackEnabled: true,
      cooldownMinutes: 30,
    },
    llmEntryGate: { enabled: true },
  },
  hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 },
} as any;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AutonomousManager — originator wiring (v1.98)', () => {
  beforeEach(() => {
    // Reset call history only (not implementations)
    vi.clearAllMocks();
    // Restore default behaviors
    mocks.taComputeAll.mockResolvedValue([BASE_SNAPSHOT]);
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'ta_alert', alertedSymbols: ['BTC'] });
    mocks.originatorPropose.mockResolvedValue(BASE_PROPOSAL);
    mocks.createPrediction.mockReturnValue('pred-mock-id');
    mocks.runDiscovery.mockResolvedValue({
      clusters: [],
      hypotheses: [],
      expressions: [],
      selector: { source: 'configured', symbols: [] },
    });
    mocks.getSignalWeights.mockReturnValue({ technical: 0.5, news: 0.3, onChain: 0.2 });
    mocks.getLatestThought.mockReturnValue(null);
    mocks.listForecastsForEvent.mockReturnValue([]);
    mocks.listOutcomesForEvent.mockReturnValue([]);
    mocks.searchHistoricalCases.mockReturnValue([]);
    mocks.positionBookInstance.getAll.mockReturnValue([]);
    mocks.positionBookInstance.hasPosition.mockReturnValue(false);
  });

  it('1. proposal → gate approve → executor called, exit policy written with LLM TTL and invalidation price', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan({ forceExecute: true });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    const decision = executor.execute.mock.calls[0]![1];
    expect(decision.symbol).toBe('BTC');
    expect(decision.side).toBe('buy');
    expect(decision.modelProbability).toBe(0.72);

    // Exit policy: invalidationPrice = 68000, TTL = 45 min
    expect(mocks.upsertExitPolicy).toHaveBeenCalledTimes(1);
    const [sym, side, timeStop, invPrice, , predictionId] = mocks.upsertExitPolicy.mock.calls[0]!;
    expect(sym).toBe('BTC');
    expect(side).toBe('long');
    expect(invPrice).toBe(68000);
    expect(predictionId).toBe('pred-mock-id');
    expect(timeStop).toBeGreaterThan(Date.now());
    expect(timeStop).toBeLessThanOrEqual(Date.now() + 45 * 60 * 1000 + 1000);

    expect(mocks.updateTradeProposalStatus).toHaveBeenCalledWith(42, expect.objectContaining({
      executeTrades: true,
      originatorExitStage: 'proposed',
      requestedLeverage: 5,
    }));
    expect(mocks.updateTradeProposalStatus).toHaveBeenCalledWith(42, expect.objectContaining({
      executeTrades: true,
      originatorExitStage: 'entry_gate_pending',
    }));
    expect(mocks.updateTradeProposalStatus).toHaveBeenCalledWith(42, expect.objectContaining({
      executeTrades: true,
      originatorExitStage: 'entry_gate_approved',
      originatorExitReason: 'test verdict: approve',
      requestedLeverage: 5,
    }));
    expect(mocks.updateTradeProposalStatus).toHaveBeenCalledWith(42, expect.objectContaining({
      executeTrades: true,
      originatorExitStage: 'executed',
      originatorExitReason: 'paper ok',
      requestedLeverage: 5,
    }));
    expect(mocks.createLearningCase).toHaveBeenCalledWith(expect.objectContaining({
      caseType: 'comparable_forecast',
      sourcePredictionId: 'pred-mock-id',
      sourceDossierId: 'dossier-mock-id',
    }));
    expect(mocks.recordPerpTradeJournal).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'BTC',
      reduceOnly: false,
      outcome: 'executed',
      signalClass: 'llm_originator',
    }));
    expect(mocks.updateTradeProposalOutcome).toHaveBeenCalledWith(42, 'approve', true);

    expect(result).toContain('paper ok');
  }, 60_000);

  it('2. null proposal + cadence trigger → quant fallback runs', async () => {
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'cadence', alertedSymbols: [] });
    mocks.originatorPropose.mockResolvedValue(null);

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan({ forceExecute: true });

    // Discovery ran (no expressions → quant fallback message)
    expect(result).toMatch(/No discovery expressions/i);
  }, 60_000);

  it('3. null proposal + ta_alert trigger → quant fallback does NOT run, returns originator message', async () => {
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'ta_alert', alertedSymbols: ['BTC'] });
    mocks.originatorPropose.mockResolvedValue(null);

    const { AutonomousManager } = await import('../../src/core/autonomous.js');

    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: {} }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan({ forceExecute: true });

    expect(result).toContain('Originator returned null');
    expect(result).toContain('ta_alert');
    expect(mocks.runDiscovery).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(mocks.createPrediction).not.toHaveBeenCalled();
  });

  it('4. symbol cooldown: after BTC proposal, BTC is filtered from next scan snapshots', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);

    // First scan — BTC proposed and executed (sets cooldown)
    await manager.runScan({ forceExecute: true });
    expect(mocks.originatorPropose).toHaveBeenCalledTimes(1);

    // Reset proposal mock, switch to cadence trigger
    mocks.originatorPropose.mockClear();
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'cadence', alertedSymbols: [] });

    // Second scan
    await manager.runScan({ forceExecute: true });

    // If originator was called on second scan, BTC should be absent from taSnapshots
    if (mocks.originatorPropose.mock.calls.length > 0) {
      const bundle = mocks.originatorPropose.mock.calls[0]![0] as any;
      const symbols = bundle.taSnapshots.map((s: any) => s.symbol);
      expect(symbols).not.toContain('BTC');
    }
    // If originator wasn't called (trigger didn't fire with new taSnapshots), that's also valid
  });

  it('4a. returns explicit ta_unavailable result when TA snapshots collapse to zero before triggering originator', async () => {
    mocks.taComputeAll.mockResolvedValue([]);

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: {} }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan({ forceExecute: true });

    expect(result).toContain('ta_unavailable');
    expect(result).toContain('0/2');
    expect(mocks.triggerShouldFire).not.toHaveBeenCalled();
    expect(mocks.originatorPropose).not.toHaveBeenCalled();
    expect(mocks.runDiscovery).not.toHaveBeenCalled();
    expect(mocks.recordDecisionAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tradeOutcome: 'skipped',
        notes: expect.objectContaining({
          originatorExitStage: 'ta_unavailable',
          requestedCount: 2,
          snapshotCount: 0,
          usableSnapshotCount: 0,
        }),
      })
    );
  });

  it('4c. returns explicit ta_unavailable result when usable TA coverage is filtered out by an existing position', async () => {
    mocks.positionBookInstance.hasPosition.mockImplementation((symbol: string) => symbol === 'BTC');

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: {} }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan({ forceExecute: true });

    expect(result).toContain('ta_unavailable');
    expect(result).toContain('usable coverage collapsed');
    expect(mocks.triggerShouldFire).not.toHaveBeenCalled();
    expect(mocks.originatorPropose).not.toHaveBeenCalled();
    expect(mocks.recordDecisionAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: expect.objectContaining({
          originatorExitStage: 'ta_unavailable',
          requestedCount: 2,
          snapshotCount: 1,
          usableSnapshotCount: 0,
          filteredOutCount: 1,
        }),
      })
    );
  });

  it('4b. event artifacts and historical cases are injected into originator bundle for commodity contexts', async () => {
    mocks.taComputeAll.mockResolvedValue([
      { ...BASE_SNAPSHOT, symbol: 'XYZ:CL', trendBias: 'up', alertReason: undefined },
      { ...BASE_SNAPSHOT, symbol: 'XYZ:GOLD', trendBias: 'up', alertReason: undefined },
    ]);
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'event', alertedSymbols: [] });
    const event = {
      id: 'event-1',
      eventKey: 'event-key-1',
      title: 'Hormuz disruption tightens crude exports',
      domain: 'energy',
      occurredAt: new Date().toISOString(),
      sourceIntelIds: ['intel-1'],
      tags: ['supply_shock', 'attack'],
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const thought = {
      id: 'thought-1',
      eventId: 'event-1',
      version: 1,
      mechanism: 'Shipping disruption reduces crude availability and lifts front-month oil.',
      causalChain: ['attack disrupts shipping', 'exports fall', 'oil reprices higher'],
      impactedAssets: [
        { symbol: 'CL', direction: 'up', confidence: 0.82 },
        { symbol: 'BRENTOIL', direction: 'up', confidence: 0.79 },
      ],
      invalidationConditions: ['shipping resumes quickly'],
      createdAt: new Date().toISOString(),
    };
    mocks.getLatestThought.mockReturnValue(thought);
    mocks.listForecastsForEvent.mockReturnValue([
      {
        id: 'forecast-1',
        eventId: 'event-1',
        thoughtId: 'thought-1',
        asset: 'CL',
        domain: 'energy',
        direction: 'up',
        horizonHours: 24,
        confidence: 0.82,
        invalidationConditions: ['shipping resumes quickly'],
        status: 'open',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      },
    ]);
    mocks.listOutcomesForEvent.mockReturnValue([
      {
        id: 'outcome-1',
        forecastId: 'forecast-0',
        eventId: 'event-1',
        resolutionStatus: 'confirmed',
        actualDirection: 'up',
        resolvedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ]);
    mocks.searchHistoricalCases.mockReturnValue([
      {
        case_key: '2019-abqaiq-attack-oil',
        event_date: '2019-09-14',
        event_type: 'attack',
        title: 'Abqaiq attack disrupts Saudi output',
        summary: 'Oil jumps on supply shock.',
        domain: 'energy',
        actors: ['Saudi Arabia'],
        locations: ['Saudi Arabia'],
        channels: ['shipping'],
        first_order_assets: ['CL'],
        second_order_assets: ['BRENTOIL'],
        mechanism: 'supply outage reprices crude benchmarks higher',
        causal_chain: ['attack', 'output outage', 'oil higher'],
        forecast: { direction: 'up', horizons: ['24h'] },
        outcome: { direction_correct: true, realized_note: 'Oil rallied.' },
        regime_tags: ['supply_shock'],
        sources: [],
        validation_status: 'validated',
      },
    ]);
    const { listEvents } = await import('../../src/memory/events.js');
    vi.mocked(listEvents).mockReturnValue([event] as any);

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'XYZ:CL', markPrice: 70, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan({ forceExecute: false });

    const bundle = mocks.originatorPropose.mock.calls[0]![0] as any;
    expect(bundle.contextDomain).toBe('energy');
    expect(bundle.eventContext).toContain('Hormuz disruption tightens crude exports');
    expect(bundle.eventContext).toContain('Shipping disruption reduces crude availability');
    expect(bundle.eventContext).toContain('CL up 24h');
    expect(bundle.eventContext).toContain('2019-abqaiq-attack-oil');
  });

  it('5. gate reject → executor NOT called', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('reject');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan({ forceExecute: true });

    expect(executor.execute).not.toHaveBeenCalled();
    expect(result).toMatch(/rejected by LLM entry gate/i);
    expect(limiter.release).toHaveBeenCalled();
    expect(mocks.updateTradeProposalStatus).toHaveBeenCalledWith(42, expect.objectContaining({
      executeTrades: true,
      originatorExitStage: 'entry_gate_rejected',
      originatorExitReason: 'test verdict: reject',
      requestedLeverage: 5,
    }));
    expect(mocks.updateTradeProposalOutcome).toHaveBeenCalledWith(42, 'reject', false);
  });

  it('5b. execute=false leaves proposal pre-gate and records execute_disabled status', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    manager.setFullAuto(false);
    const result = await manager.runScan();

    expect(result).toMatch(/execute=false/i);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(mocks.updateTradeProposalOutcome).not.toHaveBeenCalled();
    expect(mocks.updateTradeProposalStatus).toHaveBeenCalledWith(42, expect.objectContaining({
      executeTrades: false,
      originatorExitStage: 'proposed',
      requestedLeverage: 5,
    }));
    expect(mocks.updateTradeProposalStatus).toHaveBeenCalledWith(42, expect.objectContaining({
      executeTrades: false,
      originatorExitStage: 'execute_disabled',
      originatorExitReason: 'runScan invoked with executeTrades=false',
    }));
  });

  it('6. gate resize → executor called with adjusted size', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('resize', 15);
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan({ forceExecute: true });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    const decision = executor.execute.mock.calls[0]![1];
    // size = adjustedSizeUsd / markPrice = 15 / 70000
    expect(decision.size).toBeCloseTo(15 / 70000, 6);
  });

  it('7. LLM down (originator throws) on cadence tick → quant fallback runs, no crash', async () => {
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'cadence', alertedSymbols: [] });
    mocks.originatorPropose.mockRejectedValue(new Error('LLM timeout'));

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: false, message: 'no trade' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: {} }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);

    // Should not throw
    const result = await manager.runScan({ forceExecute: true });
    expect(result).toBeTruthy();
    // Fell through to quant discovery path
    expect(result).toMatch(/No discovery expressions/i);
  });

  it('8. exit policy uses LLM TTL: suggestedTtlMinutes=45 → timeStopAtMs = now + 45*60*1000', async () => {
    mocks.originatorPropose.mockResolvedValue({
      ...BASE_PROPOSAL,
      suggestedTtlMinutes: 45,
    });

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const before = Date.now();
    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan({ forceExecute: true });
    const after = Date.now();

    expect(mocks.upsertExitPolicy).toHaveBeenCalledTimes(1);
    const [, , timeStop] = mocks.upsertExitPolicy.mock.calls[0]!;
    const expectedMin = before + 45 * 60 * 1000;
    const expectedMax = after + 45 * 60 * 1000;
    expect(timeStop).toBeGreaterThanOrEqual(expectedMin);
    expect(timeStop).toBeLessThanOrEqual(expectedMax);
  });

  it('9. originator path: createPrediction called with executed=true, executionPrice, positionSize after gate approve', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan({ forceExecute: true });

    expect(mocks.createPrediction).toHaveBeenCalledTimes(1);
    const call = mocks.createPrediction.mock.calls[0]![0] as any;
    expect(call.symbol).toBe('BTC');
    expect(call.domain).toBe('perp');
    expect(call.modelProbability).toBe(0.72);
    expect(call.learningComparable).toBe(false);
    expect(call.marketProbability).toBeUndefined();
    expect(call.executed).toBe(true);
    expect(call.executionPrice).toBeGreaterThan(0);
    expect(typeof call.positionSize).toBe('number');
    expect(mocks.createLearningCase).toHaveBeenCalledTimes(1);
    expect(mocks.createLearningCase.mock.calls[0]![0]).toMatchObject({
      caseType: 'comparable_forecast',
      domain: 'perp',
      entityType: 'symbol',
      entityId: 'BTC',
      comparable: false,
      comparatorKind: null,
      exclusionReason: 'missing_comparator',
      baseline: { marketProbability: null },
      sourcePredictionId: 'pred-mock-id',
    });
  });

  it('10. quant fallback path: perp predictions stay non-comparable without fabricating a market baseline', async () => {
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'cadence', alertedSymbols: [] });
    mocks.originatorPropose.mockResolvedValue(null);
    mocks.runDiscovery.mockResolvedValue({
      clusters: [],
      hypotheses: [],
      expressions: [
        {
          id: 'expr-btc',
          hypothesisId: 'hyp-btc',
          symbol: 'BTC',
          side: 'buy',
          confidence: 0.8,
          expectedEdge: 0.12,
          entryZone: 'market',
          invalidation: 'below support',
          expectedMove: 'breakout continuation',
          orderType: 'market',
          leverage: 2,
          probeSizeUsd: 20,
          newsTrigger: null,
        },
      ],
      selector: { source: 'configured', symbols: ['BTC'] },
    });

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan({ forceExecute: true });

    expect(mocks.createPrediction).toHaveBeenCalledTimes(1);
    const call = mocks.createPrediction.mock.calls[0]![0] as any;
    expect(call.marketId).toBe('perp:BTC');
    expect(call.learningComparable).toBe(false);
    expect(call.marketProbability).toBeUndefined();
    expect(call.confidenceRaw).toBe(0.8);
    const expectedAdjustedConfidence = Number((0.8 * resolveSessionWeightContext(new Date()).sessionWeight).toFixed(4));
    expect(call.confidenceAdjusted).toBeCloseTo(expectedAdjustedConfidence, 6);
    expect(call.signalWeightsSnapshot).toEqual({ technical: 0.5, news: 0.3, onChain: 0.2 });
    expect(call.signalScores).toBeUndefined();
    expect(mocks.createLearningCase).toHaveBeenCalledTimes(1);
    expect(mocks.createLearningCase.mock.calls[0]![0]).toMatchObject({
      caseType: 'comparable_forecast',
      domain: 'perp',
      entityType: 'symbol',
      entityId: 'BTC',
      comparable: false,
      comparatorKind: null,
      exclusionReason: 'missing_comparator',
      baseline: { marketProbability: null },
      sourcePredictionId: 'pred-mock-id',
    });
  });

  it('11. originator path: createPrediction NOT called when gate rejects', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('reject');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan({ forceExecute: true });

    expect(executor.execute).not.toHaveBeenCalled();
    expect(mocks.createPrediction).not.toHaveBeenCalled();
  });
});
