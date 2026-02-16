/**
 * Agent Planner
 *
 * Creates and revises plans for achieving goals.
 */

import { randomUUID } from 'node:crypto';

import type { LlmClient, ChatMessage } from '../../core/llm.js';
import type { AgentIdentity } from '../identity/types.js';
import type {
  AgentPlan,
  PlanStep,
  PlanningContext,
  PlanCreationResult,
  PlanRevisionRequest,
  PlanRevisionResult,
} from './types.js';

/**
 * System prompt for the planner.
 */
const PLANNER_SYSTEM_PROMPT = `You are a planning agent for a mentat-style perp market analyst.

Your job is to create execution plans that achieve the user's goal.

## Planning Rules

1. **Tool-First**: If the goal requires external information (prices, news, data), you MUST include tool calls.
2. **Decompose**: Break complex goals into clear, sequential steps.
3. **Be Specific**: Each step should have a clear action and expected outcome.
4. **Consider Dependencies**: Note when steps depend on each other.
5. **Track Assumptions**: Identify assumptions that could invalidate the plan.
6. **Concrete Inputs Only**: toolInput values MUST be concrete, valid values — never placeholders like "to_be_determined" or "based_on_step_X". If you don't know the exact value yet (e.g. price depends on earlier analysis), use your best estimate or leave the field out. The orchestrator will resolve missing values at execution time.
7. **Autonomous Execution**: You are an autonomous agent. Do NOT create steps that ask the user for input, confirmation, or preferences. Make decisions based on available data.
8. **Trade Terminal Contract**: If \`perp_place_order\` is in available tools and the goal implies trading, your plan MUST end with either:
   - a concrete trade action step using \`perp_place_order\` or \`perp_cancel_order\`, or
   - a final non-tool step whose description starts with \`NO_TRADE_DECISION:\` and cites specific tool evidence.
   Keep pre-trade analysis to at most 3 tool steps before the terminal step.

## Response Format

Respond with a JSON object:
{
  "steps": [
    {
      "id": "1",
      "description": "What this step does",
      "requiresTool": true,
      "toolName": "tool_name_here",
      "toolInput": { "param": "value" },
      "dependsOn": []
    }
  ],
  "confidence": 0.8,
  "blockers": [],
  "reasoning": "Why this plan makes sense",
  "warnings": ["Any concerns or caveats"]
}

Available tools: {TOOLS}`;

/**
 * Create a plan for achieving a goal.
 */
export async function createPlan(
  llm: LlmClient,
  context: PlanningContext,
  identity?: AgentIdentity
): Promise<PlanCreationResult> {
  const systemPrompt = PLANNER_SYSTEM_PROMPT.replace(
    '{TOOLS}',
    context.availableTools.join(', ')
  );

  const userPrompt = buildPlanningPrompt(context);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Add identity context if available
  if (identity) {
    messages.push({
      role: 'system',
      content: `You are planning for ${identity.name}, a ${identity.role}. Apply these traits: ${identity.traits.join(', ')}.`,
    });
  }

  messages.push({ role: 'user', content: userPrompt });

  const response = await llm.complete(messages, { temperature: 0.3 });
  const parsed = parseplanResponse(response.content, context.goal, context.availableTools);

  return parsed;
}

/**
 * Build the user prompt for planning.
 */
function buildPlanningPrompt(context: PlanningContext): string {
  const sections: string[] = [];

  sections.push(`## Goal\n${context.goal}`);

  if (context.memoryContext) {
    sections.push(`## Context\n${context.memoryContext}`);
  }

  if (context.assumptions && context.assumptions.length > 0) {
    sections.push(`## Current Assumptions\n${context.assumptions.map((a) => `- ${a}`).join('\n')}`);
  }

  if (context.hypotheses && context.hypotheses.length > 0) {
    sections.push(`## Current Hypotheses\n${context.hypotheses.map((h) => `- ${h}`).join('\n')}`);
  }

  const hasTradeExecutor = context.availableTools.includes('perp_place_order');
  if (hasTradeExecutor) {
    sections.push(
      [
        '## Autonomous Trading Contract',
        '- This is autonomous execution: do not ask for confirmation.',
        '- Include a terminal trade step (`perp_place_order` or `perp_cancel_order`) unless evidence clearly supports no trade.',
        '- If no trade is justified, include final non-tool step starting with `NO_TRADE_DECISION:` and cite concrete tool evidence.',
        '- Use at most 3 pre-trade analysis tool steps before the terminal decision/action.',
      ].join('\n')
    );
  }

  sections.push('\nCreate a plan to achieve this goal.');

  return sections.join('\n\n');
}

/**
 * Parse the LLM response into a plan.
 */
