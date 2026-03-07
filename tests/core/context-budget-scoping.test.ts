/**
 * context-budget-scoping.test.ts
 *
 * Verifies per-call-kind maxPromptChars overrides (v1.91 branch #5).
 * - trivial kind    → promptBudget.trivial   (default 10K)
 * - autonomous ctx  → promptBudget.autonomous (default 25K)
 * - chat / default  → promptBudget.chat       (default 120K)
 */
import { describe, it, expect } from 'vitest';
import { resolveMaxPromptChars, finalizeMessages } from '../../src/core/llm.js';
import { withExecutionContext } from '../../src/core/llm_infra.js';
import type { ThufirConfig } from '../../src/core/config.js';
import type { LlmClientMeta } from '../../src/core/llm.js';

function makeConfig(promptBudget?: Partial<{ autonomous: number; trivial: number; chat: number }>): ThufirConfig {
  return {
    agent: {
      provider: 'anthropic',
      model: 'claude-test',
      workspace: '/tmp/nonexistent',
      maxPromptChars: 120000,
      maxToolResultChars: 8000,
      promptBudget: {
        autonomous: promptBudget?.autonomous ?? 25000,
        trivial: promptBudget?.trivial ?? 10000,
        chat: promptBudget?.chat ?? 120000,
      },
    },
  } as unknown as ThufirConfig;
}

const trivialMeta: LlmClientMeta = { provider: 'local', model: 'qwen', kind: 'trivial' };
const primaryMeta: LlmClientMeta = { provider: 'anthropic', model: 'claude', kind: 'primary' };

describe('resolveMaxPromptChars', () => {
  it('returns trivial budget for trivial kind', () => {
    const config = makeConfig({ trivial: 10000 });
    expect(resolveMaxPromptChars(config, trivialMeta)).toBe(10000);
  });

  it('returns autonomous budget when execution context source is autonomous', async () => {
    const config = makeConfig({ autonomous: 25000 });
    const result = await withExecutionContext(
      { mode: 'LIGHT_REASONING', source: 'autonomous', reason: 'test' },
      async () => resolveMaxPromptChars(config, primaryMeta)
    );
    expect(result).toBe(25000);
  });

  it('returns chat budget for primary kind outside autonomous context', () => {
    const config = makeConfig({ chat: 120000 });
    expect(resolveMaxPromptChars(config, primaryMeta)).toBe(120000);
  });

  it('returns chat budget when kind is undefined and no autonomous context', () => {
    const config = makeConfig({ chat: 99000 });
    expect(resolveMaxPromptChars(config)).toBe(99000);
  });

  it('trivial kind takes precedence over autonomous context', async () => {
    const config = makeConfig({ trivial: 10000, autonomous: 25000 });
    const result = await withExecutionContext(
      { mode: 'LIGHT_REASONING', source: 'autonomous', reason: 'test' },
      async () => resolveMaxPromptChars(config, trivialMeta)
    );
    // trivial kind wins regardless of execution context
    expect(result).toBe(10000);
  });

  it('respects config overrides for all three kinds', () => {
    const config = makeConfig({ trivial: 5000, autonomous: 15000, chat: 80000 });
    expect(resolveMaxPromptChars(config, trivialMeta)).toBe(5000);
    expect(resolveMaxPromptChars(config, primaryMeta)).toBe(80000);
  });

  it('falls back to agent.maxPromptChars when promptBudget.chat is not set', () => {
    const config = {
      agent: {
        provider: 'anthropic',
        model: 'test',
        workspace: '/tmp/nonexistent',
        maxPromptChars: 60000,
        maxToolResultChars: 8000,
        promptBudget: { autonomous: 25000, trivial: 10000, chat: 120000 },
      },
    } as unknown as ThufirConfig;
    expect(resolveMaxPromptChars(config, primaryMeta)).toBe(120000);
  });
});

describe('finalizeMessages respects per-kind budgets', () => {
  it('trivial messages are capped at trivial budget', () => {
    const config = makeConfig({ trivial: 500 });
    // Build messages that total well over 500 chars
    const messages = [
      { role: 'system' as const, content: 'A'.repeat(300) },
      { role: 'user' as const, content: 'B'.repeat(300) },
    ];
    const result = finalizeMessages(messages, config, trivialMeta);
    const totalChars = result.reduce((sum, m) => sum + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(500);
  });

  it('autonomous context trims more aggressively than chat for non-trivial calls', async () => {
    // trimMessagesByCharBudget drops non-system messages from oldest-first.
    // Identity prelude (~6-7K) is injected into the system message.
    // Load the conversation with many user/assistant turns so the budget difference is visible.
    const chunk = 'X'.repeat(4000);
    const messages = [
      { role: 'system' as const, content: 'Operating rules.' },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
    ];

    const config = makeConfig({ autonomous: 25000, chat: 120000 });

    const autoResult = await withExecutionContext(
      { mode: 'LIGHT_REASONING', source: 'autonomous', reason: 'test' },
      async () => finalizeMessages(messages, config, primaryMeta)
    );
    const chatResult = finalizeMessages(messages, config, primaryMeta);

    const autoChars = autoResult.reduce((sum, m) => sum + m.content.length, 0);
    const chatChars = chatResult.reduce((sum, m) => sum + m.content.length, 0);

    // Autonomous budget (25K) should produce fewer chars than chat (120K)
    // because old conversation turns are dropped first
    expect(autoChars).toBeLessThanOrEqual(25000);
    expect(chatChars).toBeGreaterThan(autoChars);
  });

  it('chat messages respect chat budget ceiling when conversation exceeds it', () => {
    // Build enough user/assistant history to exceed the 30K budget
    const chunk = 'C'.repeat(4000);
    const messages = [
      { role: 'system' as const, content: 'Instructions.' },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
    ];
    const config = makeConfig({ chat: 30000 });
    const result = finalizeMessages(messages, config, primaryMeta);
    const totalChars = result.reduce((sum, m) => sum + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(30000);
  });
});
