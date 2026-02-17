import { describe, expect, it } from 'vitest';

import {
  formatScheduledTaskHelp,
  parseScheduledTaskAction,
} from '../../src/gateway/scheduled_task_commands.js';

describe('scheduled task command parsing', () => {
  it('parses one-time command schedule with instruction', () => {
    const nowMs = Date.parse('2026-02-17T20:00:00.000Z');
    const action = parseScheduledTaskAction('/schedule tomorrow 9:45am | send report', nowMs);
    expect(action.kind).toBe('create');
    if (action.kind !== 'create') return;
    expect(action.scheduleKind).toBe('once');
    expect(action.runAtIso).toBe('2026-02-18T09:45:00.000Z');
    expect(action.instruction).toBe('send report');
  });

  it('parses daily and interval schedules with instruction', () => {
    const daily = parseScheduledTaskAction('/schedule daily 09:45 | run status');
    expect(daily).toMatchObject({ kind: 'create', scheduleKind: 'daily', dailyTime: '09:45', instruction: 'run status' });

    const interval = parseScheduledTaskAction('/schedule every 30m | monitor risk');
    expect(interval).toMatchObject({ kind: 'create', scheduleKind: 'interval', intervalMinutes: 30, instruction: 'monitor risk' });

    const relative = parseScheduledTaskAction('/schedule in 30s | send status', Date.parse('2026-02-17T20:00:00.000Z'));
    expect(relative.kind).toBe('create');
    if (relative.kind !== 'create') return;
    expect(relative.scheduleKind).toBe('once');
    expect(relative.runAtIso).toBe('2026-02-17T20:00:30.000Z');
    expect(relative.instruction).toBe('send status');
  });

  it('parses list and cancel commands', () => {
    expect(parseScheduledTaskAction('/scheduled_tasks')).toEqual({ kind: 'list' });
    expect(parseScheduledTaskAction('/unschedule_task abc123')).toEqual({ kind: 'cancel', id: 'abc123' });
  });

  it('detects natural-language scheduling intent for generic tasks', () => {
    const nowMs = Date.parse('2026-02-17T20:00:00.000Z');
    const action = parseScheduledTaskAction('at 9:45 AM tomorrow send me today activity and full pnl snapshot', nowMs);
    expect(action.kind).toBe('create');
    if (action.kind !== 'create') return;
    expect(action.source).toBe('natural');
    expect(action.runAtIso).toBe('2026-02-18T09:45:00.000Z');
    expect(action.instruction.toLowerCase()).toContain('send me');

    const relative = parseScheduledTaskAction('in 30 seconds send me a status update', nowMs);
    expect(relative.kind).toBe('create');
    if (relative.kind !== 'create') return;
    expect(relative.runAtIso).toBe('2026-02-17T20:00:30.000Z');
  });

  it('returns help for ambiguous scheduling requests', () => {
    const action = parseScheduledTaskAction('schedule something for tomorrow');
    expect(action.kind).toBe('schedule_intent_without_parse');
  });

  it('includes command usage in help text', () => {
    const help = formatScheduledTaskHelp();
    expect(help).toContain('/schedule tomorrow 9:45am | <task instruction>');
    expect(help).toContain('/schedule in 30s | send status');
    expect(help).toContain('/scheduled_tasks');
    expect(help).toContain('/unschedule_task <id>');
  });
});
