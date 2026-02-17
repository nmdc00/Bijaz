export type ScheduledReportAction =
  | {
      kind: 'create';
      scheduleKind: 'once' | 'daily' | 'interval';
      runAtIso?: string;
      dailyTime?: string;
      intervalMinutes?: number;
      source: 'command' | 'natural';
    }
  | { kind: 'list' }
  | { kind: 'cancel'; id: string }
  | { kind: 'help' }
  | { kind: 'none' }
  | { kind: 'schedule_intent_without_parse' };

function parseHm24(input: string): string | null {
  const match = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function parseHm12(input: string): { hours: number; minutes: number } | null {
  const match = input
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!match) return null;
  const rawHours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  const meridian = match[3];
  if (!Number.isInteger(rawHours) || !Number.isInteger(minutes)) return null;
  if (rawHours < 1 || rawHours > 12 || minutes < 0 || minutes > 59) return null;
  let hours = rawHours % 12;
  if (meridian === 'pm') hours += 12;
  return { hours, minutes };
}

function parseNaturalTime(text: string): { hours: number; minutes: number } | null {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  return parseHm12(`${m[1]}:${m[2] ?? '00'}${m[3]}`);
}

function buildRunAtIso(params: { day: 'today' | 'tomorrow'; hours: number; minutes: number; nowMs?: number }): string {
  const now = new Date(params.nowMs ?? Date.now());
  const target = new Date(now);
  target.setUTCHours(params.hours, params.minutes, 0, 0);
  if (params.day === 'tomorrow' || target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.toISOString();
}

export function parseScheduledReportAction(input: string, nowMs?: number): ScheduledReportAction {
  const text = input.trim();
  const lower = text.toLowerCase();

  if (lower === '/scheduled_reports' || lower === '/scheduled') {
    return { kind: 'list' };
  }

  if (lower === '/schedule_report' || lower === '/schedule_report help' || lower === '/schedule_report ?') {
    return { kind: 'help' };
  }

  if (lower.startsWith('/unschedule_report')) {
    const parts = text.split(/\s+/);
    const id = parts[1]?.trim();
    if (!id) return { kind: 'help' };
    return { kind: 'cancel', id };
  }

  if (lower.startsWith('/schedule_report')) {
    const body = text.replace(/^\/schedule_report\s*/i, '').trim();
    if (!body) return { kind: 'help' };

    const everyMatch = body.match(/^every\s+(\d+)\s*([mh])$/i);
    if (everyMatch) {
      const amount = Number(everyMatch[1]);
      const unit = everyMatch[2]?.toLowerCase();
      if (!Number.isInteger(amount) || amount <= 0) return { kind: 'help' };
      const intervalMinutes = unit === 'h' ? amount * 60 : amount;
      return {
        kind: 'create',
        scheduleKind: 'interval',
        intervalMinutes,
        source: 'command',
      };
    }

    const dailyMatch = body.match(/^daily\s+(.+)$/i);
    if (dailyMatch) {
      const hm = parseHm24(dailyMatch[1]!.trim());
      if (!hm) return { kind: 'help' };
      return { kind: 'create', scheduleKind: 'daily', dailyTime: hm, source: 'command' };
    }

    const tomorrowMatch = body.match(/^(tomorrow|today)\s+(.+)$/i);
    if (tomorrowMatch) {
      const day = tomorrowMatch[1]!.toLowerCase() as 'today' | 'tomorrow';
      const parsed12 = parseHm12(tomorrowMatch[2]!.trim());
      if (!parsed12) return { kind: 'help' };
      return {
        kind: 'create',
        scheduleKind: 'once',
        runAtIso: buildRunAtIso({ day, hours: parsed12.hours, minutes: parsed12.minutes, nowMs }),
        source: 'command',
      };
    }

    return { kind: 'help' };
  }

  const mentionsReport = /\b(report|snapshot|status)\b/i.test(text);
  const mentionsTimeIntent = /\b(tomorrow|today)\b/i.test(text);
  if (!mentionsReport || !mentionsTimeIntent) {
    return { kind: 'none' };
  }

  const dayMatch = text.match(/\b(tomorrow|today)\b/i);
  const time = parseNaturalTime(text);
  if (!dayMatch || !time) {
    return { kind: 'schedule_intent_without_parse' };
  }

  return {
    kind: 'create',
    scheduleKind: 'once',
    runAtIso: buildRunAtIso({
      day: dayMatch[1]!.toLowerCase() as 'today' | 'tomorrow',
      hours: time.hours,
      minutes: time.minutes,
      nowMs,
    }),
    source: 'natural',
  };
}

export function formatScheduledReportHelp(): string {
  return [
    'Scheduled reports commands:',
    '- /schedule_report tomorrow 9:45am',
    '- /schedule_report daily 09:45',
    '- /schedule_report every 30m',
    '- /scheduled_reports',
    '- /unschedule_report <id>',
    '',
    'Notes: times are interpreted in UTC by default.',
  ].join('\n');
}
