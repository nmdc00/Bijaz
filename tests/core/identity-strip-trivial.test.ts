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
  it('returns "minimal" for trivial kind by default', () => {
    const config = makeConfig();
    expect(resolveIdentityPromptMode(config, 'trivial')).toBe('minimal');
  });

  it('returns "none" for trivial kind when explicitly configured', () => {
    const config = makeConfig({ internalPromptMode: 'none' });
    expect(resolveIdentityPromptMode(config, 'trivial')).toBe('none');
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

describe('finalizeMessages trivial mode', () => {
  it('injects hard identity marker for trivial calls by default (minimal mode)', () => {
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
    // Default minimal mode still injects the identity marker
    expect(systemMsg?.content).toContain(IDENTITY_MARKER);
    // Should still contain the original system content
    expect(systemMsg?.content).toContain('Classify this input.');
  });

  it('does not inject identity for trivial calls when internalPromptMode is "none"', () => {
    const config = makeConfig({ internalPromptMode: 'none' });
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
    expect(systemMsg?.content).not.toContain(IDENTITY_MARKER);
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
