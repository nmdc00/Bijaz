/**
 * efficiency-integration-acceptance.test.ts
 *
 * Token accounting harness for v1.91 efficiency sprint.
 * Asserts ≥40% reduction in estimated input tokens for autonomous scan
 * enrichment calls across all v1.91 changes (branches #2–#5):
 *
 *   #2 tool-subset-registry  — discovery/execution subsets vs full (50 tools)
 *   #3 identity-strip-trivial — no identity prelude for trivial/internal calls
 *   #4 autonomous-scan-bypass — 1 direct call vs 2 (orchestrator plan+execute)
 *   #5 context-budget-scoping — trivial: 10K, autonomous: 25K, chat: 120K
 *
 * "Before" baseline (v1.90):
 *   OrchestratorClient used for AutonomousManager.llm
 *   → plan call:    full identity + full tool schema (50 tools) + enrichment msgs
 *   → execute call: full tool schema + executor prompt + plan JSON
 *   Total = 2 calls worth of tokens
 *
 * "After" (v1.91):
 *   Direct trivial client for AutonomousManager.llm
 *   → 1 call: no identity (trivial mode) + no tool schema + msgs capped at 10K
 *   Total = 1 call worth of tokens
 */
import { describe, it, expect, vi } from 'vitest';
import { THUFIR_TOOLS, getToolsForSubset } from '../../src/core/tool-schemas.js';

// Mock external dependencies needed only for the call-count integration test
vi.mock('../../src/discovery/engine.js', () => ({
  runDiscovery: async () => ({
    clusters: [{ id: 'c1', symbol: 'BTC/USDT', directionalBias: 'up', confidence: 0.8, timeHorizon: 'hours', signals: [] }],
    hypotheses: [],
    expressions: [],
    selector: { source: 'configured', symbols: ['BTC'] },
  }),
}));

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  recordPerpTradeJournal: vi.fn(),
  listPerpTradeJournals: () => [],
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

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({
    exec: vi.fn(),
    prepare: vi.fn(() => ({ run: vi.fn(), all: () => [], get: () => ({ c: 0 }) })),
  }),
}));
import { finalizeMessages, resolveMaxPromptChars } from '../../src/core/llm.js';
import { estimateTokensFromMessages, estimateTokensFromText, withExecutionContext } from '../../src/core/llm_infra.js';
import type { ThufirConfig } from '../../src/core/config.js';
import type { LlmClientMeta } from '../../src/core/llm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolSchemaChars(subset: Parameters<typeof getToolsForSubset>[0]): number {
  return JSON.stringify(getToolsForSubset(subset)).length;
}

function makeConfig(): ThufirConfig {
  return {
    agent: {
      provider: 'anthropic',
      model: 'claude-test',
      workspace: '/tmp/nonexistent-workspace-v191',
      maxPromptChars: 120000,
      maxToolResultChars: 8000,
      identityPromptMode: 'full',
      internalPromptMode: 'none',
      promptBudget: { autonomous: 25000, trivial: 10000, chat: 120000 },
    },
  } as unknown as ThufirConfig;
}

// Simulate the enrichment input messages (same for before and after)
const ENRICHMENT_MESSAGES = [
  {
    role: 'system' as const,
    content:
      'You are a concise trading execution annotator. Return one short line with thesis, invalidation posture, and next check.',
  },
  {
    role: 'user' as const,
    content:
      'symbol=BTC\nside=buy\nexecuted=true\nmessage=paper ok\nreasoning=BTC sees upside continuation | edge=12.00% confidence=52.0% regime=trending signal=momentum_breakout kelly=25.0%',
  },
];

// Orchestrator planner prompt prefix (representative; simulates OrchestratorClient overhead)
const ORCHESTRATOR_PLAN_SYSTEM =
  'You are a strategic orchestrator. Analyse the user intent and tool inputs available. Produce a JSON execution plan with intent + toolCalls array. Do NOT execute tools yourself.';
const EXECUTOR_PROMPT =
  'You are a precise tool executor. Execute the plan JSON step by step. Use tools exactly as specified.';

// ---------------------------------------------------------------------------
// Baseline (v1.90): OrchestratorClient for async enrichment
// ---------------------------------------------------------------------------

function computeBaselineTokens(): number {
  const config = makeConfig();

  // OrchestratorClient builds plannerMessages from [orchestrator system + base system + rest]
  const plannerMessages = [
    { role: 'system' as const, content: `${ORCHESTRATOR_PLAN_SYSTEM}\n\n## Base Instructions\n${ENRICHMENT_MESSAGES[0]!.content}` },
    ENRICHMENT_MESSAGES[1]!,
  ];

  // Plan call uses the primary LLM (full identity injected, full mode)
  const primaryMeta: LlmClientMeta = { provider: 'anthropic', model: 'claude-test', kind: 'primary' };
  const finalizedPlanMessages = finalizeMessages(plannerMessages, config, primaryMeta);
  const planCallChars =
    finalizedPlanMessages.reduce((sum, m) => sum + m.content.length, 0) +
    toolSchemaChars('full');  // AgenticOpenAiClient sends full tool schema
  const planCallTokens = estimateTokensFromText('X'.repeat(planCallChars));

  // Execute call: executor prompt + plan JSON
  // The agentic executor (AgenticOpenAiClient) was constructed without toolSubset → 'full'
  const executorMessages = [
    { role: 'system' as const, content: EXECUTOR_PROMPT },
    { role: 'user' as const, content: `Execution plan:\n${JSON.stringify({ intent: 'annotate trade', toolCalls: [] })}` },
  ];
  // Executor also has identity injected (agentic kind)
  const agenticMeta: LlmClientMeta = { provider: 'openai', model: 'gpt-test', kind: 'agentic' };
  const finalizedExecMessages = finalizeMessages(executorMessages, config, agenticMeta);
  const execCallChars =
    finalizedExecMessages.reduce((sum, m) => sum + m.content.length, 0) +
    toolSchemaChars('full');  // executor also receives full tool schema
  const execCallTokens = estimateTokensFromText('X'.repeat(execCallChars));

  return planCallTokens + execCallTokens;
}

