import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export type ScheduledTaskKind = 'once' | 'daily' | 'interval';

export interface ScheduledTaskRecord {
  id: string;
  schedulerJobName: string;
  channel: string;
  recipientId: string;
  scheduleKind: ScheduledTaskKind;
  runAt: string | null;
  dailyTime: string | null;
  intervalMinutes: number | null;
  instruction: string;
  active: boolean;
  lastRanAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledTaskInput {
  schedulerJobName: string;
  channel: string;
  recipientId: string;
  scheduleKind: ScheduledTaskKind;
  runAt?: string | null;
  dailyTime?: string | null;
  intervalMinutes?: number | null;
  instruction: string;
}

function mapRow(row: {
  id: string;
  schedulerJobName: string;
  channel: string;
  recipientId: string;
  scheduleKind: ScheduledTaskKind;
  runAt: string | null;
  dailyTime: string | null;
  intervalMinutes: number | null;
  instruction: string;
  active: number;
  lastRanAt: string | null;
  createdAt: string;
  updatedAt: string;
}): ScheduledTaskRecord {
  return {
    id: row.id,
    schedulerJobName: row.schedulerJobName,
    channel: row.channel,
    recipientId: row.recipientId,
    scheduleKind: row.scheduleKind,
    runAt: row.runAt,
    dailyTime: row.dailyTime,
    intervalMinutes: row.intervalMinutes,
    instruction: row.instruction,
    active: row.active === 1,
    lastRanAt: row.lastRanAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createScheduledTask(input: CreateScheduledTaskInput): ScheduledTaskRecord {
  const db = openDatabase();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO scheduled_tasks (
        id,
        scheduler_job_name,
        channel,
        recipient_id,
        schedule_kind,
        run_at,
        daily_time,
        interval_minutes,
        instruction,
        active,
        last_ran_at,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @schedulerJobName,
        @channel,
        @recipientId,
        @scheduleKind,
        @runAt,
        @dailyTime,
        @intervalMinutes,
        @instruction,
        1,
        NULL,
        @now,
        @now
      )
    `
  ).run({
    id,
    schedulerJobName: input.schedulerJobName,
    channel: input.channel,
    recipientId: input.recipientId,
    scheduleKind: input.scheduleKind,
    runAt: input.runAt ?? null,
    dailyTime: input.dailyTime ?? null,
    intervalMinutes: input.intervalMinutes ?? null,
    instruction: input.instruction,
    now,
  });

  const created = getScheduledTaskById(id);
  if (!created) {
    throw new Error('Failed to create scheduled task');
  }
  return created;
}

export function listActiveScheduledTasks(): ScheduledTaskRecord[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
      SELECT
        id,
        scheduler_job_name AS schedulerJobName,
        channel,
        recipient_id AS recipientId,
        schedule_kind AS scheduleKind,
        run_at AS runAt,
        daily_time AS dailyTime,
        interval_minutes AS intervalMinutes,
        instruction,
        active,
        last_ran_at AS lastRanAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM scheduled_tasks
      WHERE active = 1
      ORDER BY created_at DESC
    `
    )
    .all() as Array<Parameters<typeof mapRow>[0]>;
  return rows.map(mapRow);
}

export function listScheduledTasksByRecipient(params: {
  channel: string;
  recipientId: string;
}): ScheduledTaskRecord[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
      SELECT
        id,
        scheduler_job_name AS schedulerJobName,
        channel,
        recipient_id AS recipientId,
        schedule_kind AS scheduleKind,
        run_at AS runAt,
        daily_time AS dailyTime,
        interval_minutes AS intervalMinutes,
        instruction,
        active,
        last_ran_at AS lastRanAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM scheduled_tasks
      WHERE channel = @channel
        AND recipient_id = @recipientId
      ORDER BY created_at DESC
    `
    )
    .all({ channel: params.channel, recipientId: params.recipientId }) as Array<Parameters<typeof mapRow>[0]>;
  return rows.map(mapRow);
}

export function getScheduledTaskById(id: string): ScheduledTaskRecord | null {
  const db = openDatabase();
  const row = db
    .prepare(
      `
      SELECT
        id,
        scheduler_job_name AS schedulerJobName,
        channel,
        recipient_id AS recipientId,
        schedule_kind AS scheduleKind,
        run_at AS runAt,
        daily_time AS dailyTime,
        interval_minutes AS intervalMinutes,
        instruction,
        active,
        last_ran_at AS lastRanAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM scheduled_tasks
      WHERE id = @id
      LIMIT 1
    `
    )
    .get({ id }) as Parameters<typeof mapRow>[0] | undefined;
  return row ? mapRow(row) : null;
}

export function markScheduledTaskRan(id: string, atIso?: string): void {
  const db = openDatabase();
  const now = atIso ?? new Date().toISOString();
  db.prepare(
    `
      UPDATE scheduled_tasks
      SET
        last_ran_at = @now,
        updated_at = @now
      WHERE id = @id
    `
  ).run({ id, now });
}

export function deactivateScheduledTask(id: string): boolean {
  const db = openDatabase();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `
      UPDATE scheduled_tasks
      SET
        active = 0,
        updated_at = @now
      WHERE id = @id
        AND active = 1
    `
    )
    .run({ id, now });
  return result.changes > 0;
}
