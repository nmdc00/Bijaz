/**
 * Agent Orchestrator
 *
 * Main loop that coordinates planning, tool execution, reflection, and synthesis.
 * Implements the mentat-style reasoning flow:
 *   goal -> memory -> plan -> (tool -> reflect)* -> synthesize -> critic -> result
 */

import type { ChatMessage } from '../../core/llm.js';
import type { AgentPlan, PlanStep } from '../planning/types.js';
import type { CriticContext, TradeFragilityContext } from '../critic/types.js';
import type { ToolExecution } from '../tools/types.js';
import type { Reflection } from '../reflection/types.js';
import type {
  AgentState,
  OrchestratorContext,
  OrchestratorResult,
  OrchestratorOptions,
  SynthesisRequest,
} from './types.js';

import { detectMode, getModeConfig, getAllowedTools } from '../modes/registry.js';
import {
  createPlan,
  revisePlan,
  getReadySteps,
  completeStep,
  failStep,
} from '../planning/planner.js';
import { reflect, createReflectionState, applyReflection } from '../reflection/reflector.js';
import { runCritic, shouldRunCritic } from '../critic/critic.js';
import { buildIdentityPrompt, buildMinimalIdentityPrompt } from '../identity/identity.js';
import type { QuickFragilityScan } from '../../mentat/scan.js';
import { recordDecisionAudit } from '../../memory/decision_audit.js';
import {
  recordAgentIncident,
  listRecentAgentIncidents,
  type AgentBlockerKind,
} from '../../memory/incidents.js';
import { getPlaybook, upsertPlaybook, searchPlaybooks } from '../../memory/playbooks.js';
import {
  detectBlockers,
  seedPlaybookForBlocker,
  suggestedRemediationToolSteps,
} from './blockers.js';
import {
  createAgentState,
  updatePlan,
  addToolExecution,
  applyReflectionToState,
  setMemoryContext,
  incrementIteration,
  completeState,
  addWarning,
  addError,
  setPlan,
  shouldContinue,
  toToolExecutionContext,
} from './state.js';