function parseplanResponse(
  content: string,
  goal: string,
  availableTools: string[]
): PlanCreationResult {
  const now = new Date().toISOString();

  try {
    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      steps?: Array<{
        id?: string;
        description?: string;
        requiresTool?: boolean;
        toolName?: string;
        toolInput?: Record<string, unknown>;
        dependsOn?: string[];
      }>;
      confidence?: number;
      blockers?: string[];
      reasoning?: string;
      warnings?: string[];
    };

    const steps: PlanStep[] = (parsed.steps ?? []).map((step, index) => ({
      id: step.id ?? String(index + 1),
      description: step.description ?? 'Unknown step',
      requiresTool: step.requiresTool ?? false,
      toolName: step.toolName,
      toolInput: step.toolInput,
      status: 'pending',
      dependsOn: step.dependsOn,
    }));

    const plan: AgentPlan = {
      id: randomUUID(),
      goal,
      steps,
      complete: false,
      // Planner-generated blockers are hypothetical risks, not runtime failures.
      // Only include them if the plan has zero tool steps (truly blocked).
      blockers: steps.some((s) => s.requiresTool) ? [] : (parsed.blockers ?? []),
      confidence: parsed.confidence ?? 0.5,
      createdAt: now,
      updatedAt: now,
      revisionCount: 0,
    };

    return {
      plan,
      reasoning: parsed.reasoning ?? 'No reasoning provided',
      warnings: parsed.warnings ?? [],
    };
  } catch (error) {
    const fallbackSteps = buildFallbackSteps(goal, availableTools);
    if (fallbackSteps.length > 0) {
      const plan: AgentPlan = {
        id: randomUUID(),
        goal,
        steps: fallbackSteps,
        complete: false,
        blockers: [],
        confidence: 0.45,
        createdAt: now,
        updatedAt: now,
        revisionCount: 0,
      };

      return {
        plan,
        reasoning: 'Plan parsing failed, using fallback tool step',
        warnings: [`Parse error: ${error instanceof Error ? error.message : 'Unknown'}`],
      };
    }

    // Return a minimal plan on parse failure
    const plan: AgentPlan = {
      id: randomUUID(),
      goal,
      steps: [
        {
          id: '1',
          description: 'Respond to the user based on available context',
          requiresTool: false,
          status: 'pending',
        },
      ],
      complete: false,
      blockers: ['Failed to parse plan from LLM response'],
      confidence: 0.3,
      createdAt: now,
      updatedAt: now,
      revisionCount: 0,
    };

    return {
      plan,
      reasoning: 'Plan parsing failed, using fallback',
      warnings: [`Parse error: ${error instanceof Error ? error.message : 'Unknown'}`],
    };
  }
}

function buildFallbackSteps(goal: string, availableTools: string[]): PlanStep[] {
  const toolSet = new Set(availableTools);
  const lower = goal.toLowerCase();

  const hasTool = (name: string) => toolSet.has(name);
  const firstAvailable = (names: string[]) => names.find((name) => hasTool(name));
  const steps: PlanStep[] = [];
  let stepId = 1;

  if (/(portfolio|positions?|balance|holdings?)/i.test(lower)) {
    const toolName = firstAvailable(['get_portfolio']);
    if (toolName) {
      steps.push({
        id: String(stepId++),
        description: 'Fetch current portfolio summary',
        requiresTool: true,
        toolName,
        toolInput: {},
        status: 'pending',
      });
    }
  }

  if (/(wallet|address|keystore)/i.test(lower)) {
    const toolName = firstAvailable(['get_wallet_info']);
    if (toolName) {
      steps.push({
        id: String(stepId++),
        description: 'Fetch wallet info',
        requiresTool: true,
        toolName,
        toolInput: {},
        status: 'pending',
      });
    }
  }

  if (/(news|intel|recent updates?)/i.test(lower)) {
    const toolName = firstAvailable(['intel_search', 'intel.search']);
    if (toolName) {
      const query = sanitizeQuery(goal);
      steps.push({
        id: String(stepId++),
        description: `Search intel for "${query}"`,
        requiresTool: true,
        toolName,
        toolInput: { query },
        status: 'pending',
      });
    }
  }

  if (/(market|search|find|symbol)/i.test(lower)) {
    const toolName = firstAvailable(['perp_market_list']);
    if (toolName) {
      steps.push({
        id: String(stepId++),
        description: 'List available perp markets to identify symbols',
        requiresTool: true,
        toolName,
        toolInput: { limit: 50 },
        status: 'pending',
      });
    }
  }

  return steps;
}

