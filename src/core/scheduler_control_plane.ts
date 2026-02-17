import type Database from 'better-sqlite3';

import { openDatabase } from '../memory/db.js';

type JobStatus = 'idle' | 'running' | 'success' | 'failed';

export type ScheduleDefinition =
  | { kind: 'interval'; intervalMs: number }
  | { kind: 'daily'; time: string };

export interface SchedulerJobDefinition {
  name: string;
  schedule: ScheduleDefinition;
  leaseMs?: number;
}

interface StoredSchedulerJob {
  name: string;
  scheduleKind: 'interval' | 'daily';
  intervalMs: number | null;
  dailyTime: string | null;
  status: JobStatus;
  lastRunAt: string | null;
  nextRunAt: string;
  failures: number;
  lockOwner: string | null;
  lockExpiresAt: string | null;
  leaseMs: number;
}

export interface SchedulerControlPlaneOptions {
  ownerId: string;
  db?: Database.Database;
  pollIntervalMs?: number;
  defaultLeaseMs?: number;
  nowMs?: () => number;
}

type JobHandler = () => Promise<void>;

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function parseDailyTime(time: string): { hours: number; minutes: number } {
  const [hoursPart, minutesPart] = time.split(':');
  const hours = Number(hoursPart);
  const minutes = Number(minutesPart);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid daily schedule time "${time}". Expected HH:MM.`);
  }
  return { hours, minutes };
}

export function computeNextIntervalRunMs(params: { anchorMs: number; nowMs: number; intervalMs: number }): number {
  const { anchorMs, nowMs, intervalMs } = params;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`intervalMs must be > 0, got ${intervalMs}`);
  }
  if (anchorMs > nowMs) {
    return anchorMs;
  }
  const steps = Math.floor((nowMs - anchorMs) / intervalMs) + 1;
  return anchorMs + steps * intervalMs;
}

export function computeNextDailyRunMs(params: { nowMs: number; time: string }): number {
  const { nowMs, time } = params;
  const { hours, minutes } = parseDailyTime(time);
  const now = new Date(nowMs);
  const target = new Date(nowMs);
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

export function computeInitialNextRunMs(params: { schedule: ScheduleDefinition; nowMs: number }): number {
  const { schedule, nowMs } = params;
  if (schedule.kind === 'interval') {
    return nowMs + schedule.intervalMs;
  }
  return computeNextDailyRunMs({ nowMs, time: schedule.time });
}

function computeNextRunFromStored(params: { row: StoredSchedulerJob; nowMs: number }): number {
  const { row, nowMs } = params;
  if (row.scheduleKind === 'interval') {
    const intervalMs = row.intervalMs;
    if (!Number.isFinite(intervalMs) || intervalMs == null || intervalMs <= 0) {
      throw new Error(`Job ${row.name} has invalid interval schedule.`);
    }
    const anchorMs = parseIsoMs(row.nextRunAt) ?? nowMs + intervalMs;
    return computeNextIntervalRunMs({ anchorMs, nowMs, intervalMs });
  }
  if (!row.dailyTime) {
    throw new Error(`Job ${row.name} has invalid daily schedule.`);
  }
  return computeNextDailyRunMs({ nowMs, time: row.dailyTime });
}

export class SchedulerControlPlane {
  private readonly db: Database.Database;
  private readonly ownerId: string;
  private readonly pollIntervalMs: number;
  private readonly defaultLeaseMs: number;
  private readonly nowMs: () => number;
  private readonly jobs = new Map<string, SchedulerJobDefinition>();
  private readonly handlers = new Map<string, JobHandler>();
  private tickTimer: NodeJS.Timeout | null = null;
  private tickInFlight = false;

  constructor(options: SchedulerControlPlaneOptions) {
    this.db = options.db ?? openDatabase();
    this.ownerId = options.ownerId;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.defaultLeaseMs = options.defaultLeaseMs ?? 120_000;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  registerJob(definition: SchedulerJobDefinition, handler: JobHandler): void {
    this.jobs.set(definition.name, definition);
    this.handlers.set(definition.name, handler);
    this.upsertJobDefinition(definition);
  }

  start(): void {
    if (this.tickTimer) return;
    this.recoverExpiredRunningLeases();
    void this.tick();
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  tryAcquireLease(jobName: string): boolean {
    const nowMs = this.nowMs();
    const nowIso = toIso(nowMs);
    const row = this.getStoredJob(jobName);
    if (!row) {
      return false;
    }
    const leaseMs = row.leaseMs > 0 ? row.leaseMs : this.defaultLeaseMs;
    const lockExpiresAt = toIso(nowMs + leaseMs);
    const result = this.db
      .prepare(
        `
        UPDATE scheduler_jobs
        SET
          status = 'running',
          lock_owner = @ownerId,
          lock_expires_at = @lockExpiresAt,
          updated_at = @nowIso
        WHERE
          name = @name
          AND datetime(next_run_at) <= datetime(@nowIso)
          AND (lock_expires_at IS NULL OR datetime(lock_expires_at) <= datetime(@nowIso))
      `
      )
      .run({
        name: jobName,
        ownerId: this.ownerId,
        lockExpiresAt,
        nowIso,
      });
    return result.changes > 0;
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      for (const name of this.jobs.keys()) {
        const due = this.getStoredJob(name);
        if (!due) continue;
        const nextRunMs = parseIsoMs(due.nextRunAt);
        if (nextRunMs == null || nextRunMs > this.nowMs()) {
          continue;
        }
        const lockExpiresMs = parseIsoMs(due.lockExpiresAt);
        if (lockExpiresMs != null && lockExpiresMs > this.nowMs()) {
          continue;
        }
        if (!this.tryAcquireLease(name)) {
          continue;
        }
        const handler = this.handlers.get(name);
        if (!handler) {
          this.markFailed(name, new Error(`No handler registered for job "${name}".`));
          continue;
        }
        try {
          await handler();
          this.markSuccess(name);
        } catch (error) {
          this.markFailed(name, error);
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private markSuccess(jobName: string): void {
    const row = this.getStoredJob(jobName);
    if (!row) return;
    const nowMs = this.nowMs();
    const nowIso = toIso(nowMs);
    const nextRunAt = toIso(computeNextRunFromStored({ row, nowMs }));
    this.db
      .prepare(
        `
        UPDATE scheduler_jobs
        SET
          status = 'success',
          last_run_at = @nowIso,
          next_run_at = @nextRunAt,
          failures = 0,
          last_error = NULL,
          lock_owner = NULL,
          lock_expires_at = NULL,
          updated_at = @nowIso
        WHERE name = @name
      `
      )
      .run({ name: jobName, nowIso, nextRunAt });
  }

  private markFailed(jobName: string, error: unknown): void {
    const row = this.getStoredJob(jobName);
    if (!row) return;
    const nowMs = this.nowMs();
    const nowIso = toIso(nowMs);
    const nextRunAt = toIso(computeNextRunFromStored({ row, nowMs }));
    const message = error instanceof Error ? error.message : String(error);
    this.db
      .prepare(
        `
        UPDATE scheduler_jobs
        SET
          status = 'failed',
          last_run_at = @nowIso,
          next_run_at = @nextRunAt,
          failures = failures + 1,
          last_error = @lastError,
          lock_owner = NULL,
          lock_expires_at = NULL,
          updated_at = @nowIso
        WHERE name = @name
      `
      )
      .run({ name: jobName, nowIso, nextRunAt, lastError: message });
  }

  private recoverExpiredRunningLeases(): void {
    const nowIso = toIso(this.nowMs());
    this.db
      .prepare(
        `
        UPDATE scheduler_jobs
        SET
          status = CASE WHEN status = 'running' THEN 'failed' ELSE status END,
          failures = CASE WHEN status = 'running' THEN failures + 1 ELSE failures END,
          last_error = CASE WHEN status = 'running' THEN 'Recovered expired lease during startup' ELSE last_error END,
          lock_owner = NULL,
          lock_expires_at = NULL,
          updated_at = @nowIso
        WHERE lock_expires_at IS NOT NULL AND datetime(lock_expires_at) <= datetime(@nowIso)
      `
      )
      .run({ nowIso });
  }

  private upsertJobDefinition(definition: SchedulerJobDefinition): void {
    const nowMs = this.nowMs();
    const nowIso = toIso(nowMs);
    const nextRunAt = toIso(computeInitialNextRunMs({ schedule: definition.schedule, nowMs }));
    const intervalMs = definition.schedule.kind === 'interval' ? definition.schedule.intervalMs : null;
    const dailyTime = definition.schedule.kind === 'daily' ? definition.schedule.time : null;
    const leaseMs = definition.leaseMs ?? this.defaultLeaseMs;

    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO scheduler_jobs (
          name,
          schedule_kind,
          interval_ms,
          daily_time,
          status,
          next_run_at,
          failures,
          lease_ms,
          created_at,
          updated_at
        ) VALUES (
          @name,
          @scheduleKind,
          @intervalMs,
          @dailyTime,
          'idle',
          @nextRunAt,
          0,
          @leaseMs,
          @nowIso,
          @nowIso
        )
      `
      )
      .run({
        name: definition.name,
        scheduleKind: definition.schedule.kind,
        intervalMs,
        dailyTime,
        nextRunAt,
        leaseMs,
        nowIso,
      });

    this.db
      .prepare(
        `
        UPDATE scheduler_jobs
        SET
          schedule_kind = @scheduleKind,
          interval_ms = @intervalMs,
          daily_time = @dailyTime,
          lease_ms = @leaseMs,
          updated_at = @nowIso
        WHERE name = @name
      `
      )
      .run({
        name: definition.name,
        scheduleKind: definition.schedule.kind,
        intervalMs,
        dailyTime,
        leaseMs,
        nowIso,
      });
  }

  private getStoredJob(name: string): StoredSchedulerJob | null {
    return (
      this.db
        .prepare(
          `
          SELECT
            name,
            schedule_kind as scheduleKind,
            interval_ms as intervalMs,
            daily_time as dailyTime,
            status,
            last_run_at as lastRunAt,
            next_run_at as nextRunAt,
            failures,
            lock_owner as lockOwner,
            lock_expires_at as lockExpiresAt,
            lease_ms as leaseMs
          FROM scheduler_jobs
          WHERE name = @name
        `
        )
        .get({ name }) ?? null
    ) as StoredSchedulerJob | null;
  }
}
