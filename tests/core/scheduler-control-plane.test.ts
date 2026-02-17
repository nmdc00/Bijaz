import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/memory/db.js';
import {
  SchedulerControlPlane,
  computeNextDailyRunMs,
  computeNextIntervalRunMs,
} from '../../src/core/scheduler_control_plane.js';

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-scheduler-'));
  return join(dir, 'thufir.sqlite');
}

describe('scheduler control plane', () => {
  it('computes deterministic next interval runs', () => {
    const anchorMs = 1_000;
    const intervalMs = 100;

    expect(computeNextIntervalRunMs({ anchorMs, nowMs: 1_000, intervalMs })).toBe(1_100);
    expect(computeNextIntervalRunMs({ anchorMs, nowMs: 1_499, intervalMs })).toBe(1_500);
    expect(computeNextIntervalRunMs({ anchorMs, nowMs: 1_500, intervalMs })).toBe(1_600);
  });

  it('computes deterministic next daily runs', () => {
    const now = new Date(2026, 1, 17, 9, 30, 0, 0).getTime();
    const next = computeNextDailyRunMs({ nowMs: now, time: '10:15' });
    const nextDate = new Date(next);
    expect(nextDate.getHours()).toBe(10);
    expect(nextDate.getMinutes()).toBe(15);
    expect(next).toBeGreaterThan(now);

    const after = new Date(2026, 1, 17, 22, 0, 0, 0).getTime();
    const rolled = computeNextDailyRunMs({ nowMs: after, time: '10:15' });
    const rolledDate = new Date(rolled);
    expect(rolledDate.getDate()).not.toBe(new Date(after).getDate());
    expect(rolledDate.getHours()).toBe(10);
    expect(rolledDate.getMinutes()).toBe(15);
  });

  it('enforces lock/lease semantics and resumes after expiry', () => {
    const db = openDatabase(createTempDbPath());
    let nowMs = Date.now();

    const ownerA = new SchedulerControlPlane({
      ownerId: 'owner-a',
      db,
      nowMs: () => nowMs,
    });
    ownerA.registerJob(
      {
        name: 'lease-job',
        schedule: { kind: 'interval', intervalMs: 1_000 },
        leaseMs: 5_000,
      },
      async () => undefined
    );

    db.prepare(`UPDATE scheduler_jobs SET next_run_at = @nextRunAt WHERE name = 'lease-job'`).run({
      nextRunAt: new Date(nowMs).toISOString(),
    });

    expect(ownerA.tryAcquireLease('lease-job')).toBe(true);

    const ownerB = new SchedulerControlPlane({
      ownerId: 'owner-b',
      db,
      nowMs: () => nowMs,
    });
    expect(ownerB.tryAcquireLease('lease-job')).toBe(false);

    nowMs += 6_000;
    expect(ownerB.tryAcquireLease('lease-job')).toBe(true);
  });

  it('recovers expired running jobs on startup and executes due work', async () => {
    const db = openDatabase(createTempDbPath());
    let runs = 0;
    const nowMs = Date.now();

    db.prepare(
      `
      INSERT INTO scheduler_jobs (
        name, schedule_kind, interval_ms, daily_time, status, next_run_at,
        failures, last_error, lock_owner, lock_expires_at, lease_ms, created_at, updated_at
      ) VALUES (
        'recover-job', 'interval', 1000, NULL, 'running', @nextRunAt,
        0, NULL, 'stale-owner', @lockExpiresAt, 1000, @nowIso, @nowIso
      )
    `
    ).run({
      nextRunAt: new Date(nowMs - 2_000).toISOString(),
      lockExpiresAt: new Date(nowMs - 1_000).toISOString(),
      nowIso: new Date(nowMs).toISOString(),
    });

    const scheduler = new SchedulerControlPlane({
      ownerId: 'recover-owner',
      db,
      pollIntervalMs: 20,
    });
    scheduler.registerJob(
      {
        name: 'recover-job',
        schedule: { kind: 'interval', intervalMs: 1_000 },
        leaseMs: 1_000,
      },
      async () => {
        runs += 1;
      }
    );

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    scheduler.stop();

    expect(runs).toBe(1);
    const row = db
      .prepare(
        `
        SELECT status, lock_owner as lockOwner, lock_expires_at as lockExpiresAt
        FROM scheduler_jobs
        WHERE name = 'recover-job'
      `
      )
      .get() as { status: string; lockOwner: string | null; lockExpiresAt: string | null };
    expect(row.status).toBe('success');
    expect(row.lockOwner).toBeNull();
    expect(row.lockExpiresAt).toBeNull();
  });
});