const TERMINAL_TRADE_TOOLS = new Set(['perp_place_order', 'perp_cancel_order']);
const MAX_PARALLEL_READ_STEPS = 3;
const MUTATING_TRADE_TOOLS = new Set(['perp_place_order', 'perp_cancel_order']);
const NO_TRADE_DECISION_PREFIX = 'NO_TRADE_DECISION:';
const EXECUTION_INTENT_PATTERNS = [
  /\b(buy|sell|place|execute|open|close|reduce|trim|cut|flatten|cancel)\b/i,
  /\b(go|going)\s+(long|short)\b/i,
  /\b(rebalance|de-risk|derisk)\b/i,
  /\b(take\s+(profit|tp)|set\s+(sl|stop.?loss|tp))/i,
];
const RETROSPECTIVE_INTENT_PATTERNS = [
  /\b(why|reason|explain|walk me through|what happened|how come)\b/i,
  /\b(prior|previous|last|earlier)\b/i,
  /\b(trade|position|order|long|short)\b/i,
];
const LOSS_ALERT_PATTERNS = [
  /\b(losing money|loss(?:es)?|drawdown|bleeding|underperforming|down bad)\b/i,
  /\b(you('?re| are)\s+losing)\b/i,
];

function hasAnyPattern(input: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

function isTradeRetrospectiveGoal(goal: string): boolean {
  return (
    hasAnyPattern(goal, RETROSPECTIVE_INTENT_PATTERNS) &&
    /\b(trade|position|order|long|short)\b/i.test(goal)
  );
}

function isTradeExecutionIntent(goal: string): boolean {
  if (isTradeRetrospectiveGoal(goal)) {
    return false;
  }
  if (hasAnyPattern(goal, LOSS_ALERT_PATTERNS) && !hasAnyPattern(goal, EXECUTION_INTENT_PATTERNS)) {
    return false;
  }
  return hasAnyPattern(goal, EXECUTION_INTENT_PATTERNS);
}

function shouldPrefetchTradeHistory(goal: string): boolean {
  return isTradeRetrospectiveGoal(goal) || hasAnyPattern(goal, LOSS_ALERT_PATTERNS);
}

function inferSymbolFromGoal(goal: string): string | undefined {
  const match = goal.toUpperCase().match(/\b(BTC|ETH|SOL|AVAX|XRP|DOGE|ADA|BNB)\b/);
  return match ? match[1] : undefined;
}

function isNoTradeDecisionStep(step: PlanStep): boolean {
  return !step.requiresTool && step.description.trim().startsWith(NO_TRADE_DECISION_PREFIX);
}

function isTerminalTradeStep(step: PlanStep): boolean {
  return (
    (step.requiresTool && !!step.toolName && TERMINAL_TRADE_TOOLS.has(step.toolName)) ||
    isNoTradeDecisionStep(step)
  );
}

function hasTerminalTradeStep(plan: AgentPlan): boolean {
  return plan.steps.some((step) => isTerminalTradeStep(step));
}

function hasPendingTerminalTradeStep(plan: AgentPlan): boolean {
  return plan.steps.some((step) => step.status === 'pending' && isTerminalTradeStep(step));
}

function nextInjectedStepId(plan: AgentPlan, base: string): string {
  let counter = 1;
  let id = `${base}-${counter}`;
  const existing = new Set(plan.steps.map((step) => step.id));
  while (existing.has(id)) {
    counter += 1;
    id = `${base}-${counter}`;
  }
  return id;
}

function buildAutonomousTradeFallbackSteps(
  plan: AgentPlan,
  toolRegistry: OrchestratorContext['toolRegistry']
): PlanStep[] {
  const available = new Set(toolRegistry.listNames());
  const steps: PlanStep[] = [];
  const deps: string[] = [];

  if (available.has('get_portfolio')) {
    const id = nextInjectedStepId(plan, 'autonomous-get-portfolio');
    steps.push({
      id,
      description: 'Autonomous fallback: refresh portfolio before terminal trade action',
      requiresTool: true,
      toolName: 'get_portfolio',
      toolInput: {},
      status: 'pending',
    });
    deps.push(id);
  }

  if (available.has('get_open_orders')) {
    const id = nextInjectedStepId(plan, 'autonomous-get-open-orders');
    steps.push({
      id,
      description: 'Autonomous fallback: refresh open orders before terminal trade action',
      requiresTool: true,
      toolName: 'get_open_orders',
      toolInput: {},
      status: 'pending',
      dependsOn: deps.length > 0 ? [...deps] : undefined,
    });
    deps.push(id);
  }

  if (available.has('perp_place_order')) {
    const id = nextInjectedStepId(plan, 'autonomous-perp-place-order');
    steps.push({
      id,
      description: 'Autonomous fallback terminal action: place a perp order',
      requiresTool: true,
      toolName: 'perp_place_order',
      toolInput: {
        symbol: 'to_be_determined',
        side: 'to_be_determined',
        size: 'to_be_determined',
        order_type: 'to_be_determined',
        price: 'to_be_determined',
      },
      status: 'pending',
      dependsOn: deps.length > 0 ? [...deps] : undefined,
    });
  }

  return steps;
}

function enforceTradeTerminalContract(
  state: AgentState,
  ctx: OrchestratorContext,
  reason: string
): AgentState {
  if (state.mode !== 'trade' || !state.plan) {
    return state;
  }
  if (!isTradeExecutionIntent(state.goal)) {
    return state;
  }
  if (hasTerminalTradeStep(state.plan)) {
    return state;
  }

  const injectedSteps = buildAutonomousTradeFallbackSteps(state.plan, ctx.toolRegistry);
  if (injectedSteps.length === 0) {
    return addWarning(
      state,
      `Trade terminal contract not enforced (${reason}): no fallback tools available`
    );
  }

  let nextState = setPlan(state, {
    ...state.plan,
    steps: [...state.plan.steps, ...injectedSteps],
    updatedAt: new Date().toISOString(),
  });
  nextState = addWarning(
    nextState,
    `Trade terminal contract enforced (${reason}); injected ${injectedSteps.length} fallback step(s)`
  );
  return nextState;
}

function shouldReviseAfterReflection(reflection: Reflection, execution: ToolExecution): boolean {
  if (!reflection.suggestRevision) {
    return false;
  }
  if (!execution.result.success) {
    return true;
  }
  const reason = (reflection.revisionReason ?? '').toLowerCase();
  return /(failed|error|unexpected|mismatch|invalid|missing|insufficient|blocked|no data)/.test(
    reason
  );
}

function formatRecentIncidentsForContext(goal: string, mode: string): string | null {
  // Keep it small and high-signal; this is for planning, not logging.
  try {
    const incidents = listRecentAgentIncidents(10);
    if (incidents.length === 0) return null;

    const lines: string[] = [];
    lines.push('Recent failures (for operational learning):');
    for (const inc of incidents.slice(0, 6)) {
      const when = inc.createdAt;
      const tool = inc.toolName ?? 'unknown_tool';
      const kind = inc.blockerKind ?? 'unknown';
      const err = (inc.error ?? '').slice(0, 180);
      lines.push(`- ${when} kind=${kind} tool=${tool} err=${err}`);
    }

    // Add a tiny hint so the planner knows these are patterns, not current truth.
    lines.push('');
    lines.push(`Current goal: ${goal}`);
    lines.push(`Current mode: ${mode}`);
    return lines.join('\n');
  } catch {
    return null;
  }
}

function formatPlaybooksForContext(goal: string): string | null {
  try {
    const matches = searchPlaybooks({ query: goal, limit: 4 });
    if (matches.length === 0) return null;
    const out: string[] = [];
    out.push('Operator playbooks (procedures):');
    for (const pb of matches) {
      out.push(`### ${pb.title} (${pb.key})`);
      out.push(pb.content.slice(0, 900));
      out.push('');
    }
    return out.join('\n').trim();
  } catch {
    return null;
  }
}

function injectRemediationAndRetry(params: {
  plan: import('../planning/types.js').AgentPlan;
  failedStep: PlanStep;
  blockers: Array<{ kind: AgentBlockerKind; summary: string }>;
  toolRegistry: OrchestratorContext['toolRegistry'];
}): { updated: import('../planning/types.js').AgentPlan; injected: boolean; injectedCount: number } {
  const { plan, failedStep, blockers, toolRegistry } = params;

  const available = new Set(toolRegistry.listNames());
  const newSteps: PlanStep[] = [];
  const remediationStepIds: string[] = [];
  let counter = 1;

  for (const blk of blockers) {
    const candidates = suggestedRemediationToolSteps(blk.kind);
    for (const cand of candidates) {
      if (!available.has(cand.toolName)) continue;
      const id = `remediate-${failedStep.id}-${counter++}`;
      remediationStepIds.push(id);
      newSteps.push({
        id,
        description: cand.description,
        requiresTool: true,
        toolName: cand.toolName,
        toolInput: cand.toolInput,
        status: 'pending',
      });
    }
  }

  if (newSteps.length === 0) {
    return { updated: plan, injected: false, injectedCount: 0 };
  }

  // Retry step after remediation.
  const retryId = `retry-${failedStep.id}`;
  newSteps.push({
    id: retryId,
    description: `Retry: ${failedStep.description}`,
    requiresTool: failedStep.requiresTool,
    toolName: failedStep.toolName,
    toolInput: failedStep.toolInput,
    status: 'pending',
    dependsOn: remediationStepIds.length > 0 ? remediationStepIds : undefined,
  });

  const updatedSteps = plan.steps.map((s) =>
    s.id === failedStep.id ? { ...s, status: 'failed' as const } : s
  );

  return {
    updated: {
      ...plan,
      steps: [...updatedSteps, ...newSteps],
      updatedAt: new Date().toISOString(),
    },
    injected: true,
    injectedCount: newSteps.length,
  };
}

function isDebugEnabled(): boolean {
  return (process.env.THUFIR_LOG_LEVEL ?? '').toLowerCase() === 'debug';
}

function debugLog(message: string, meta?: Record<string, unknown>): void {
  if (!isDebugEnabled()) {
    return;
  }
  if (meta) {
    console.debug(`[orchestrator] ${message}`, meta);
    return;
  }
  console.debug(`[orchestrator] ${message}`);
}

function isToolsListToolName(toolName: string | undefined): boolean {
  return toolName === 'tools_list' || toolName === 'tools.list';
}

function hasUnknownToolFailure(state: AgentState): boolean {
  return state.toolExecutions.some((execution) => {
    if (execution.result.success) return false;
    const error = (execution.result as { error?: string }).error ?? '';
    return /Unknown tool:/i.test(error);
  });
}

function goalRequestsToolsList(goal: string): boolean {
  const normalized = goal.toLowerCase();
  return (
    normalized.includes('tools.list') ||
    normalized.includes('tools_list') ||
    normalized.includes('tool list') ||
    normalized.includes('list tools') ||
    normalized.includes('available tools')
  );
}

function shouldSkipRedundantToolsList(state: AgentState, step: PlanStep): boolean {
  if (!isToolsListToolName(step.toolName)) return false;
  if (goalRequestsToolsList(state.goal)) return false;
  if (hasUnknownToolFailure(state)) return false;
  return true;
}

function goalRequestsTradeMutation(goal: string): boolean {
  const normalized = goal.toLowerCase();
  if (normalized.includes('perp_place_order') || normalized.includes('perp_cancel_order')) return true;
  if (/\b(buy|sell|long|short)\b/.test(normalized)) return true;
  if (/\b(go\s+long|go\s+short)\b/.test(normalized)) return true;
  return (
    /\b(place|execute|open|close|cancel|reduce|increase|enter|exit|flatten|hedge|de-?risk)\b/.test(normalized) &&
    /\b(order|position|trade)\b/.test(normalized)
  );
}

function goalIsAnalysisStyle(goal: string): boolean {
  const normalized = goal.toLowerCase();
  return /\b(thoughts?|review|analy[sz]e|analysis|explain|diagnose|why|how|what should)\b/.test(
    normalized
  );
}

function shouldSkipMutatingTradeToolForAnalysis(state: AgentState, step: PlanStep): boolean {
  if (!step.toolName || !MUTATING_TRADE_TOOLS.has(step.toolName)) return false;
  if (!goalIsAnalysisStyle(state.goal)) return false;
  return !goalRequestsTradeMutation(state.goal);
}

function isReadOnlyStep(step: PlanStep, ctx: OrchestratorContext): boolean {
  if (!step.requiresTool || !step.toolName) return false;
  const toolDef = ctx.toolRegistry.get?.(step.toolName);
  return !toolDef?.sideEffects && !toolDef?.requiresConfirmation;
}

function buildParallelReadBatch(
  readySteps: PlanStep[],
  state: AgentState,
  ctx: OrchestratorContext
): PlanStep[] {
  const batch: PlanStep[] = [];
  for (const step of readySteps) {
    if (batch.length >= MAX_PARALLEL_READ_STEPS) break;
    if (!isReadOnlyStep(step, ctx)) break;
    if (shouldSkipRedundantToolsList(state, step)) continue;
    if (shouldSkipMutatingTradeToolForAnalysis(state, step)) continue;
    batch.push(step);
  }
  return batch;
}

function enforceIdentityMarker(identity: { marker: string }, prompt: string): void {
  if (!isDebugEnabled()) {
    return;
  }
  if (!identity.marker || !prompt.includes(identity.marker)) {
    throw new Error('Identity marker missing in prompt');
  }
}

function resolveIdentityPrompt(
  identity: { name: string; role: string; marker: string },
  ctx: OrchestratorContext
): string {
  const toolCtx = ctx.toolContext as { config?: { agent?: { identityPromptMode?: string } } };
  const mode = toolCtx?.config?.agent?.identityPromptMode ?? 'full';
  if (mode === 'none') return '';
  if (mode === 'minimal') return buildMinimalIdentityPrompt(identity as any);
  return buildIdentityPrompt(identity as any);
}

/**
 * Retrieve relevant context from QMD knowledge base.
 * Uses hybrid search (BM25 + vector + LLM reranking) for best results.
 */
async function retrieveQmdContext(
  goal: string,
  ctx: OrchestratorContext
): Promise<string | null> {
  // Check if QMD is enabled via toolContext config
  const toolCtx = ctx.toolContext as { config?: { qmd?: { enabled?: boolean } } };
  if (!toolCtx?.config?.qmd?.enabled) {
    return null;
  }

  try {
    // Call qmd_query tool via registry
    const execution = await ctx.toolRegistry.execute(
      'qmd_query',
      {
        query: goal,
        mode: 'query', // Hybrid mode for best results
        limit: 5,
      },
      ctx.toolContext
    );

    if (!execution.result.success) {
      debugLog('QMD query failed', { error: (execution.result as { error?: string }).error });
      return null;
    }

    // Format QMD results for context
    const data = execution.result.data as {
      results?: unknown;
      raw?: string;
    };

    if (!data.results && !data.raw) {
      return null;
    }

    // Handle different result formats
    if (data.raw) {
      return data.raw;
    }

    const results = data.results as Array<{
      title?: string;
      content?: string;
      snippet?: string;
      path?: string;
      score?: number;
    }>;

    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }

    // Format results as context
    const formatted = results
      .map((r, i) => {
        const title = r.title ?? r.path ?? `Result ${i + 1}`;
        const content = r.content ?? r.snippet ?? '';
        const score = r.score != null ? ` (relevance: ${r.score.toFixed(2)})` : '';
        return `### ${title}${score}\n${content.slice(0, 500)}${content.length > 500 ? '...' : ''}`;
      })
      .join('\n\n');

    debugLog('QMD context retrieved', { resultCount: results.length });
    return formatted;
  } catch (error) {
    debugLog('QMD retrieval error', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return null;
  }
}

/**
 * System prompt for synthesis.
 */
const SYNTHESIS_SYSTEM_PROMPT = `You are synthesizing a response for an autonomous perp trader.

Based on the tool results and analysis provided, generate a clear, actionable response.

## Rules

1. **Action first**: If you executed a trade or tool, state what happened immediately.
2. **Be terse**: 3-10 lines for routine updates. No walls of text.
3. **Cite evidence**: Reference specific tool results, not assumptions.
4. **State confidence**: Be clear about certainty levels.
5. **No permission-seeking**: Never ask the user for their risk tolerance, time horizon, or preferences. You are autonomous — you decide and act.
6. **CRITICAL — You ARE connected to live tools**: You have full access to perp_place_order, get_portfolio, get_positions, perp_cancel_order, and all other trading tools. The orchestrator executes them on your behalf. NEVER say "I don't have live tools", "I can't execute", "tools aren't wired", or "I'm not connected". If a tool call failed, report the specific error. If no tool was called, that means the plan didn't include it — not that tools are unavailable.
7. **Trade, don't talk about trading**: If the user wants you to trade, your response should report what you traded (or why a specific tool call failed), not describe what you "would" do hypothetically.
8. **Ownership voice**: Speak as the autonomous operator of the managed trading book. Use first person ("I opened", "I reduced", "my position"). Avoid framing trade decisions as user-owned ("your position", "if you want").
9. **Trade response contract**: Use this exact structure only when a terminal trade tool was executed in this cycle or the user explicitly asked for trade execution:
Action: ...
Book State: ...
Risk: ...
Next Action: ...
10. **Loss complaints are first-class**: If the user says performance is bad (losing money/drawdown), acknowledge that concern in the first line and ground it in tool evidence before proposing next actions.
11. **No phantom history gaps**: For prior-trade "why" questions, use trade_review/perp_trade_journal_list evidence and do not claim missing logs unless those tools failed in this cycle.

Respond directly to the user's goal. Do not explain your reasoning process unless asked.`;

function buildTradeBookState(state: AgentState): string {
  const latestPortfolio = [...state.toolExecutions]
    .reverse()
    .find((t) => t.toolName === 'get_portfolio' && t.result.success);
  if (latestPortfolio) {
    const data = (latestPortfolio.result as { success: true; data: Record<string, unknown> }).data;
    const available =
      (data.available_balance as number | string | undefined) ??
      (data.availableBalance as number | string | undefined) ??
      (data.free_usdc as number | string | undefined);
    if (available !== undefined) {
      return `I am managing the book with available collateral ${String(available)} (latest portfolio snapshot).`;
    }
    return 'I am managing the book from the latest portfolio snapshot.';
  }

  const latestPositions = [...state.toolExecutions]
    .reverse()
    .find((t) => t.toolName === 'get_positions' && t.result.success);
  if (latestPositions) {
    return 'I am managing the book from the latest positions snapshot.';
  }

  return 'I am managing the book with no fresh portfolio snapshot in this cycle.';
}

function buildTradeActionSummary(state: AgentState): string {
  const tradeAttempts = state.toolExecutions.filter((t) => t.toolName === 'perp_place_order');
  if (tradeAttempts.length === 0) {
    return 'I did not place a new perp order in this cycle.';
  }

  const successes = tradeAttempts.filter((t) => t.result.success);
  if (successes.length > 0) {
    return `I executed ${successes.length} perp order(s).`;
  }

  const lastError = (
    tradeAttempts[tradeAttempts.length - 1]?.result as { success: false; error: string } | undefined
  )?.error;
  return `I did not execute a new perp order. Last perp_place_order failed${lastError ? `: ${lastError}` : '.'}`;
}

function buildTradeRiskSummary(state: AgentState): string {
  const lastTrade = [...state.toolExecutions]
    .reverse()
    .find((t) => t.toolName === 'perp_place_order');
  if (lastTrade?.result.success) {
    return 'Execution risk is currently controlled, but book-level liquidation and volatility risk remain active.';
  }
  if (lastTrade && !lastTrade.result.success) {
    const err = (lastTrade.result as { success: false; error: string }).error;
    return `Primary risk is execution reliability until this blocker is resolved (${err}).`;
  }
  return 'Primary risk is position and collateral drift without fresh execution.';
}

function buildTradeNextActionSummary(state: AgentState): string {
  const lastTrade = [...state.toolExecutions]
    .reverse()
    .find((t) => t.toolName === 'perp_place_order');
  if (lastTrade?.result.success) {
    return 'I will monitor positions and open orders, then rebalance or de-risk automatically on the next cycle.';
  }
  if (lastTrade && !lastTrade.result.success) {
    return 'I will retry with validated inputs and current market/account state in the next autonomous cycle.';
  }
  return 'I will continue autonomous monitoring and execute the next valid trade action when constraints allow.';
}

function enforceTradeResponseContract(response: string, state: AgentState): string {
  const shouldEnforce =
    state.mode === 'trade' &&
    (isTradeExecutionIntent(state.goal) ||
      state.toolExecutions.some((execution) => TERMINAL_TRADE_TOOLS.has(execution.toolName)));
  if (!shouldEnforce) {
    return response;
  }

  const deterministicAction = `Action: ${buildTradeActionSummary(state)}`;
  const hasContractShape =
    /\bAction:\s*/i.test(response) &&
    /\bBook State:\s*/i.test(response) &&
    /\bRisk:\s*/i.test(response) &&
    /\bNext Action:\s*/i.test(response);
  if (hasContractShape) {
    return response
      .split('\n')
      .map((line) => (/^\s*Action:\s*/i.test(line) ? deterministicAction : line))
      .join('\n');
  }

  return [
    deterministicAction,
    `Book State: ${buildTradeBookState(state)}`,
    `Risk: ${buildTradeRiskSummary(state)}`,
    `Next Action: ${buildTradeNextActionSummary(state)}`,
  ].join('\n');
}

/**
 * Run the orchestrator for a goal.
 */
export async function runOrchestrator(
  goal: string,
  ctx: OrchestratorContext,
  options?: OrchestratorOptions
): Promise<OrchestratorResult> {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  if (isDebugEnabled()) {
    const cfg = (ctx.toolContext as { config?: { agent?: Record<string, unknown> } })?.config;
    const agent = cfg?.agent ?? {};
    debugLog('provider path', {
      provider: agent.provider,
      model: agent.model,
      executorProvider: agent.executorProvider,
      executorModel: agent.executorModel,
      openaiModel: agent.openaiModel,
      useExecutorModel: agent.useExecutorModel,
    });
  }

  const identityPromptForCheck = buildIdentityPrompt(ctx.identity);
  enforceIdentityMarker(ctx.identity, identityPromptForCheck);
  debugLog('identity marker present', { marker: ctx.identity.marker });

  // Phase 1: Mode Detection
  const modeResult = options?.forceMode
    ? { mode: options.forceMode, confidence: 1, signals: ['forced'] }
    : detectMode(goal);

  // Extract config from toolContext for mode configuration overrides
  const thufirConfig = ctx.toolContext?.config as import('../../core/config.js').ThufirConfig | undefined;
  const modeConfig = getModeConfig(modeResult.mode, thufirConfig);
  const maxIterations = options?.maxIterations ?? modeConfig.maxIterations;
  const canResumePlan = Boolean(
    options?.resumePlan && options?.initialPlan && options.initialPlan.goal === goal
  );
  const skipPlanning = options?.skipPlanning || canResumePlan;

  // Initialize state
  let state = createAgentState(goal, modeResult.mode, modeConfig, options);

  ctx.onUpdate?.(state);

  if (options?.resumePlan && options?.initialPlan) {
    if (!canResumePlan) {
      state = addWarning(state, 'Prior plan goal does not match current goal; starting fresh');
    } else {
      state = updatePlan(state, options.initialPlan, 'Resumed prior plan');
      ctx.onUpdate?.(state);
    }
  }

  // Phase 2: Memory Context (Memory-First Rule)
  const memoryParts: string[] = [];

  // 2a: Traditional memory system
  if (ctx.memorySystem) {
    try {
      const memoryContext = await ctx.memorySystem.getRelevantContext(goal);
      if (memoryContext) {
        memoryParts.push('## Session Memory\n' + memoryContext);
      }
    } catch (error) {
      state = addWarning(
        state,
        `Memory retrieval failed: ${error instanceof Error ? error.message : 'Unknown'}`
      );
    }
  }

  // 2b: QMD knowledge base (if enabled)
  const qmdContext = await retrieveQmdContext(goal, ctx);
  if (qmdContext) {
    memoryParts.push('## Knowledge Base\n' + qmdContext);
  }

  // 2c: Operational learning artifacts (incidents + playbooks)
  const incidentContext = formatRecentIncidentsForContext(goal, modeResult.mode);
  if (incidentContext) {
    memoryParts.push('## Recent Incidents\n' + incidentContext);
  }
  const playbookContext = formatPlaybooksForContext(goal);
  if (playbookContext) {
    memoryParts.push('## Playbooks\n' + playbookContext);
  }

  // Combine memory sources
  if (memoryParts.length > 0) {
    state = setMemoryContext(state, memoryParts.join('\n\n'));
    ctx.onUpdate?.(state);
  }

  if (state.mode === 'trade' && shouldPrefetchTradeHistory(goal)) {
    const availableTools = new Set(ctx.toolRegistry.listNames());
    const symbol = inferSymbolFromGoal(goal);
    const runPrefetch = async (toolName: string, input: Record<string, unknown>) => {
      try {
        const execution = await ctx.toolRegistry.execute(toolName, input, ctx.toolContext);
        state = addToolExecution(state, execution);
        if (!execution.result.success) {
          const failed = execution.result as { success: false; error: string };
          state = addWarning(state, `${toolName} prefetch failed: ${failed.error}`);
        }
      } catch (error) {
        state = addWarning(
          state,
          `${toolName} prefetch threw: ${error instanceof Error ? error.message : 'Unknown'}`
        );
      }
    };

    if (availableTools.has('perp_trade_journal_list')) {
      await runPrefetch('perp_trade_journal_list', {
        limit: 200,
        ...(symbol ? { symbol } : {}),
      });
    }
    if (availableTools.has('trade_review')) {
      await runPrefetch('trade_review', {
        limit: 200,
        ...(symbol ? { symbol } : {}),
      });
    }
    ctx.onUpdate?.(state);
  }

  // Phase 3: Planning (unless skipped)
  if (!skipPlanning) {
    try {
      const allowedTools = getAllowedTools(modeResult.mode);
      const planResult = await createPlan(
        ctx.llm,
        {
          goal,
          availableTools: allowedTools,
          memoryContext: state.memoryContext ?? undefined,
          assumptions: state.assumptions.map((a) => a.statement),
          hypotheses: state.hypotheses.map((h) => h.statement),
        },
        ctx.identity
      );

      state = updatePlan(state, planResult.plan, planResult.reasoning);
      state = enforceTradeTerminalContract(state, ctx, 'initial_plan');

      if (planResult.warnings.length > 0) {
        for (const warning of planResult.warnings) {
          state = addWarning(state, warning);
        }
      }

      ctx.onUpdate?.(state);
    } catch (error) {
      state = addError(
        state,
        `Planning failed: ${error instanceof Error ? error.message : 'Unknown'}`
      );
    }
  }

  // Phase 4: Execution Loop
  let reflectionState = createReflectionState();
  reflectionState = {
    ...reflectionState,
    hypotheses: state.hypotheses,
    assumptions: state.assumptions,
    confidence: state.confidence,
  };

  // Track fragility scan results for trades
  let tradeFragilityScan: QuickFragilityScan | null = null;
  let consecutiveNonTerminalTradeToolSteps = 0;

  const processToolExecution = async (
    step: PlanStep,
    execution: ToolExecution,
    options?: { allowRevision?: boolean }
  ): Promise<void> => {
    state = addToolExecution(state, execution);

    const stepBlockers = execution.result.success ? [] : detectBlockers(execution);

    if (!execution.result.success) {
      const failed = execution.result as { success: false; error: string };
      const primaryKind: AgentBlockerKind =
        (stepBlockers[0]?.kind as AgentBlockerKind | undefined) ?? 'unknown';
      recordAgentIncident({
        goal,
        mode: state.mode,
        toolName: execution.toolName,
        error: failed.error,
        blockerKind: primaryKind,
        details: {
          stepId: step.id,
          planId: state.plan?.id ?? null,
          detectedBlockers: stepBlockers.map((b) => ({
            kind: b.kind,
            summary: b.summary,
            evidence: b.evidence,
            suggestedNextSteps: b.suggestedNextSteps,
            playbookKey: b.playbookKey ?? null,
          })),
        },
      });

      for (const b of stepBlockers) {
        state = addWarning(state, `Detected blocker: ${b.kind} (${b.summary})`);
        if (state.plan && !state.plan.blockers.includes(b.summary)) {
          state = setPlan(state, {
            ...state.plan,
            blockers: [...state.plan.blockers, b.summary],
            updatedAt: new Date().toISOString(),
          });
        }

        if (b.playbookKey) {
          const existing = getPlaybook(b.playbookKey);
          if (!existing) {
            const seed = seedPlaybookForBlocker(b.kind);
            if (seed) {
              upsertPlaybook(seed);
            }
          }
        }
      }
    }

    if (execution.result.success) {
      state = setPlan(state, completeStep(state.plan!, step.id, execution.result));
    } else {
      const failedResult = execution.result as { success: false; error: string };
      if (state.plan && stepBlockers.length > 0) {
        const injected = injectRemediationAndRetry({
          plan: state.plan,
          failedStep: step,
          blockers: stepBlockers,
          toolRegistry: ctx.toolRegistry,
        });
        if (injected.injected) {
          state = setPlan(state, injected.updated);
          state = addWarning(
            state,
            `Injected ${injected.injectedCount} remediation step(s) after tool failure`
          );
        } else {
          state = setPlan(state, failStep(state.plan!, step.id, failedResult.error));
        }
      } else {
        state = setPlan(state, failStep(state.plan!, step.id, failedResult.error));
      }
    }

    const toolContext = toToolExecutionContext(execution);
    reflectionState = {
      ...reflectionState,
      hypotheses: state.hypotheses,
      assumptions: state.assumptions,
      confidence: state.confidence,
      toolExecutions: [...reflectionState.toolExecutions, toolContext],
    };

    try {
      const reflection = await reflect(ctx.llm, reflectionState, toolContext);
      state = applyReflectionToState(state, reflection);
      reflectionState = applyReflection(reflectionState, reflection, toolContext);

      if (
        options?.allowRevision !== false &&
        shouldReviseAfterReflection(reflection, execution) &&
        state.plan &&
        state.plan.revisionCount < 3
      ) {
        const revisionResult = await revisePlan(ctx.llm, {
          plan: state.plan,
          reason: 'tool_result_unexpected',
          context: reflection.revisionReason,
          toolResult: execution.result,
          triggerStepId: step.id,
        });

        state = setPlan(state, revisionResult.plan);
        state = enforceTradeTerminalContract(state, ctx, 'plan_revision');
        for (const change of revisionResult.changes) {
          state = addWarning(state, `Plan revised: ${change}`);
        }
      }
    } catch (error) {
      state = addWarning(
        state,
        `Reflection failed: ${error instanceof Error ? error.message : 'Unknown'}`
      );
    }

    ctx.onUpdate?.(state);
  };

  while (shouldContinue(state).continue && state.iteration < maxIterations) {
    state = incrementIteration(state);
    ctx.onUpdate?.(state);

    // Get next step from plan
    const readySteps = state.plan ? getReadySteps(state.plan) : [];
    const nextStep = readySteps[0] ?? null;

    if (!nextStep) {
      // No more steps - plan is complete or no plan
      if (state.plan && !state.plan.complete) {
        // Mark plan as complete
        state = setPlan(state, { ...state.plan, complete: true });
      }
      break;
    }

    if (state.mode === 'trade' && state.plan) {
      if (isTerminalTradeStep(nextStep)) {
        consecutiveNonTerminalTradeToolSteps = 0;
      } else if (nextStep.requiresTool) {
        consecutiveNonTerminalTradeToolSteps += 1;
        if (
          consecutiveNonTerminalTradeToolSteps > 3 &&
          !hasPendingTerminalTradeStep(state.plan)
        ) {
          const currentStepId = nextStep.id;
          const skipped = state.plan.steps.map((step) => {
            if (step.id === currentStepId) {
              return step;
            }
            if (step.status === 'pending' && !isTerminalTradeStep(step)) {
              return { ...step, status: 'skipped' as const };
            }
            return step;
          });
          state = setPlan(state, {
            ...state.plan,
            steps: skipped,
            updatedAt: new Date().toISOString(),
          });
          state = enforceTradeTerminalContract(
            state,
            ctx,
            'progress_guard_non_terminal_steps'
          );
          state = addWarning(
            state,
            'Progress guard skipped pending non-terminal steps and forced terminal trade action'
          );
          consecutiveNonTerminalTradeToolSteps = 0;
          ctx.onUpdate?.(state);
        }
      }
    }

    // Execute tool if step requires it
    if (nextStep.requiresTool && nextStep.toolName) {
      if (shouldSkipRedundantToolsList(state, nextStep)) {
        const skippedExecution: ToolExecution = {
          toolName: nextStep.toolName,
          input: nextStep.toolInput ?? {},
          result: {
            success: true,
            data: {
              skipped: true,
              reason: 'Redundant tools.list skipped: registry already available in orchestrator context.',
            },
          },
          timestamp: new Date().toISOString(),
          durationMs: 0,
          cached: true,
        };
        state = addToolExecution(state, skippedExecution);
        state = setPlan(state, completeStep(state.plan!, nextStep.id, skippedExecution.result));
        ctx.onUpdate?.(state);
        continue;
      }
      if (shouldSkipMutatingTradeToolForAnalysis(state, nextStep)) {
        const skippedExecution: ToolExecution = {
          toolName: nextStep.toolName,
          input: nextStep.toolInput ?? {},
          result: {
            success: true,
            data: {
              skipped: true,
              reason:
                'Mutating trade action skipped: request appears analytical and did not explicitly request execution.',
            },
          },
          timestamp: new Date().toISOString(),
          durationMs: 0,
          cached: true,
        };
        state = addToolExecution(state, skippedExecution);
        state = setPlan(state, completeStep(state.plan!, nextStep.id, skippedExecution.result));
        ctx.onUpdate?.(state);
        continue;
      }

      const readBatch = buildParallelReadBatch(readySteps, state, ctx);
      if (readBatch.length > 1) {
        const executions = await Promise.all(
          readBatch.map((step) => executeToolStep(step, state, ctx))
        );
        for (let index = 0; index < readBatch.length; index += 1) {
          await processToolExecution(readBatch[index]!, executions[index]!, { allowRevision: false });
        }
        if (state.plan?.complete) {
          break;
        }
        continue;
      }

      // Run fragility scan before trade tools
      const isTradeToolStep = nextStep.toolName === 'perp_place_order';
      if (isTradeToolStep && !tradeFragilityScan) {
        tradeFragilityScan = await runPreTradeFragilityScan(nextStep, ctx);
        if (tradeFragilityScan) {
          debugLog('pre-trade fragility scan', {
            marketId: tradeFragilityScan.marketId,
            fragilityScore: tradeFragilityScan.fragilityScore,
            riskSignals: tradeFragilityScan.riskSignals.length,
          });
        }
      }

      const execution = await executeToolStep(nextStep, state, ctx);
      await processToolExecution(nextStep, execution);
    } else {
      // Non-tool step - mark as complete
      state = setPlan(state, completeStep(state.plan!, nextStep.id));
      ctx.onUpdate?.(state);
    }

    // Check if plan is now complete
    if (state.plan?.complete) {
      break;
    }
  }

  // Phase 5: Synthesis
  const response = await synthesizeResponse(
    {
      goal,
      toolResults: state.toolExecutions,
      hypotheses: state.hypotheses,
      assumptions: state.assumptions,
      memoryContext: state.memoryContext,
      identity: ctx.identity,
      mode: state.mode,
    },
    ctx,
    options?.synthesisSystemPrompt
  );

  // Phase 6: Critic (if required)
  let criticResult = null;
  const tradeToolNames = new Set(['perp_place_order']);
  const shouldCritic =
    !options?.skipCritic &&
    (modeConfig.requireCritic ||
      shouldRunCritic({
        mode: state.mode,
        involvesTrade: state.toolExecutions.some((t) => tradeToolNames.has(t.toolName)),
        toolCalls: state.toolExecutions.map((t) => ({ name: t.toolName })),
      }));

  if (shouldCritic) {
    try {
      // Build fragility context for critic if we have a scan
      const fragilityContext: TradeFragilityContext | undefined = tradeFragilityScan
        ? {
            fragilityScore: tradeFragilityScan.fragilityScore,
            riskSignals: tradeFragilityScan.riskSignals,
            fragilityCards: tradeFragilityScan.fragilityCards,
            stressedAssumptions: tradeFragilityScan.stressedAssumptions,
            falsifiers: tradeFragilityScan.falsifiers,
            detectors: tradeFragilityScan.detectors,
          }
        : undefined;

      const criticContext: CriticContext = {
        goal,
        response,
        toolCalls: state.toolExecutions.map((t) => ({
          name: t.toolName,
          input: t.input,
          result: t.result,
          success: t.result.success,
        })),
        assumptions: state.assumptions.map((a) => a.statement),
        hypotheses: state.hypotheses.map((h) => h.statement),
        mode: state.mode,
        involvesTrade: state.toolExecutions.some((t) => tradeToolNames.has(t.toolName)),
        fragility: fragilityContext,
      };

      criticResult = await runCritic(ctx.llm, criticContext);

      // If critic provided a revised response, use it
      let finalResponse = criticResult.revisedResponse ?? response;
      if (!criticResult.approved && !criticResult.revisedResponse) {
        finalResponse = buildCriticFailureFallbackResponse(state, response);
      }
      finalResponse = enforceTradeResponseContract(finalResponse, state);
      state = completeState(state, finalResponse, criticResult);
    } catch (error) {
      state = addWarning(
        state,
        `Critic failed: ${error instanceof Error ? error.message : 'Unknown'}`
      );
      state = completeState(state, enforceTradeResponseContract(response, state));
    }
  } else {
    state = completeState(state, enforceTradeResponseContract(response, state));
  }

  ctx.onUpdate?.(state);

  debugLog('iterations used', { iterations: state.iteration });
  debugLog('tools called', {
    tools: state.toolExecutions.map((t) => t.toolName),
  });

  // Build result
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startTime;

  // Build fragility summary if we ran a scan
  const fragilitySummary = tradeFragilityScan
    ? {
        fragilityScore: tradeFragilityScan.fragilityScore,
        riskSignalCount: tradeFragilityScan.riskSignals.length,
        fragilityCardCount: tradeFragilityScan.fragilityCards.length,
        topRiskSignals: tradeFragilityScan.riskSignals.slice(0, 3),
        highFragility: tradeFragilityScan.fragilityScore >= 0.6,
      }
    : undefined;

  if (state.mode === 'trade' || state.toolExecutions.some((t) => tradeToolNames.has(t.toolName))) {
    try {
      const tradeAudit = extractTradeAudit(state);
      recordDecisionAudit({
        source: 'orchestrator',
        sessionId: state.sessionId,
        mode: state.mode,
        goal,
        marketId: tradeAudit.marketId,
        predictionId: tradeAudit.predictionId,
        tradeAction: tradeAudit.tradeAction,
        tradeOutcome: tradeAudit.tradeOutcome,
        tradeAmount: tradeAudit.tradeAmount,
        confidence: state.confidence,
        edge: null,
        criticApproved: criticResult?.approved ?? null,
        criticIssues: criticResult?.issues?.map((issue) => ({
          type: issue.type,
          severity: issue.severity,
          description: issue.description,
        })),
        fragilityScore: tradeFragilityScan?.fragilityScore ?? null,
        toolCalls: state.toolExecutions.length,
        iterations: state.iteration,
        toolTrace: state.toolExecutions.map((t) => ({
          toolName: t.toolName,
          input: t.input,
          success: t.result.success,
        })),
        planTrace: state.plan,
      });
    } catch (error) {
      debugLog('decision audit failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  return {
    state,
    response: state.response!,
    success: !state.errors.some((e) => e.includes('fatal')),
    summary: {
      mode: state.mode,
      iterations: state.iteration,
      toolCalls: state.toolExecutions.length,
      planRevisions: state.plan?.revisionCount ?? 0,
      criticApproved: criticResult?.approved ?? null,
      confidence: state.confidence,
      fragility: fragilitySummary,
    },
    metadata: {
      startedAt,
      completedAt,
      durationMs,
    },
  };
}

function extractTradeAudit(state: AgentState): {
  marketId?: string;
  predictionId?: string;
  tradeAction?: string;
  tradeOutcome?: string;
  tradeAmount?: number;
} {
  const trade = state.toolExecutions.find(
    (t) => t.toolName === 'perp_place_order'
  );
  if (!trade) {
    return {};
  }

  const input = trade.input as Record<string, unknown> | undefined;
  const marketId =
    (input?.marketId as string | undefined) ??
    (input?.market_id as string | undefined) ??
    (input?.conditionId as string | undefined);
  const tradeOutcome = (input?.outcome as string | undefined)?.toUpperCase();
  const tradeAmount = input?.amount !== undefined ? Number(input?.amount) : undefined;

  let predictionId: string | undefined;
  if (trade.result.success) {
    const data = (trade.result as { success: true; data: Record<string, unknown> }).data;
    predictionId = data?.prediction_id ? String(data.prediction_id) : undefined;
  }

  return {
    marketId,
    predictionId,
    tradeAction: 'buy',
    tradeOutcome,
    tradeAmount,
  };
}

/**
 * Run pre-trade fragility scan if market client is available.
 */
async function runPreTradeFragilityScan(
  step: PlanStep,
  ctx: OrchestratorContext
): Promise<QuickFragilityScan | null> {
  // Extract market ID from tool input
  const input = step.toolInput as Record<string, unknown> | undefined;
  const marketId = input?.marketId ?? input?.market_id ?? input?.conditionId;

  if (!marketId || typeof marketId !== 'string') {
    debugLog('fragility scan skipped: no market ID in tool input');
    return null;
  }

  // Check if market client is available in tool context
  const toolCtx = ctx.toolContext as {
    marketClient?: { getMarket: (id: string) => Promise<unknown> };
    config?: { agent?: { enablePreTradeFragility?: boolean } };
  };

  // Check if pre-trade fragility is enabled (default: true for trade mode)
  const enablePreTradeFragility = toolCtx?.config?.agent?.enablePreTradeFragility !== false;
  if (!enablePreTradeFragility) {
    debugLog('fragility scan skipped: disabled in config');
    return null;
  }

  if (!toolCtx?.marketClient) {
    debugLog('fragility scan skipped: no market client available');
    return null;
  }

  try {
    // Dynamic import to avoid circular dependency
    const { runQuickFragilityScan } = await import('../../mentat/scan.js');

    const scan = await runQuickFragilityScan({
      marketId,
      marketClient: toolCtx.marketClient as Parameters<typeof runQuickFragilityScan>[0]['marketClient'],
      llm: ctx.llm,
      intelLimit: 10,
    });

    return scan;
  } catch (error) {
    debugLog('fragility scan failed', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return null;
  }
}

/**
 * Detect whether tool input contains placeholder values that need LLM resolution.
 * GPT often generates plans with placeholder strings like "to_be_set_based_on_step_9".
 */
function hasPlaceholderInputs(input: Record<string, unknown>): boolean {
  const PLACEHOLDER_PATTERNS = [
    /to_be_/i,
    /to_be_determined/i,
    /to_be_set/i,
    /based_on_step/i,
    /TBD/i,
    /placeholder/i,
    /\{.*step.*\}/i,
    /FILL_IN/i,
  ];
  for (const value of Object.values(input)) {
    if (typeof value === 'string') {
      for (const pattern of PLACEHOLDER_PATTERNS) {
        if (pattern.test(value)) return true;
      }
    }
  }
  return false;
}

const VALID_EXIT_MODES = new Set([
  'thesis_invalidation',
  'take_profit',
  'time_exit',
  'risk_reduction',
  'manual',
  'unknown',
]);
const VALID_MARKET_REGIMES = new Set([
  'trending',
  'choppy',
  'high_vol_expansion',
  'low_vol_compression',
]);
const VALID_ENTRY_TRIGGERS = new Set(['news', 'technical', 'hybrid']);

function mapExitModeAlias(raw: string): string {
  if (
    raw.includes('thesis') ||
    raw.includes('invalid') ||
    raw.includes('stop') ||
    raw.includes('cut')
  ) {
    return 'thesis_invalidation';
  }
  if (raw === 'tp' || raw.includes('profit')) {
    return 'take_profit';
  }
  if (raw.includes('time')) {
    return 'time_exit';
  }
  if (
    raw.includes('liquid') ||
    raw.includes('probe') ||
    raw.includes('de-risk') ||
    raw.includes('risk') ||
    raw.includes('emergency')
  ) {
    return 'risk_reduction';
  }
  if (raw.includes('manual') || raw.includes('discretion')) {
    return 'manual';
  }
  if (raw.includes('unknown')) {
    return 'unknown';
  }
  return 'risk_reduction';
}

function normalizeAliasToken(value: string): string {
  return value.toLowerCase().trim().replace(/[\s-]+/g, '_');
}

function mapMarketRegimeAlias(raw: string): string | null {
  if (VALID_MARKET_REGIMES.has(raw)) return raw;
  if (raw === 'balanced_up' || raw === 'uptrend' || raw === 'trend_up') return 'trending';
  if (raw === 'balanced_down' || raw === 'downtrend' || raw === 'trend_down') return 'trending';
  if (raw === 'range' || raw === 'ranging' || raw === 'sideways' || raw === 'range_bound') return 'choppy';
  if (raw === 'high_vol' || raw === 'vol_expansion' || raw === 'high_volatility') return 'high_vol_expansion';
  if (raw === 'low_vol' || raw === 'vol_compression' || raw === 'low_volatility') return 'low_vol_compression';
  return null;
}

function mapEntryTriggerAlias(raw: string): string | null {
  if (VALID_ENTRY_TRIGGERS.has(raw)) return raw;
  if (raw.includes('imbalance') || raw.includes('orderflow') || raw.includes('breakout') || raw.includes('momentum')) {
    return 'technical';
  }
  if (raw.includes('news') || raw.includes('headline') || raw.includes('catalyst')) {
    return 'news';
  }
  if (raw.includes('hybrid') || (raw.includes('news') && raw.includes('technical'))) {
    return 'hybrid';
  }
  return null;
}

export function normalizePerpPlaceOrderInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  const normalizeEnum = (
    raw: unknown,
    allowed: string[],
    aliasMap?: Record<string, string>
  ): string | undefined => {
    if (typeof raw !== 'string') return undefined;
    const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const mapped = aliasMap?.[key] ?? key;
    return allowed.includes(mapped) ? mapped : undefined;
  };

  if (typeof normalized.side === 'string') {
    normalized.side = normalized.side.toLowerCase().trim();
  }
  if (typeof normalized.order_type === 'string') {
    normalized.order_type = normalized.order_type.toLowerCase().trim();
  }
  if (typeof normalized.market_regime === 'string') {
    const canonical = mapMarketRegimeAlias(normalizeAliasToken(normalized.market_regime));
    if (canonical) {
      normalized.market_regime = canonical;
    } else {
      delete normalized.market_regime;
    }
  }
  if (typeof normalized.entry_trigger === 'string') {
    const canonical = mapEntryTriggerAlias(normalizeAliasToken(normalized.entry_trigger));
    if (canonical) {
      normalized.entry_trigger = canonical;
    } else {
      delete normalized.entry_trigger;
    }
  }

  // Coerce numeric fields that often arrive as strings from planner/revision LLM output.
  if (typeof normalized.size === 'string') {
    const parsed = Number(normalized.size);
    if (!Number.isNaN(parsed)) {
      normalized.size = parsed;
    }
  }
  if (typeof normalized.price === 'string') {
    const parsed = Number(normalized.price);
    if (!Number.isNaN(parsed)) {
      normalized.price = parsed;
    }
  }
  if (typeof normalized.leverage === 'string') {
    const parsed = Number(normalized.leverage);
    if (!Number.isNaN(parsed)) {
      normalized.leverage = parsed;
    }
  }
  if (typeof normalized.reduce_only === 'string') {
    const value = normalized.reduce_only.toLowerCase().trim();
    if (value === 'true') normalized.reduce_only = true;
    if (value === 'false') normalized.reduce_only = false;
  }
  if (typeof normalized.thesis_invalidation_hit === 'string') {
    const value = normalized.thesis_invalidation_hit.toLowerCase().trim();
    if (value === 'true') normalized.thesis_invalidation_hit = true;
    if (value === 'false') normalized.thesis_invalidation_hit = false;
  }

  if (typeof normalized.thesis_invalidation_hit === 'string') {
    const value = normalized.thesis_invalidation_hit.trim().toLowerCase();
    if (value === 'true') normalized.thesis_invalidation_hit = true;
    if (value === 'false') normalized.thesis_invalidation_hit = false;
  }

  const normalizedExitMode = normalizeEnum(
    normalized.exit_mode,
    ['thesis_invalidation', 'take_profit', 'time_exit', 'risk_reduction', 'manual', 'unknown'],
    {
      invalidation: 'thesis_invalidation',
      thesis_invalidated: 'thesis_invalidation',
      stop_loss: 'thesis_invalidation',
      tp: 'take_profit',
      takeprofit: 'take_profit',
      time_stop: 'time_exit',
      timeout: 'time_exit',
      liquidity_probe: 'risk_reduction',
      emergency_override: 'risk_reduction',
      liquidity: 'risk_reduction',
      de_risk: 'risk_reduction',
      derisk: 'risk_reduction',
      manual_close: 'manual',
    }
  );
  if (normalizedExitMode) {
    normalized.exit_mode = normalizedExitMode;
  } else {
    delete normalized.exit_mode;
  }

  const normalizedArchetype = normalizeEnum(
    normalized.trade_archetype,
    ['scalp', 'intraday', 'swing'],
    { day_trade: 'intraday', daytrading: 'intraday' }
  );
  if (normalizedArchetype) {
    normalized.trade_archetype = normalizedArchetype;
  } else if (!Boolean(normalized.reduce_only)) {
    normalized.trade_archetype = 'intraday';
  } else {
    delete normalized.trade_archetype;
  }

  // Ensure a positive minimal size so schema validation doesn't fail before execution.
  const numericSize =
    typeof normalized.size === 'number'
      ? normalized.size
      : typeof normalized.size === 'string'
        ? Number(normalized.size)
        : NaN;
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    normalized.size = 0.001;
  }

  // LLM-generated limit prices frequently fail exchange tick-size constraints.
  // Default to market for autonomous execution reliability unless a higher layer overrides this.
  normalized.order_type = 'market';
  delete normalized.price;

  const reduceOnly = normalized.reduce_only === true;
  if (typeof normalized.exit_mode === 'string') {
    const candidate = normalized.exit_mode.toLowerCase().trim();
    normalized.exit_mode = VALID_EXIT_MODES.has(candidate) ? candidate : mapExitModeAlias(candidate);
  } else if (normalized.exit_mode != null) {
    delete normalized.exit_mode;
  }
  if (reduceOnly && normalized.exit_mode === 'thesis_invalidation') {
    normalized.thesis_invalidation_hit = true;
  }

  if (normalized.side !== 'buy' && normalized.side !== 'sell') {
    normalized.side = 'buy';
  }

  return normalized;
}

function buildCriticFailureFallbackResponse(state: AgentState, originalResponse: string): string {
  const tradeAttempts = state.toolExecutions.filter((t) => t.toolName === 'perp_place_order');
  if (tradeAttempts.length === 0) {
    return originalResponse;
  }

  const successfulTrades = tradeAttempts.filter((t) => t.result.success);
  const failedTrades = tradeAttempts.filter((t) => !t.result.success);

  if (successfulTrades.length > 0) {
    const lines: string[] = [];
    lines.push(`Action: Executed ${successfulTrades.length} perp order(s).`);
    if (failedTrades.length > 0) {
      const lastErr = (failedTrades[failedTrades.length - 1]?.result as { error?: string } | undefined)?.error;
      lines.push(
        `Partial failures: ${failedTrades.length} additional attempt(s) failed${lastErr ? ` (last error: ${lastErr})` : ''}.`
      );
      lines.push('Failed attempts detail:');
      for (const attempt of failedTrades.slice(0, 3)) {
        const input = (attempt.input ?? {}) as Record<string, unknown>;
        const symbol = typeof input.symbol === 'string' ? input.symbol : '?';
        const side = typeof input.side === 'string' ? input.side : '?';
        const size = Number(input.size);
        const reduceOnly = Boolean(input.reduce_only ?? false);
        const err = ((attempt.result as { error?: string } | undefined)?.error ?? 'unknown error').trim();
        lines.push(
          `- symbol=${symbol} side=${side} size=${Number.isFinite(size) ? size : '?'} reduce_only=${reduceOnly}: ${err}`
        );
      }
    }
    return lines.join('\n');
  }

  const lastError = (failedTrades[failedTrades.length - 1]?.result as { error?: string } | undefined)?.error;
  const toolList = state.toolExecutions
    .map((t) => `${t.toolName}[${t.result.success ? 'ok' : 'err'}]`)
    .join(', ');
  return [
    'Action: No trade was executed.',
    `perp_place_order failed ${failedTrades.length} time(s)${lastError ? `; last error: ${lastError}` : '.'}`,
    `Tools run: ${toolList}`,
  ].join('\n');
}

/**
 * Build context from completed plan steps for dynamic input resolution.
 */
function buildCompletedStepContext(state: AgentState): string {
  if (!state.plan) return '';
  const completed = state.plan.steps.filter((s) => s.status === 'complete' && s.result);
  if (completed.length === 0) return '';

  const lines: string[] = ['Previously completed steps and their results:'];
  for (const step of completed) {
    lines.push(`\n### Step ${step.id}: ${step.description}`);
    if (step.toolName) lines.push(`Tool: ${step.toolName}`);
    const resultData = (step.result as { success?: boolean; data?: unknown })?.data;
    if (resultData) {
      const json = JSON.stringify(resultData, null, 2);
      // Truncate large results
      lines.push(`Result: ${json.length > 2000 ? json.slice(0, 2000) + '...' : json}`);
    }
  }
  return lines.join('\n');
}

function buildPerpPlanContext(state: AgentState, step: PlanStep): Record<string, unknown> | null {
  if (!state.plan) return null;
  const pendingStepIds = state.plan.steps
    .filter((candidate) => candidate.status === 'pending')
    .map((candidate) => candidate.id)
    .slice(0, 5);

  return {
    plan_id: state.plan.id,
    plan_goal: state.plan.goal,
    plan_revision_count: state.plan.revisionCount,
    plan_created_at: state.plan.createdAt,
    plan_updated_at: state.plan.updatedAt,
    current_step_id: step.id,
    current_step_description: step.description,
    pending_step_ids: pendingStepIds,
    iteration: state.iteration,
    mode: state.mode,
  };
}

/**
 * Ask the LLM to resolve concrete tool inputs based on completed step results.
 */
async function resolveToolInputs(
  step: PlanStep,
  state: AgentState,
  ctx: OrchestratorContext
): Promise<Record<string, unknown>> {
  const completedContext = buildCompletedStepContext(state);

  // Try to get schema info for the LLM prompt (best-effort)
  let schemaHint = `Tool: ${step.toolName}`;
  try {
    const schemas = ctx.toolRegistry.getLlmSchemas?.();
    const match = schemas?.find((s: { name: string }) => s.name === step.toolName);
    if (match) {
      schemaHint = `Tool "${step.toolName}" accepts these parameters (JSON schema): ${JSON.stringify(match.input_schema)}`;
    }
  } catch {
    // Ignore schema lookup failures
  }

  const prompt = `You are resolving concrete parameters for a tool call in an execution plan.

## Current Step
ID: ${step.id}
Description: ${step.description}
Tool: ${step.toolName}
Original (placeholder) input: ${JSON.stringify(step.toolInput)}

## ${schemaHint}

## ${completedContext}

## Plan Goal
${state.plan?.goal ?? state.goal}

Based on the completed step results above, provide the CONCRETE values for this tool call.
Respond with ONLY a JSON object containing the resolved parameters. No explanation, just JSON.
For perp_place_order: "side" must be "buy" or "sell", "size" must be > 0, "price" must be a number.
To close a short position, use side="buy". To close a long, use side="sell".`;

  try {
    const response = await ctx.llm.complete(
      [
        { role: 'system', content: 'You resolve tool call parameters. Respond with ONLY valid JSON.' },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.1 }
    );

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      debugLog('resolveToolInputs: no JSON in response');
      return step.toolInput as Record<string, unknown>;
    }

    const resolved = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    debugLog('resolveToolInputs: resolved', { original: step.toolInput, resolved });
    return resolved;
  } catch (error) {
    debugLog('resolveToolInputs: failed', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return (step.toolInput ?? {}) as Record<string, unknown>;
  }
}

/**
 * Execute a tool step with confirmation if needed.
 */
async function executeToolStep(
  step: PlanStep,
  state: AgentState,
  ctx: OrchestratorContext
): Promise<ToolExecution> {
  const toolName = step.toolName!;
  let input = (step.toolInput ?? {}) as Record<string, unknown>;

  // Dynamic input resolution: if toolInput has placeholder values, ask LLM to fill them in
  // based on completed step results.
  if (hasPlaceholderInputs(input)) {
    debugLog('placeholder inputs detected, resolving dynamically', { toolName, input });
    input = await resolveToolInputs(step, state, ctx);
    // Update the step's toolInput so the plan record reflects the resolved values
    (step as any).toolInput = input;
  }

  // Guardrail: several perp tools require a symbol, but the planner can omit it.
  // Default to the first configured symbol (or BTC) instead of calling tools with undefined inputs.
  const needsSymbol = new Set([
    'perp_market_get',
    'perp_analyze',
    'perp_place_order',
  ]);
  const symbolOptionalButUseful = new Set([
    'perp_open_orders',
    'perp_positions',
  ]);

  const toolCtx = ctx.toolContext as { config?: { hyperliquid?: { symbols?: string[] } } } | undefined;
  const defaultSymbol =
    toolCtx?.config?.hyperliquid?.symbols?.[0] ??
    (process.env.HYPERLIQUID_SYMBOLS ? process.env.HYPERLIQUID_SYMBOLS.split(',')[0] : undefined) ??
    'BTC';

  if (needsSymbol.has(toolName)) {
    const obj = input as Record<string, unknown>;
    const sym = typeof obj.symbol === 'string' ? obj.symbol.trim() : '';
    if (!sym) {
      (obj as any).symbol = defaultSymbol;
    }
  } else if (symbolOptionalButUseful.has(toolName)) {
    const obj = input as Record<string, unknown>;
    const sym = typeof obj.symbol === 'string' ? obj.symbol.trim() : '';
    if (!sym) {
      (obj as any).symbol = defaultSymbol;
    }
  }

  if (toolName === 'perp_place_order') {
    const planContext = buildPerpPlanContext(state, step);
    if (planContext) {
      (input as Record<string, unknown>).plan_context = planContext;
    }
    input = normalizePerpPlaceOrderInput(input as Record<string, unknown>);
  }

  // Check if tool requires confirmation
  const toolDef = ctx.toolRegistry.get?.(toolName);
  if (toolDef?.requiresConfirmation && ctx.onConfirmation) {
    const confirmed = await ctx.onConfirmation(
      `Execute ${toolName}?`,
      toolName,
      input
    );

    if (!confirmed) {
      return {
        toolName,
        input,
        result: { success: false, error: 'User declined' },
        timestamp: new Date().toISOString(),
        durationMs: 0,
        cached: false,
      };
    }
  }

  // Execute the tool
  const execution = await ctx.toolRegistry.execute(toolName, input, ctx.toolContext);
  debugLog('tool execution', {
    tool: toolName,
    success: execution.result.success,
    durationMs: execution.durationMs,
    cached: execution.cached,
  });
  return execution;
}

/**
 * Synthesize the final response from tool results and state.
 */
async function synthesizeResponse(
  request: SynthesisRequest,
  ctx: OrchestratorContext,
  systemPromptOverride?: string
): Promise<string> {
  const sections: string[] = [];

  // Build context section
  sections.push(`## Goal\n${request.goal}`);

  if (request.memoryContext) {
    sections.push(`## Relevant Context\n${request.memoryContext}`);
  }

  if (request.toolResults.length > 0) {
    const toolSection = request.toolResults
      .map((t) => {
        const status = t.result.success ? 'SUCCESS' : 'FAILED';
        let data: string;
        if (t.result.success) {
          data = JSON.stringify(t.result.data, null, 2);
        } else {
          const failedResult = t.result as { success: false; error: string };
          data = failedResult.error;
        }
        return `### ${t.toolName} [${status}]\n${data}`;
      })
      .join('\n\n');
    sections.push(`## Tool Results\n${toolSection}`);
  }

  if (request.hypotheses.length > 0) {
    const hypoSection = request.hypotheses
      .map((h) => `- [${h.confidence}] ${h.statement}`)
      .join('\n');
    sections.push(`## Current Hypotheses\n${hypoSection}`);
  }

  if (request.assumptions.length > 0) {
    const assumeSection = request.assumptions
      .map((a) => `- [${a.validated ? 'validated' : 'unvalidated'}] ${a.statement}`)
      .join('\n');
    sections.push(`## Assumptions\n${assumeSection}`);
  }

  sections.push('\nSynthesize a response to the user based on the above.');

  const identityPrompt = resolveIdentityPrompt(request.identity, ctx);
  // Merge identity and synthesis prompts into one system message (identity FIRST)
  // This ensures the LLM client extracts identity for the instructions field
  const baseSystemPrompt = systemPromptOverride ?? SYNTHESIS_SYSTEM_PROMPT;
  const systemContent = identityPrompt
    ? `${identityPrompt}\n\n---\n\n${baseSystemPrompt}`
    : baseSystemPrompt;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: sections.join('\n\n') },
  ];

  // Adjust temperature based on mode
  const temperature = request.mode === 'trade' ? 0.3 : 0.5;

  const response = await ctx.llm.complete(messages, { temperature });
  return response.content;
}

/**
 * Create an orchestrator instance with bound context.
 */
export function createOrchestrator(ctx: OrchestratorContext) {
  return {
    run: (goal: string, options?: OrchestratorOptions) =>
      runOrchestrator(goal, ctx, options),
    ctx,
  };
}

// Re-export types
export type {
  AgentState,
  OrchestratorContext,
  OrchestratorResult,
  OrchestratorOptions,
} from './types.js';
