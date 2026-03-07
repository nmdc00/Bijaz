import { describe, it, expect } from 'vitest';
import { resolveIdentityPromptMode, finalizeMessages } from '../../src/core/llm.js';
import type { ThufirConfig } from '../../src/core/config.js';
import { IDENTITY_MARKER } from '../../src/agent/identity/types.js';

function makeConfig(overrides?: Partial<ThufirConfig['agent']>): ThufirConfig {
  return {
    agent: {
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      workspace: '/tmp/nonexistent-workspace',
      maxPromptChars: 120000,
      maxToolResultChars: 8000,
      ...overrides,
    },
  } as ThufirConfig;
}

describe('resolveIdentityPromptMode', () => {
  it('returns "none" for trivial kind by default', () => {
    const config = makeConfig();
    expect(resolveIdentityPromptMode(config, 'trivial')).toBe('none');
  });

  it('returns "minimal" for trivial kind when configured', () => {
    const config = makeConfig({ internalPromptMode: 'minimal' });
    expect(resolveIdentityPromptMode(config, 'trivial')).toBe('minimal');
  });

  it('returns "full" for primary kind by default', () => {
    const config = makeConfig();
    expect(resolveIdentityPromptMode(config, 'primary')).toBe('full');
  });

  it('returns "full" for agentic kind by default', () => {
    const config = makeConfig();
    expect(resolveIdentityPromptMode(config, 'agentic')).toBe('full');
  });

  it('returns "full" when kind is undefined', () => {
    const config = makeConfig();
    expect(resolveIdentityPromptMode(config)).toBe('full');
  });
});

describe('finalizeMessages with none mode', () => {
  it('does not inject identity content for trivial calls', () => {
    const config = makeConfig();
    const messages = [
      { role: 'system' as const, content: 'Classify this input.' },
      { role: 'user' as const, content: 'Hello world' },
    ];

    const result = finalizeMessages(messages, config, {
      provider: 'anthropic',
      model: 'test',
      kind: 'trivial',
    });

    const systemMsg = result.find((m) => m.role === 'system');
    // System content should NOT contain the identity marker
    expect(systemMsg?.content).not.toContain(IDENTITY_MARKER);
    // Should still contain the original system content
    expect(systemMsg?.content).toContain('Classify this input.');
  });

  it('does inject identity content for primary calls', () => {
    const config = makeConfig();
    const messages = [
      { role: 'system' as const, content: 'You are a helpful assistant.' },
      { role: 'user' as const, content: 'What is Bitcoin?' },
    ];

    const result = finalizeMessages(messages, config, {
      provider: 'anthropic',
      model: 'test',
      kind: 'primary',
    });

    const systemMsg = result.find((m) => m.role === 'system');
    // Should contain the identity marker for non-trivial calls
    expect(systemMsg?.content).toContain(IDENTITY_MARKER);
  });

  it('trivial mode produces shorter output than full mode', () => {
    const config = makeConfig();
    const messages = [
      { role: 'system' as const, content: 'Task instructions here.' },
      { role: 'user' as const, content: 'Input data' },
    ];

    const trivialResult = finalizeMessages(messages, config, {
      provider: 'anthropic',
      model: 'test',
      kind: 'trivial',
    });

    const fullResult = finalizeMessages(messages, config, {
      provider: 'anthropic',
      model: 'test',
      kind: 'primary',
    });

    const trivialChars = trivialResult.reduce((sum, m) => sum + m.content.length, 0);
    const fullChars = fullResult.reduce((sum, m) => sum + m.content.length, 0);

    expect(trivialChars).toBeLessThan(fullChars);
  });
});
