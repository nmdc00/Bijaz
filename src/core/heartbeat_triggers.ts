export type HeartbeatTriggerName =
  | 'pnl_shift'
  | 'liquidation_proximity'
  | 'volatility_spike'
  | 'time_ceiling';

export type HeartbeatPoint = {
  ts: number; // epoch ms
  mid: number | null;
  roePct: number | null;
  liqDistPct: number | null;
};

export type HeartbeatTriggerConfig = {
  pnlShiftPct: number;
  liquidationProximityPct: number;
  volatilitySpikePct: number;
  volatilitySpikeWindowTicks: number;
  timeCeilingMinutes: number;
  triggerCooldownSeconds: number;
};

const toFinite = (value: unknown): number | null => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

function shouldCooldown(params: {
  name: HeartbeatTriggerName;
  nowMs: number;
  cooldownSeconds: number;
  lastFiredByTrigger: Map<HeartbeatTriggerName, number>;
}): boolean {
  const last = params.lastFiredByTrigger.get(params.name);
  if (last == null) return false;
  const next = last + Math.max(0, params.cooldownSeconds) * 1000;
  return params.nowMs < next;
}

function maybePush(
  fired: HeartbeatTriggerName[],
  name: HeartbeatTriggerName,
  params: {
    nowMs: number;
    cfg: HeartbeatTriggerConfig;
    lastFiredByTrigger: Map<HeartbeatTriggerName, number>;
  }
): void {
  if (
    shouldCooldown({
      name,
      nowMs: params.nowMs,
      cooldownSeconds: params.cfg.triggerCooldownSeconds,
      lastFiredByTrigger: params.lastFiredByTrigger,
    })
  ) {
    return;
  }
  fired.push(name);
}

export function evaluateHeartbeatTriggers(params: {
  points: HeartbeatPoint[];
  cfg: HeartbeatTriggerConfig;
  nowMs: number;
  lastFiredByTrigger: Map<HeartbeatTriggerName, number>;
}): HeartbeatTriggerName[] {
  const points = Array.isArray(params.points) ? params.points : [];
  if (points.length === 0) return [];
  const last = points[points.length - 1]!;

  const fired: HeartbeatTriggerName[] = [];

  const liqDist = toFinite(last.liqDistPct);
  if (liqDist != null && liqDist <= params.cfg.liquidationProximityPct) {
    maybePush(fired, 'liquidation_proximity', params);
  }

  if (points.length >= 2) {
    const prev = points[points.length - 2]!;
    const lastRoe = toFinite(last.roePct);
    const prevRoe = toFinite(prev.roePct);
    if (lastRoe != null && prevRoe != null) {
      const delta = Math.abs(lastRoe - prevRoe);
      if (delta >= params.cfg.pnlShiftPct) {
        maybePush(fired, 'pnl_shift', params);
      }
    }
  }

  const window = Math.max(2, Math.floor(params.cfg.volatilitySpikeWindowTicks));
  if (points.length >= window) {
    const start = points[points.length - window]!;
    const startMid = toFinite(start.mid);
    const endMid = toFinite(last.mid);
    if (startMid != null && endMid != null && startMid > 0) {
      const movePct = Math.abs((endMid - startMid) / startMid) * 100;
      if (movePct >= params.cfg.volatilitySpikePct) {
        maybePush(fired, 'volatility_spike', params);
      }
    }
  }

  const timeCeilingMs = Math.max(0, params.cfg.timeCeilingMinutes) * 60 * 1000;
  if (timeCeilingMs > 0) {
    const first = points[0]!;
    if (params.nowMs - first.ts >= timeCeilingMs) {
      maybePush(fired, 'time_ceiling', params);
    }
  }

  if (fired.length > 0) {
    for (const name of fired) {
      params.lastFiredByTrigger.set(name, params.nowMs);
    }
  }

  return fired;
}

