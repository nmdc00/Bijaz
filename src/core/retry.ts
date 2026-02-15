export type RetryBackoffOptions = {
  retries: number; // number of retries after the initial attempt
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs?: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (info: { attempt: number; retriesLeft: number; delayMs: number; error: unknown }) => void;
  sleepFn?: (ms: number) => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryBackoffOptions
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; error: unknown; attempts: number }> {
  const retries = Math.max(0, Math.floor(opts.retries));
  const baseDelayMs = Math.max(0, Math.floor(opts.baseDelayMs));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(opts.maxDelayMs));
  const jitterMs = Math.max(0, Math.floor(opts.jitterMs ?? 0));
  const isRetryable = opts.isRetryable ?? (() => true);
  const sleepFn = opts.sleepFn ?? sleep;

  let attempt = 0;
  // attempts = initial attempt (1) + retries
  while (attempt < retries + 1) {
    attempt += 1;
    try {
      const value = await fn();
      return { ok: true, value, attempts: attempt };
    } catch (err) {
      const retriesLeft = retries + 1 - attempt;
      if (retriesLeft <= 0 || !isRetryable(err)) {
        return { ok: false, error: err, attempts: attempt };
      }

      const exp = attempt - 1; // 0,1,2...
      const rawDelay = baseDelayMs * Math.pow(2, exp);
      const delayNoJitter = clamp(rawDelay, baseDelayMs, maxDelayMs);
      const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
      const delayMs = delayNoJitter + jitter;
      opts.onRetry?.({ attempt, retriesLeft, delayMs, error: err });
      if (delayMs > 0) await sleepFn(delayMs);
    }
  }

  return { ok: false, error: new Error('retryWithBackoff: exhausted retries'), attempts: retries + 1 };
}

