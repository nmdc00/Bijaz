import { describe, expect, it } from 'vitest';

import { evaluateReduceOnlyExitAssessment, normalizeExitMode } from '../../src/core/tool-executor.js';

describe('tool-executor exit assessment', () => {
  it('marks thesis invalidation exits as thesis incorrect and non-emotional', () => {
    const result = evaluateReduceOnlyExitAssessment({
      reduceOnly: true,
      thesisInvalidationHit: true,
      exitMode: normalizeExitMode('thesis_invalidation'),
    });

    expect(result.thesisCorrect).toBe(false);
    expect(result.emotionalExitFlag).toBe(false);
    expect(result.exitMode).toBe('thesis_invalidation');
  });

  it('marks manual non-invalidation exits as emotional and thesis-incorrect', () => {
    const result = evaluateReduceOnlyExitAssessment({
      reduceOnly: true,
      thesisInvalidationHit: false,
      exitMode: normalizeExitMode('manual'),
    });

    expect(result.thesisCorrect).toBe(false);
    expect(result.emotionalExitFlag).toBe(true);
    expect(result.exitMode).toBe('manual');
  });
});