function sanitizeQuery(goal: string): string {
  const cleaned = goal
    .replace(/\b(find|search|market|markets|about|for|on|show|me|a|an|the|please)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : goal.trim();
}

/**
 * Revise an existing plan based on new information.
 */
export async function revisePlan(
  llm: LlmClient,
  request: PlanRevisionRequest
): Promise<PlanRevisionResult> {
  const systemPrompt = `You are revising an existing plan based on new information.

The plan needs revision because: ${request.reason}

Current plan:
${JSON.stringify(request.plan.steps, null, 2)}

${request.context ? `Additional context: ${request.context}` : ''}
${request.toolResult ? `Tool result that triggered revision: ${JSON.stringify(request.toolResult)}` : ''}

Respond with a JSON object:
{
  "steps": [/* updated steps */],
  "confidence": 0.7,
  "changes": ["list of changes made"]
}`;

  const response = await llm.complete(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Please revise the plan.' },
    ],
    { temperature: 0.3 }
  );

  const now = new Date().toISOString();

  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      steps?: Array<{
        id?: string;
        description?: string;
        requiresTool?: boolean;
        toolName?: string;
        toolInput?: Record<string, unknown>;
        dependsOn?: string[];
        status?: string;
      }>;
      confidence?: number;
      changes?: string[];
    };

    const previousById = new Map(request.plan.steps.map((step) => [step.id, step] as const));
    const steps: PlanStep[] = (parsed.steps ?? request.plan.steps).map((step, index) => {
      const id = step.id ?? String(index + 1);
      const previous = previousById.get(id);
      const status = (step.status as PlanStep['status']) ?? previous?.status ?? 'pending';

      const revised: PlanStep = {
        id,
        description: step.description ?? previous?.description ?? 'Unknown step',
        requiresTool: step.requiresTool ?? previous?.requiresTool ?? false,
        toolName: step.toolName ?? previous?.toolName,
        toolInput: step.toolInput ?? previous?.toolInput,
        status,
        dependsOn: step.dependsOn ?? previous?.dependsOn,
      };

      if (status === 'complete' && previous?.result !== undefined && step.status === undefined) {
        revised.result = previous.result;
      }
      if (status === 'failed' && previous?.error && step.status === undefined) {
        revised.error = previous.error;
      }
      return revised;
    });

    const revisedPlan: AgentPlan = {
      ...request.plan,
      steps,
      confidence: parsed.confidence ?? request.plan.confidence * 0.9,
      updatedAt: now,
      revisionCount: request.plan.revisionCount + 1,
    };

    return {
      plan: revisedPlan,
      changes: parsed.changes ?? ['Plan revised'],
      confidence: revisedPlan.confidence,
    };
  } catch {
    // Return original plan with reduced confidence on failure
    return {
      plan: {
        ...request.plan,
        confidence: request.plan.confidence * 0.8,
        updatedAt: now,
        revisionCount: request.plan.revisionCount + 1,
      },
      changes: ['Revision failed, continuing with original plan'],
      confidence: request.plan.confidence * 0.8,
    };
  }
}

/**
 * Get the next pending step from a plan.
 */
export function getNextStep(plan: AgentPlan): PlanStep | null {
  for (const step of plan.steps) {
    if (step.status === 'pending') {
      // Check dependencies
      if (step.dependsOn && step.dependsOn.length > 0) {
        const allDepsComplete = step.dependsOn.every((depId) => {
          const depStep = plan.steps.find((s) => s.id === depId);
          return depStep?.status === 'complete';
        });
        if (!allDepsComplete) {
          continue;
        }
      }
      return step;
    }
  }
  return null;
}

/**
 * Mark a step as complete.
 */
export function completeStep(plan: AgentPlan, stepId: string, result?: unknown): AgentPlan {
  const steps = plan.steps.map((step) => {
    if (step.id === stepId) {
      return { ...step, status: 'complete' as const, result };
    }
    return step;
  });

  const allComplete = steps.every((s) => s.status === 'complete' || s.status === 'skipped');

  return {
    ...plan,
    steps,
    complete: allComplete,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Mark a step as failed.
 */
export function failStep(plan: AgentPlan, stepId: string, error: string): AgentPlan {
  const steps = plan.steps.map((step) => {
    if (step.id === stepId) {
      return { ...step, status: 'failed' as const, error };
    }
    return step;
  });

  return {
    ...plan,
    steps,
    blockers: [...plan.blockers, `Step ${stepId} failed: ${error}`],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Check if a plan is actionable (has pending steps and no blockers).
 */
export function isPlanActionable(plan: AgentPlan): boolean {
  if (plan.complete) return false;
  if (plan.blockers.length > 0) return false;
  return getNextStep(plan) !== null;
}
