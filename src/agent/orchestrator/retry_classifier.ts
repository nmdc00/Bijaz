export type ToolFailureRetryClass = 'retryable' | 'terminal';

export interface ToolFailureClassification {
  classification: ToolFailureRetryClass;
  reasonCode: string;
}

export function classifyToolFailure(toolName: string, error: string): ToolFailureClassification {
  const text = (error ?? '').toLowerCase();

  // Tool input/schema/contract errors are terminal for the current cycle.
  const terminalPatterns = [
    'invalid enum value',
    'missing/invalid',
    'missing or invalid',
    'conflicts with',
    'requires exit_mode',
    'invalid input',
    'zod',
    'would increase position',
    'order could not immediately match',
  ];
  if (terminalPatterns.some((p) => text.includes(p))) {
    return { classification: 'terminal', reasonCode: `${toolName}.terminal.validation_or_contract` };
  }

  // Temporary capacity/network classes should retry.
  const retryablePatterns = [
    'timeout',
    'timed out',
    'rate limit',
    '429',
    '503',
    'temporarily unavailable',
    'network',
    'eai_again',
    'connection reset',
  ];
  if (retryablePatterns.some((p) => text.includes(p))) {
    return { classification: 'retryable', reasonCode: `${toolName}.retryable.transient` };
  }

  // Default to retryable for unknown runtime failures.
  return { classification: 'retryable', reasonCode: `${toolName}.retryable.unknown` };
}
