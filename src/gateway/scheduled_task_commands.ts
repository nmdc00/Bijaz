export type ScheduledTaskAction =
  | {
      kind: 'create';
      scheduleKind: 'once' | 'daily' | 'interval';
      runAtIso?: string;
      dailyTime?: string;
      intervalMinutes?: number;
      instruction: string;
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

function buildRunAtFromDelay(params: { delayMs: number; nowMs?: number }): string {
  const base = params.nowMs ?? Date.now();
  return new Date(base + Math.max(1_000, Math.floor(params.delayMs))).toISOString();
}

function parseDelayMs(input: string): number | null {
  const normalized = input.trim().toLowerCase();
  const compact = normalized.match(/^in\s+(\d+)\s*([smh])$/);
  if (compact) {
    const amount = Number(compact[1]);
    const unit = compact[2];
    if (!Number.isInteger(amount) || amount <= 0) return null;
    if (unit === 's') return amount * 1000;
    if (unit === 'm') return amount * 60 * 1000;
    return amount * 60 * 60 * 1000;
  }
  const verbose = normalized.match(/^in\s+(\d+)\s*(seconds?|minutes?|hours?)$/);
  if (!verbose) return null;
  const amount = Number(verbose[1]);
  const unit = verbose[2] ?? '';
  if (!Number.isInteger(amount) || amount <= 0) return null;
  if (unit.startsWith('second')) return amount * 1000;
  if (unit.startsWith('minute')) return amount * 60 * 1000;
  return amount * 60 * 60 * 1000;
}

function normalizeInstruction(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function parseScheduleBodyWithInstruction(
  body: string,
  nowMs?: number
): Omit<Extract<ScheduledTaskAction, { kind: 'create' }>, 'kind' | 'source'> | null {
  const parts = body.split('|');
  if (parts.length < 2) return null;
  const schedulePart = parts[0]?.trim() ?? '';
  const instructionPart = normalizeInstruction(parts.slice(1).join('|'));
  if (!instructionPart) return null;

  const everyMatch = schedulePart.match(/^every\s+(\d+)\s*([mh])$/i);
  if (everyMatch) {
    const amount = Number(everyMatch[1]);
    const unit = everyMatch[2]?.toLowerCase();
    if (!Number.isInteger(amount) || amount <= 0) return null;
    const intervalMinutes = unit === 'h' ? amount * 60 : amount;
    return {
      scheduleKind: 'interval',
      intervalMinutes,
      instruction: instructionPart,
    };
  }

  const delayMs = parseDelayMs(schedulePart);
  if (delayMs != null) {
    return {
      scheduleKind: 'once',
      runAtIso: buildRunAtFromDelay({ delayMs, nowMs }),
      instruction: instructionPart,
    };
  }

  const dailyMatch = schedulePart.match(/^daily\s+(.+)$/i);
  if (dailyMatch) {
    const hm = parseHm24(dailyMatch[1]!.trim());
    if (!hm) return null;
    return { scheduleKind: 'daily', dailyTime: hm, instruction: instructionPart };
  }

  const onceMatch = schedulePart.match(/^(tomorrow|today)\s+(.+)$/i);
  if (onceMatch) {
    const day = onceMatch[1]!.toLowerCase() as 'today' | 'tomorrow';
    const parsed12 = parseHm12(onceMatch[2]!.trim());
    if (!parsed12) return null;
    return {
      scheduleKind: 'once',
      runAtIso: buildRunAtIso({ day, hours: parsed12.hours, minutes: parsed12.minutes, nowMs }),
      instruction: instructionPart,
    };
  }

  return null;
}

function parseNaturalScheduleInstruction(
  text: string,
  nowMs?: number
): Omit<Extract<ScheduledTaskAction, { kind: 'create' }>, 'kind' | 'source'> | null {
  const rel = text.match(/\bin\s+(\d+)\s*(s|m|h|seconds?|minutes?|hours?)\b/i);
  if (rel) {
    const delayMs = parseDelayMs(`in ${rel[1]} ${rel[2]}`);
    if (delayMs != null) {
      const instruction = normalizeInstruction(
        text
          .replace(/\bin\s+\d+\s*(s|m|h|seconds?|minutes?|hours?)\b/gi, '')
          .replace(/\b(at|on|for|please|my dude|i want|schedule|set|to run|from now)\b/gi, '')
      );
      if (instruction && instruction.length >= 5) {
        return {
          scheduleKind: 'once',
          runAtIso: buildRunAtFromDelay({ delayMs, nowMs }),
          instruction,
        };
      }
    }
  }

  const dayMatch = text.match(/\b(tomorrow|today)\b/i);
  const time = parseNaturalTime(text);
  if (!dayMatch || !time) return null;
  const day = dayMatch[1]!.toLowerCase() as 'today' | 'tomorrow';

  const instruction = normalizeInstruction(
    text
      .replace(/\b(tomorrow|today)\b/gi, '')
      .replace(/\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/gi, '')
      .replace(/\b(at|on|for|please|my dude|i want|schedule|set|to run)\b/gi, '')
  );

  if (!instruction || instruction.length < 5) {
    return null;
  }

  return {
    scheduleKind: 'once',
    runAtIso: buildRunAtIso({ day, hours: time.hours, minutes: time.minutes, nowMs }),
    instruction,
  };
}

export function parseScheduledTaskAction(input: string, nowMs?: number): ScheduledTaskAction {
  const text = input.trim();
  const lower = text.toLowerCase();

  if (['/scheduled_tasks', '/scheduled', '/scheduled_reports'].includes(lower)) {
    return { kind: 'list' };
  }

  if (
    lower === '/schedule' ||
    lower === '/schedule ?' ||
    lower === '/schedule help' ||
    lower === '/schedule_task' ||
    lower === '/schedule_report'
  ) {
    return { kind: 'help' };
  }

  if (lower.startsWith('/unschedule_task') || lower.startsWith('/unschedule_report')) {
    const parts = text.split(/\s+/);
    const id = parts[1]?.trim();
    if (!id) return { kind: 'help' };
    return { kind: 'cancel', id };
  }

  if (
    lower.startsWith('/schedule ') ||
    lower.startsWith('/schedule_task ') ||
    lower.startsWith('/schedule_report ')
  ) {
    const body = text
      .replace(/^\/schedule(_task|_report)?\s*/i, '')
      .trim();
    if (!body) return { kind: 'help' };
    const parsed = parseScheduleBodyWithInstruction(body, nowMs);
    if (!parsed) return { kind: 'help' };
    return {
      kind: 'create',
      ...parsed,
      source: 'command',
    };
  }

  const hasTemporalCue =
    /\b(tomorrow|today)\b/i.test(text) ||
    /\bin\s+\d+\s*(s|m|h|seconds?|minutes?|hours?)\b/i.test(text);
  const hasSchedCue = /\b(at|schedule|remind|run|send|deliver|do)\b/i.test(text);
  if (!hasTemporalCue || !hasSchedCue) {
    return { kind: 'none' };
  }

  const parsedNatural = parseNaturalScheduleInstruction(text, nowMs);
  if (!parsedNatural) {
    return { kind: 'schedule_intent_without_parse' };
  }

  return {
    kind: 'create',
    ...parsedNatural,
    source: 'natural',
  };
}

export function formatScheduledTaskHelp(): string {
  return [
    'Scheduled task commands:',
    '- /schedule tomorrow 9:45am | <task instruction>',
    '- /schedule daily 09:45 | <task instruction>',
    '- /schedule every 30m | <task instruction>',
    '- /scheduled_tasks',
    '- /unschedule_task <id>',
    '',
    'Examples:',
    '- /schedule tomorrow 9:45am | send today\'s activity and full PnL + risk snapshot',
    '- /schedule in 30s | send status',
    '- /schedule daily 09:45 | run status, check risk limits, and notify me of required actions',
    '',
    'Notes: times are interpreted in UTC by default.',
  ].join('\n');
}
