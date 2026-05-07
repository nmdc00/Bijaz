import { describe, expect, it, vi } from 'vitest';

import { registerResolverSchedulerJob } from '../../src/gateway/resolver_scheduler.js';

describe('registerResolverSchedulerJob', () => {
  it('registers the resolver job when notifications.resolver is omitted', async () => {
    const registerJob = vi.fn();
    const runPredictionResolver = vi.fn(async () => 0);
    const runForecastResolver = vi.fn(async () => ({ checked: 2, resolved: 1 }));
    const logger = { info: vi.fn() };

    const registered = registerResolverSchedulerJob({
      config: {
        notifications: {
          briefing: { enabled: false, time: '08:00', channels: [] },
        } as any,
      } as any,
      scheduler: { registerJob },
      schedulerNamespace: 'prod',
      logger,
      runPredictionResolver,
      runForecastResolver,
    });

    expect(registered).toBe(true);
    expect(registerJob).toHaveBeenCalledTimes(1);
    const [definition, handler] = registerJob.mock.calls[0];
    expect(definition).toEqual({
      name: 'gateway:prod:resolver',
      schedule: { kind: 'interval', intervalMs: 900_000 },
      leaseMs: 60_000,
    });

    await handler();

    expect(runPredictionResolver).toHaveBeenCalledTimes(1);
    expect(runForecastResolver).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Forecast resolver: resolved 1/2 expired forecast(s).');
  });

  it('does not register the resolver job when explicitly disabled', () => {
    const registerJob = vi.fn();

    const registered = registerResolverSchedulerJob({
      config: {
        notifications: {
          resolver: { enabled: false, intervalSeconds: 120, limit: 25 },
        },
      } as any,
      scheduler: { registerJob },
      schedulerNamespace: 'prod',
      logger: { info: vi.fn() },
      runPredictionResolver: async () => 0,
      runForecastResolver: async () => ({ checked: 0, resolved: 0 }),
    });

    expect(registered).toBe(false);
    expect(registerJob).not.toHaveBeenCalled();
  });
});
