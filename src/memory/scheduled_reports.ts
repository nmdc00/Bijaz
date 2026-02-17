import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export type ScheduledReportKind = 'once' | 'daily' | 'interval';

export interface ScheduledReportRecord {
  id: string;
  schedulerJobName: string;
  channel: string;
  recipientId: string;
  scheduleKind: ScheduledReportKind;
  runAt: string | null;
  dailyTime: string | null;
  intervalMinutes: number | null;
  active: boolean;
  lastSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledReportInput {
  schedulerJobName: string;
  channel: string;
  recipientId: string;
  scheduleKind: ScheduledReportKind;
  runAt?: string | null;
  dailyTime?: string | null;
  intervalMinutes?: number | null;
}

function mapRow(row: {
  id: string;
  schedulerJobName: string;
  channel: string;
  recipientId: string;
  scheduleKind: ScheduledReportKind;
  runAt: string | null;
  dailyTime: string | null;
  intervalMinutes: number | null;
  active: number;
  lastSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}): ScheduledReportRecord {
  return {
    id: row.id,
    schedulerJobName: row.schedulerJobName,
    channel: row.channel,
    recipientId: row.recipientId,
    scheduleKind: row.scheduleKind,
    runAt: row.runAt,
    dailyTime: row.dailyTime,
    intervalMinutes: row.intervalMinutes,
    active: row.active === 1,
    lastSentAt: row.lastSentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createScheduledReport(input: CreateScheduledReportInput): ScheduledReportRecord {
  const db = openDatabase();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO scheduled_reports (
        id,
        scheduler_job_name,
        channel,
        recipient_id,
        schedule_kind,
        run_at,
        daily_time,
        interval_minutes,
        active,
        last_sent_at,
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
    now,
  });

  const created = getScheduledReportById(id);
  if (!created) {
    throw new Error('Failed to create scheduled report');
  }
  return created;
}

export function listActiveScheduledReports(): ScheduledReportRecord[] {
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
        active,
        last_sent_at AS lastSentAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM scheduled_reports
      WHERE active = 1
      ORDER BY created_at DESC
    `
    )
    .all() as Array<Parameters<typeof mapRow>[0]>;
  return rows.map(mapRow);
}

export function listScheduledReportsByRecipient(params: {
  channel: string;
  recipientId: string;
}): ScheduledReportRecord[] {
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
        active,
        last_sent_at AS lastSentAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM scheduled_reports
      WHERE channel = @channel
        AND recipient_id = @recipientId
      ORDER BY created_at DESC
    `
    )
    .all({ channel: params.channel, recipientId: params.recipientId }) as Array<Parameters<typeof mapRow>[0]>;
  return rows.map(mapRow);
}

export function getScheduledReportById(id: string): ScheduledReportRecord | null {
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
        active,
        last_sent_at AS lastSentAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM scheduled_reports
      WHERE id = @id
      LIMIT 1
    `
    )
    .get({ id }) as Parameters<typeof mapRow>[0] | undefined;
  return row ? mapRow(row) : null;
}

export function markScheduledReportSent(id: string, atIso?: string): void {
  const db = openDatabase();
  const now = atIso ?? new Date().toISOString();
  db.prepare(
    `
      UPDATE scheduled_reports
      SET
        last_sent_at = @now,
        updated_at = @now
      WHERE id = @id
    `
  ).run({ id, now });
}

export function deactivateScheduledReport(id: string): boolean {
  const db = openDatabase();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `
      UPDATE scheduled_reports
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
