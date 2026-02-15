import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  records: [] as any[],
}));

vi.mock('../../src/memory/position_heartbeat_journal.js', () => {
  return {
    recordPositionHeartbeatDecision: (entry: unknown) => {
      state.records.push(entry);
    },
  };
});

import { PositionHeartbeatService } from '../../src/core/position_heartbeat.js';

function mkToolContext(config: any): any {
  return { config, marketClient: {} };
}

describe('position heartbeat retries', () => {
  beforeEach(() => {
    state.records = [];
    vi.restoreAllMocks();
  });

  it('enters degraded mode (no throw) when Hyperliquid poll keeps timing out', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const client = {
      getClearinghouseState: vi.fn().mockRejectedValue(Object.assign(new Error('TimeoutError'), { name: 'TimeoutError' })),
      getAllMids: vi.fn(),
      getOpenOrders: vi.fn(),
      getMetaAndAssetCtxs: vi.fn(),
    };

    const service = new PositionHeartbeatService({
      toolContext: mkToolContext({ heartbeat: { enabled: true }, hyperliquid: { httpTimeoutMs: 30000 } }),
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
      llm: { complete: vi.fn() } as any,
      hyperliquidClientFactory: () => client as any,
    });

    const p = service.tick();
    await vi.runAllTimersAsync();
    await p;

    // retries:4 => attempts:5
    expect(client.getClearinghouseState).toHaveBeenCalledTimes(5);
    expect(state.records.length).toBe(1);
    expect(state.records[0].outcome).toBe('skipped');
    expect(state.records[0].triggers).toContain('data_poll_failed');
  });

  it('retries and succeeds without journaling a degraded decision', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    let calls = 0;
    const client = {
      getClearinghouseState: vi.fn(async () => {
        calls += 1;
        if (calls <= 2) {
          throw Object.assign(new Error('TimeoutError'), { name: 'TimeoutError' });
        }
        return { assetPositions: [], marginSummary: { accountValue: 100 } };
      }),
      getAllMids: vi.fn().mockResolvedValue({}),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getMetaAndAssetCtxs: vi.fn().mockResolvedValue([{ universe: [] }, []]),
    };

    const service = new PositionHeartbeatService({
      toolContext: mkToolContext({ heartbeat: { enabled: true }, hyperliquid: { httpTimeoutMs: 30000 } }),
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
      llm: { complete: vi.fn() } as any,
      hyperliquidClientFactory: () => client as any,
    });

    const p = service.tick();
    await vi.runAllTimersAsync();
    await p;

    expect(client.getClearinghouseState).toHaveBeenCalledTimes(3);
    expect(client.getAllMids).toHaveBeenCalledTimes(1);
    expect(state.records.length).toBe(0);
  });
});
