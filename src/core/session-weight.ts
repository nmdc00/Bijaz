export type SessionBucket = 'asia' | 'europe_open' | 'us_open' | 'us_midday' | 'us_close' | 'weekend';

export interface SessionWeightContext {
  session: SessionBucket;
  sessionWeight: number;
}

const SESSION_WEIGHTS: Record<SessionBucket, number> = {
  asia: 0.9,
  europe_open: 1.0,
  us_open: 1.15,
  us_midday: 0.95,
  us_close: 1.05,
  weekend: 0.65,
};

function resolveUtcDate(at?: Date | string): Date {
  if (!at) return new Date();
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? new Date() : at;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function resolveSessionBucket(at?: Date | string): SessionBucket {
  const date = resolveUtcDate(at);
  const day = date.getUTCDay();
  if (day === 0 || day === 6) {
    return 'weekend';
  }

  const hour = date.getUTCHours();
  if (hour >= 23 || hour < 7) {
    return 'asia';
  }
  if (hour < 13) {
    return 'europe_open';
  }
  if (hour < 17) {
    return 'us_open';
  }
  if (hour < 20) {
    return 'us_midday';
  }
  return 'us_close';
}

export function resolveSessionWeight(session: SessionBucket): number {
  return SESSION_WEIGHTS[session];
}

export function resolveSessionWeightContext(at?: Date | string): SessionWeightContext {
  const session = resolveSessionBucket(at);
  return {
    session,
    sessionWeight: resolveSessionWeight(session),
  };
}
