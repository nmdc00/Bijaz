import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Logger } from '../../src/core/logger.js';

const previousDbPath = process.env.THUFIR_DB_PATH;

function setIsolatedDbPath(name: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-v15-acceptance-'));
  process.env.THUFIR_DB_PATH = join(dir, `${name}.sqlite`);
}

function buildHeartbeatConfig() {
  return {
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
        timeCeilingMinutes: 15,
        triggerCooldownSeconds: 180,
      },
    },
  } as const;
}

afterEach(() => {
  process.env.THUFIR_DB_PATH = previousDbPath;
});

describe('v1.5 worker acceptance harness', () => {
  it('runs trigger -> policy -> delivery -> persistence for emergency liquidation risk', async () => {
    setIsolatedDbPath('worker-e2e-emergency');

    const { PositionHeartbeatService } = await import('../../src/core/position_heartbeat.js');
    const { listDecisionArtifactsByMarket } = await import('../../src/memory/decision_artifacts.js');

    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const toolExec = async (toolName: string, toolInput: Record<string, unknown>) => {
      calls.push({ tool: toolName, input: toolInput });
      if (toolName === 'get_positions') {
        return {
          success: true as const,
          data: {
            positions: [
              {
                symbol: 'BTC',
                side: 'long',
                size: 1,
                unrealized_pnl: -15,
                return_on_equity: -2.5,
                liquidation_price: 99.5,
              },
            ],
          },
        };
      }
      if (toolName === 'perp_place_order') {
        return { success: true as const, data: { status: 'ok' } };
      }
      return { success: false as const, error: `unexpected tool: ${toolName}` };
    };

    const service = new PositionHeartbeatService(
      buildHeartbeatConfig() as any,
      { config: buildHeartbeatConfig() } as any,
      new Logger('error'),
      {
        client: { getAllMids: async () => ({ BTC: 100 }) } as any,
        toolExec: toolExec as any,
      }
    );

    service.start();
    await service.tickOnce();
    service.stop();

    const deliveryCalls = calls.filter((call) => call.tool === 'perp_place_order');
    expect(deliveryCalls.length).toBe(1);
    expect(deliveryCalls[0]?.input.reduce_only).toBe(true);
    expect(deliveryCalls[0]?.input.order_type).toBe('market');

    const artifacts = listDecisionArtifactsByMarket('BTC', 20).filter(
      (artifact) => artifact.kind === 'position_heartbeat_journal'
    );
    expect(artifacts.length).toBeGreaterThan(0);
    const payload = artifacts[0]?.payload as Record<string, any> | null;
    expect(payload?.decision?.action).toBe('close_entirely');
    expect(payload?.outcome).toBe('ok');
    expect(payload?.triggers).toContain('liquidation_proximity');
    expect(Number(payload?.snapshot?.liqDistPct)).toBeLessThan(2);
  });

  it('runs trigger -> policy -> persistence hold path when risk is not emergency', async () => {
    setIsolatedDbPath('worker-e2e-hold');

    const { PositionHeartbeatService } = await import('../../src/core/position_heartbeat.js');
    const { listDecisionArtifactsByMarket } = await import('../../src/memory/decision_artifacts.js');

    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const toolExec = async (toolName: string, toolInput: Record<string, unknown>) => {
      calls.push({ tool: toolName, input: toolInput });
      if (toolName === 'get_positions') {
        return {
          success: true as const,
          data: {
            positions: [
              {
                symbol: 'ETH',
                side: 'long',
                size: 2,
                unrealized_pnl: 12,
                return_on_equity: 1.2,
                liquidation_price: 50,
              },
            ],
          },
        };
      }
      return { success: false as const, error: `unexpected tool: ${toolName}` };
    };

    const service = new PositionHeartbeatService(
      buildHeartbeatConfig() as any,
      { config: buildHeartbeatConfig() } as any,
      new Logger('error'),
      {
        client: { getAllMids: async () => ({ ETH: 100 }) } as any,
        toolExec: toolExec as any,
      }
    );

    service.start();
    await service.tickOnce();
    service.stop();

    expect(calls.some((call) => call.tool === 'perp_place_order')).toBe(false);

    const artifacts = listDecisionArtifactsByMarket('ETH', 20).filter(
      (artifact) => artifact.kind === 'position_heartbeat_journal'
    );
    expect(artifacts.length).toBeGreaterThan(0);
    const payload = artifacts[0]?.payload as Record<string, any> | null;
    expect(payload?.decision?.action).toBe('hold');
    expect(payload?.outcome).toBe('info');
  });
});