// ---------------------------------------------------------------------------
// After (v1.91): direct trivial client for async enrichment
// ---------------------------------------------------------------------------

function computeAfterTokens(): number {
  const config = makeConfig();

  // AutonomousManager.llm is now infoLlm ?? llm (trivial client)
  // finalizeMessages with trivial kind → no identity, budget capped at 10K
  const trivialMeta: LlmClientMeta = { provider: 'local', model: 'qwen', kind: 'trivial' };
  const finalized = finalizeMessages(ENRICHMENT_MESSAGES, config, trivialMeta);

  // Trivial client sends NO tool schema
  const callChars = finalized.reduce((sum, m) => sum + m.content.length, 0);
  return estimateTokensFromText('X'.repeat(callChars));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v1.91 efficiency integration acceptance', () => {
  it('tool schema: discovery subset is ≥60% smaller than full schema', () => {
    const fullChars = toolSchemaChars('full');
    const discoveryChars = toolSchemaChars('discovery');
    const reduction = (fullChars - discoveryChars) / fullChars;
    expect(reduction).toBeGreaterThanOrEqual(0.6);
  });

  it('tool schema: execution subset is ≥60% smaller than full schema', () => {
    const fullChars = toolSchemaChars('full');
    const executionChars = toolSchemaChars('execution');
    const reduction = (fullChars - executionChars) / fullChars;
    expect(reduction).toBeGreaterThanOrEqual(0.6);
  });

  it('identity strip: trivial mode produces no identity marker in system prompt', () => {
    const config = makeConfig();
    const trivialMeta: LlmClientMeta = { provider: 'local', model: 'qwen', kind: 'trivial' };
    const result = finalizeMessages(ENRICHMENT_MESSAGES, config, trivialMeta);
    const systemContent = result.find((m) => m.role === 'system')?.content ?? '';
    // Should NOT contain identity marker or the massive identity prelude
    expect(systemContent).not.toContain('THUFIR_IDENTITY_START');
    // Total chars should be well under the trivial budget (10K)
    const totalChars = result.reduce((sum, m) => sum + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(10000);
  });

  it('context budget: resolveMaxPromptChars returns correct ceilings by kind/context', async () => {
    const config = makeConfig();
    const trivialMeta: LlmClientMeta = { provider: 'local', model: 'q', kind: 'trivial' };
    const primaryMeta: LlmClientMeta = { provider: 'anthropic', model: 'c', kind: 'primary' };

    expect(resolveMaxPromptChars(config, trivialMeta)).toBe(10000);
    expect(resolveMaxPromptChars(config, primaryMeta)).toBe(120000);

    const autoResult = await withExecutionContext(
      { mode: 'LIGHT_REASONING', source: 'autonomous', reason: 'scan' },
      async () => resolveMaxPromptChars(config, primaryMeta)
    );
    expect(autoResult).toBe(25000);
  });

  it('overall: ≥40% reduction in estimated input tokens for autonomous scan enrichment', () => {
    const beforeTokens = computeBaselineTokens();
    const afterTokens = computeAfterTokens();
    const reduction = (beforeTokens - afterTokens) / beforeTokens;

    // Provide diagnostic output on failure
    expect(
      reduction,
      `Expected ≥40% reduction. Before: ${beforeTokens} tokens, After: ${afterTokens} tokens, Reduction: ${(reduction * 100).toFixed(1)}%`
    ).toBeGreaterThanOrEqual(0.4);
  });

  it('call count: autonomous scan pipeline makes 0 LLM calls (deterministic path)', async () => {
    // Verify by running a real AutonomousManager scan and counting llm.complete() calls.
    // Mocks are set up for all discovery/DB dependencies.
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const callCount = { n: 0 };
    const llm = {
      complete: async () => {
        callCount.n += 1;
        return { content: 'ok', model: 'test' };
      },
    } as any;

    // Config with no asyncEnrichment and no executeTrades to keep the test focused
    const config = {
      autonomy: {
        enabled: true,
        fullAuto: false,  // no trades → no enrichment either
        scanIntervalSeconds: 300,
        minEdge: 0.05,
        maxTradesPerScan: 1,
      },
      hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 },
    } as any;

    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: {} }) } as any;
    const executor = { execute: async () => ({ executed: false, message: 'no-op' }) } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: false, reason: 'scan only' }),
      confirm: () => {},
      release: () => {},
    } as any;

    const manager = new AutonomousManager(llm, marketClient, executor, limiter, config);
    await manager.runScan();

    // Zero LLM calls: discovery/filter/evaluate is all deterministic code
    expect(callCount.n).toBe(0);
  });
});
