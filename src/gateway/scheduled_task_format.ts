export interface ScheduledTaskFormatRecord {
  scheduleKind: 'once' | 'daily' | 'interval';
  runAt: string | null;
  dailyTime: string | null;
  intervalMinutes: number | null;
}

export function formatUtcDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return `${iso} (UTC)`;
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return `${fmt.format(new Date(ms))} UTC`;
}

export function describeSchedule(rec: ScheduledTaskFormatRecord): string {
  if (rec.scheduleKind === 'once') {
    return rec.runAt ? `once at ${formatUtcDateTime(rec.runAt)}` : 'once';
  }
  if (rec.scheduleKind === 'daily') {
    return `daily at ${rec.dailyTime ?? '??:??'} (UTC)`;
  }
  return `every ${rec.intervalMinutes ?? 0} minute(s)`;
}

export function formatScheduleTarget(rec: ScheduledTaskFormatRecord): string {
  if (rec.scheduleKind === 'once') {
    return rec.runAt ? formatUtcDateTime(rec.runAt) : 'once';
  }
  if (rec.scheduleKind === 'daily') {
    return `${rec.dailyTime ?? '??:??'} UTC (daily)`;
  }
  return `every ${rec.intervalMinutes ?? 0} minute(s)`;
}

export function isBriefingLikeInstruction(instruction: string): boolean {
  return /\b(brief|briefing|report|portfolio|pnl|trade|position|risk)\b/i.test(instruction);
}

export function buildScheduledTaskInstruction(
  rec: ScheduledTaskFormatRecord & { instruction: string }
): string {
  const scheduledFor = formatScheduleTarget(rec);
  if (!isBriefingLikeInstruction(rec.instruction)) {
    return rec.instruction;
  }
  return [
    `Scheduled delivery context: scheduled_for_utc="${scheduledFor}"`,
    'Output format (keep concise, plain text, no markdown tables):',
    '1) Snapshot Time',
    '2) Portfolio + PnL',
    '3) Open Positions + Risk',
    '4) Trades Since Last Update',
    '5) Actions / Next Checks',
    `Task: ${rec.instruction}`,
  ].join('\n');
}
