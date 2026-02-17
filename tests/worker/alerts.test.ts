import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installWorkerShutdownHooks,
  startWorkerAlertsService,
  type WorkerLogger,
  type WorkerProcessLike,
} from '../../src/worker/alerts.js';

class FakeProcess extends EventEmitter implements WorkerProcessLike {
  pid = 4242;
  public exits: number[] = [];

  exit(code?: number): void {
    this.exits.push(code ?? 0);
  }
}

function createLoggerSpy(): WorkerLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const previousDbPath = process.env.THUFIR_DB_PATH;

afterEach(() => {
  if (previousDbPath === undefined) {
    delete process.env.THUFIR_DB_PATH;
  } else {
    process.env.THUFIR_DB_PATH = previousDbPath;
  }
});

describe('worker alerts service', () => {
  it('boots and stops autonomous lifecycle once', async () => {
    const autonomous = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const logger = createLoggerSpy();

    const runtime = await startWorkerAlertsService({
      deps: {
        processRef: new FakeProcess(),
        loadConfig: () =>
          ({
            autonomy: { enabled: true, scanIntervalSeconds: 60 },
            memory: { dbPath: '/tmp/test-worker.sqlite' },
            wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
            execution: { mode: 'paper' },
          }) as any,
        createLogger: () => logger,
        createLlmClient: () => ({}) as any,
        createMarketClient: () => ({ isAvailable: () => true }) as any,
        createExecutor: async () => ({ execute: async () => ({ executed: false }) }) as any,
        createLimiter: () => ({ getRemainingDaily: () => 100 } as any),
        createAutonomousManager: () => autonomous,
      },
    });

    expect(autonomous.start).toHaveBeenCalledTimes(1);
    expect(process.env.THUFIR_DB_PATH).toBe('/tmp/test-worker.sqlite');

    await runtime.stop();
    await runtime.stop();
    expect(autonomous.stop).toHaveBeenCalledTimes(1);
  });

  it('fails closed when autonomy is disabled', async () => {
    await expect(
      startWorkerAlertsService({
        deps: {
          loadConfig: () => ({ autonomy: { enabled: false } }) as any,
        },
      })
    ).rejects.toThrow('autonomy.enabled=true');
  });

  it('installs shutdown hooks and handles SIGTERM', async () => {
    const processRef = new FakeProcess();
    const stop = vi.fn(async () => undefined);
    const logger = createLoggerSpy();

    const removeHooks = installWorkerShutdownHooks({ logger, stop, processRef });
    processRef.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(processRef.exits).toEqual([0]);

    removeHooks();
    processRef.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
