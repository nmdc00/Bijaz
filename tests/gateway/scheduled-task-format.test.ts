import { describe, expect, it } from 'vitest';

import {
  buildScheduledTaskInstruction,
  describeSchedule,
  formatScheduleTarget,
  formatUtcDateTime,
  isBriefingLikeInstruction,
} from '../../src/gateway/scheduled_task_format.js';

describe('scheduled task formatting', () => {
  it('formats valid UTC timestamps into readable output', () => {
    const formatted = formatUtcDateTime('2026-02-18T09:45:00.000Z');
    expect(formatted).toContain('2026');
    expect(formatted).toContain('09:45:00');
    expect(formatted.endsWith('UTC')).toBe(true);
  });

  it('falls back to raw value for invalid timestamps', () => {
    expect(formatUtcDateTime('not-a-date')).toBe('not-a-date (UTC)');
  });

  it('describes one-time schedules with readable UTC time', () => {
    const text = describeSchedule({
      scheduleKind: 'once',
      runAt: '2026-02-18T09:45:00.000Z',
      dailyTime: null,
      intervalMinutes: null,
    });
    expect(text).toMatch(/^once at .*UTC$/);
    expect(text).toContain('09:45:00');
  });

  it('formats schedule target for daily and interval schedules', () => {
    expect(
      formatScheduleTarget({
        scheduleKind: 'daily',
        runAt: null,
        dailyTime: '09:45',
        intervalMinutes: null,
      })
    ).toBe('09:45 UTC (daily)');

    expect(
      formatScheduleTarget({
        scheduleKind: 'interval',
        runAt: null,
        dailyTime: null,
        intervalMinutes: 30,
      })
    ).toBe('every 30 minute(s)');
  });

  it('detects briefing-like instructions', () => {
    expect(isBriefingLikeInstruction('send full portfolio and pnl briefing')).toBe(true);
    expect(isBriefingLikeInstruction('say hello')).toBe(false);
  });

  it('injects structured output template for briefing-like scheduled tasks', () => {
    const instruction = buildScheduledTaskInstruction({
      scheduleKind: 'once',
      runAt: '2026-02-18T09:45:00.000Z',
      dailyTime: null,
      intervalMinutes: null,
      instruction: 'monitor portfolio and send detailed pnl report',
    });

    expect(instruction).toContain('Scheduled delivery context:');
    expect(instruction).toContain('scheduled_for_utc="');
    expect(instruction).toContain('1) Snapshot Time');
    expect(instruction).toContain('5) Actions / Next Checks');
    expect(instruction).toContain('Task: monitor portfolio and send detailed pnl report');
  });

  it('leaves non-briefing scheduled instructions unchanged', () => {
    const raw = 'ping me when done';
    const instruction = buildScheduledTaskInstruction({
      scheduleKind: 'once',
      runAt: '2026-02-18T09:45:00.000Z',
      dailyTime: null,
      intervalMinutes: null,
      instruction: raw,
    });
    expect(instruction).toBe(raw);
  });
});
