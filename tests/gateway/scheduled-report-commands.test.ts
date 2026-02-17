import { describe, expect, it } from 'vitest';

import {
  formatScheduledReportHelp,
  parseScheduledReportAction,
} from '../../src/gateway/scheduled_report_commands.js';

describe('scheduled report command parsing', () => {
  it('parses one-time command schedule', () => {
    const nowMs = Date.parse('2026-02-17T20:00:00.000Z');
    const action = parseScheduledReportAction('/schedule_report tomorrow 9:45am', nowMs);
    expect(action.kind).toBe('create');
    if (action.kind !== 'create') return;
    expect(action.scheduleKind).toBe('once');
    expect(action.runAtIso).toBe('2026-02-18T09:45:00.000Z');
  });

  it('parses daily and interval schedules', () => {
    const daily = parseScheduledReportAction('/schedule_report daily 09:45');
    expect(daily).toMatchObject({ kind: 'create', scheduleKind: 'daily', dailyTime: '09:45' });

    const interval = parseScheduledReportAction('/schedule_report every 30m');
    expect(interval).toMatchObject({ kind: 'create', scheduleKind: 'interval', intervalMinutes: 30 });
  });

  it('parses list and cancel commands', () => {
    expect(parseScheduledReportAction('/scheduled_reports')).toEqual({ kind: 'list' });
    expect(parseScheduledReportAction('/unschedule_report abc123')).toEqual({ kind: 'cancel', id: 'abc123' });
  });

  it('detects natural-language scheduling intent for reports', () => {
    const nowMs = Date.parse('2026-02-17T20:00:00.000Z');
    const action = parseScheduledReportAction('My dude, I want it a 9:45 AM tomorrow report', nowMs);
    expect(action.kind).toBe('create');
    if (action.kind !== 'create') return;
    expect(action.source).toBe('natural');
    expect(action.runAtIso).toBe('2026-02-18T09:45:00.000Z');
  });

  it('returns help for ambiguous scheduling requests', () => {
    const action = parseScheduledReportAction('send me report tomorrow morning');
    expect(action.kind).toBe('schedule_intent_without_parse');
  });

  it('includes command usage in help text', () => {
    const help = formatScheduledReportHelp();
    expect(help).toContain('/schedule_report tomorrow 9:45am');
    expect(help).toContain('/unschedule_report <id>');
  });
});
