import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fixture from '../fixtures/v1_5_trigger_stream.fixture.json';
import { Logger } from '../../src/core/logger.js';
import { PositionHeartbeatService } from '../../src/core/position_heartbeat.js';

const journalWrites: Array<{ symbol: string; triggers: string[]; decision?: { action?: string } }> = [];

vi.mock('../../src/memory/position_heartbeat_journal.js', () => ({
  recordPositionHeartbeatDecision: (
    payload: { symbol: string; triggers: string[]; decision?: { action?: string } }
  ) => {
    journalWrites.push(payload);
  },
}));

type TriggerFixture = {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  frames: Array<{
    iso: string;
    mid: number;
    roePct: number;
    liquidationPrice: number;
    expectedTriggers: string[];
  }>;
};

describe('v1.5 trigger engine core integration', () => {
  beforeEach(() => {
    journalWrites.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits deterministic trigger stream from fixture market/account data', async () => {
    const stream = fixture as TriggerFixture;
    let index = 0;

    const toolExec = async (toolName: string) => {
      if (toolName === 'get_positions') {
        const frame = stream.frames[Math.min(index, stream.frames.length - 1)]!;
        index += 1;
        return {
          success: true as const,
          data: {
            positions: [
              {
                symbol: stream.symbol,
                side: stream.side,
                size: stream.size,
                unrealized_pnl: 0,
                return_on_equity: frame.roePct,
                liquidation_price: frame.liquidationPrice,
              },
            ],
          },
        };
      }
      return { success: false as const, error: `unexpected tool: ${toolName}` };
    };

    const client = {
      getAllMids: async () => {
        const frame = stream.frames[Math.max(0, index - 1)]!;
        return { [stream.symbol]: frame.mid };
      },
    };

    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      heartbeat: {
        enabled: true,
        tickIntervalSeconds: 1,
        rollingBufferSize: 10,
        triggers: {
          pnlShiftPct: 1.5,
          liquidationProximityPct: 5,
          volatilitySpikePct: 2,
          volatilitySpikeWindowTicks: 3,
          timeCeilingMinutes: 1,
          triggerCooldownSeconds: 120,
        },
      },
    } as any;

    const service = new PositionHeartbeatService(
      config,
      { config } as any,
      new Logger('error'),
      { client: client as any, toolExec: toolExec as any }
    );

    service.start();
    for (const frame of stream.frames) {
      vi.setSystemTime(new Date(frame.iso));
      await service.tickOnce();
    }
    service.stop();

    const holds = journalWrites.filter(
      (entry) => entry.symbol === stream.symbol && entry.decision?.action === 'hold'
    );
    expect(holds.length).toBe(stream.frames.length);

    for (let i = 0; i < stream.frames.length; i += 1) {
      expect(holds[i]?.triggers).toEqual(stream.frames[i]?.expectedTriggers);
    }
  });
});
