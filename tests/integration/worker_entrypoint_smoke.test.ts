import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { runWorkerAlertsEntrypoint, type WorkerProcessLike } from '../../src/worker/alerts.js';

class FakeProcess extends EventEmitter implements WorkerProcessLike {
  pid = 9901;
  public exits: number[] = [];

  exit(code?: number): void {
    this.exits.push(code ?? 0);
  }
}

describe('worker alerts integration smoke', () => {
  it('starts via entrypoint harness and performs graceful SIGINT shutdown', async () => {
    const processRef = new FakeProcess();
    const start = vi.fn();
    const stop = vi.fn();

    const started = await runWorkerAlertsEntrypoint({
      deps: {
        processRef,
        loadConfig: () =>
          ({
            autonomy: { enabled: true, scanIntervalSeconds: 30 },
            execution: { mode: 'paper' },
            wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
          }) as any,
        createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
        createLlmClient: () => ({}) as any,
        createMarketClient: () => ({ isAvailable: () => true }) as any,
        createExecutor: async () => ({ execute: async () => ({ executed: false }) }) as any,
        createLimiter: () => ({ getRemainingDaily: () => 100 } as any),
        createAutonomousManager: () => ({ start, stop }),
      },
    });

    expect(start).toHaveBeenCalledTimes(1);

    processRef.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(processRef.exits).toEqual([0]);

    started.removeShutdownHooks();
  });
});
