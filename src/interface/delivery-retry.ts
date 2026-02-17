type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function toNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.floor(parsed));
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function sendWithRetry(
  sendOnce: () => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>,
  channel: string,
  options?: RetryOptions
): Promise<void> {
  const maxAttempts =
    options?.maxAttempts ??
    toPositiveInt(process.env.THUFIR_ALERT_DELIVERY_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs =
    options?.baseDelayMs ??
    toNonNegativeInt(process.env.THUFIR_ALERT_DELIVERY_RETRY_BASE_MS, DEFAULT_BASE_DELAY_MS);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await sendOnce();
      if (response.ok) {
        return;
      }

      const body = await response.text().catch(() => '');
      const transient = isRetryableStatus(response.status);
      const detail = body || 'no response body';
      lastError = new Error(`${channel} send failed (${response.status}): ${detail}`);

      if (!transient || attempt >= maxAttempts) {
        throw lastError;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes(`${channel} send failed`)) {
        if (attempt >= maxAttempts) {
          throw error;
        }
      } else {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= maxAttempts) {
          throw lastError;
        }
      }
    }

    await sleep(baseDelayMs * attempt);
  }

  throw lastError ?? new Error(`${channel} send failed after ${maxAttempts} attempts`);
}
