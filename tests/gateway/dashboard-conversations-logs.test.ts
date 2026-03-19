import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildConversationThreadResponse,
  buildConversationsListResponse,
  buildDashboardLogsResponse,
  handleDashboardApiRequest,
} from '../../src/gateway/dashboard_api.js';
import { storeChatMessage } from '../../src/memory/chat.js';
import { openDatabase } from '../../src/memory/db.js';
import { recordDecisionAudit } from '../../src/memory/decision_audit.js';
import { recordAgentIncident } from '../../src/memory/incidents.js';

describe('dashboard conversations and logs api', () => {
  let dbPath: string | null = null;
  let dbDir: string | null = null;
  const originalDbPath = process.env.THUFIR_DB_PATH;

  afterEach(() => {
    process.env.THUFIR_DB_PATH = originalDbPath;
    if (dbPath) {
      rmSync(dbPath, { force: true });
      dbPath = null;
    }
    if (dbDir) {
      rmSync(dbDir, { recursive: true, force: true });
      dbDir = null;
    }
  });

  function createDb(prefix: string) {
    dbDir = mkdtempSync(join(tmpdir(), prefix));
    dbPath = join(dbDir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    return openDatabase(dbPath);
  }

  it('returns session list newest first and excludes system messages from counts', () => {
    const db = createDb('thufir-dashboard-conversations-');
    storeChatMessage({
      sessionId: 'session-a',
      role: 'user',
      content: 'First user message that should be truncated only when necessary.',
      createdAt: '2026-03-10T10:00:00.000Z',
    });
    storeChatMessage({
      sessionId: 'session-a',
      role: 'assistant',
      content: 'Assistant reply',
      createdAt: '2026-03-10T10:01:00.000Z',
    });
    storeChatMessage({
      sessionId: 'session-a',
      role: 'system',
      content: 'System hidden message',
      createdAt: '2026-03-10T10:02:00.000Z',
    });
    storeChatMessage({
      sessionId: 'session-b',
      role: 'user',
      content: 'Newest session starter',
      createdAt: '2026-03-11T08:00:00.000Z',
    });

    const payload = buildConversationsListResponse({ db });
    expect(payload.sessions.map((item) => item.sessionId)).toEqual(['session-b', 'session-a']);
    expect(payload.sessions[1]?.messageCount).toBe(2);
    expect(payload.sessions[1]?.firstMessage).toContain('First user message');
  });

  it('excludes internal heartbeat sessions from the dashboard conversation list', () => {
    const db = createDb('thufir-dashboard-conversations-heartbeat-');
    storeChatMessage({
      sessionId: '__heartbeat__',
      role: 'user',
      content: 'Read HEARTBEAT.md',
      createdAt: '2026-03-12T12:00:00.000Z',
    });
    storeChatMessage({
      sessionId: '__heartbeat__',
      role: 'assistant',
      content: 'HEARTBEAT_OK',
      createdAt: '2026-03-12T12:00:01.000Z',
    });
    storeChatMessage({
      sessionId: 'session-real',
      role: 'user',
      content: 'Is there any news that would cause oil price to rise further?',
      createdAt: '2026-03-12T12:01:00.000Z',
    });

    const payload = buildConversationsListResponse({ db });
    expect(payload.sessions.map((item) => item.sessionId)).toEqual(['session-real']);
  });

  it('returns thread messages in ascending order and filters out system messages', () => {
    const db = createDb('thufir-dashboard-thread-');
    storeChatMessage({
      sessionId: 'session-c',
      role: 'system',
      content: 'Hidden system prompt',
      createdAt: '2026-03-10T09:59:00.000Z',
    });
    const firstId = storeChatMessage({
      sessionId: 'session-c',
      role: 'user',
      content: 'What is happening?',
      createdAt: '2026-03-10T10:00:00.000Z',
    });
    const secondId = storeChatMessage({
      sessionId: 'session-c',
      role: 'assistant',
      content: 'Here is the explanation.',
      createdAt: '2026-03-10T10:01:00.000Z',
    });

    const payload = buildConversationThreadResponse('session-c', { db });
    expect(payload.messages.map((item) => item.id)).toEqual([firstId, secondId]);
    expect(payload.messages.map((item) => item.role)).toEqual(['user', 'assistant']);
  });

  it('returns only the latest 50 messages from a long thread', () => {
    const db = createDb('thufir-dashboard-thread-limit-');
    const expectedContents: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const content = `message-${index}`;
      storeChatMessage({
        sessionId: 'session-limit',
        role: index % 2 === 0 ? 'user' : 'assistant',
        content,
        createdAt: `2026-03-10T10:${String(index).padStart(2, '0')}:00.000Z`,
      });
      if (index >= 10) {
        expectedContents.push(content);
      }
    }

    const payload = buildConversationThreadResponse('session-limit', { db, limit: 50 });
    expect(payload.messages).toHaveLength(50);
    expect(payload.messages.map((item) => item.content)).toEqual(expectedContents);
  });

  it('preserves insertion order when multiple messages share the same timestamp', () => {
    const db = createDb('thufir-dashboard-thread-order-');
    storeChatMessage({
      sessionId: 'session-same-ts',
      role: 'user',
      content: 'first',
      createdAt: '2026-03-10T10:00:00.000Z',
    });
    storeChatMessage({
      sessionId: 'session-same-ts',
      role: 'assistant',
      content: 'second',
      createdAt: '2026-03-10T10:00:00.000Z',
    });
    storeChatMessage({
      sessionId: 'session-same-ts',
      role: 'user',
      content: 'third',
      createdAt: '2026-03-10T10:00:00.000Z',
    });

    const payload = buildConversationThreadResponse('session-same-ts', { db, limit: 50 });
    expect(payload.messages.map((item) => item.content)).toEqual(['first', 'second', 'third']);
  });

  it('strips identity intro from assistant messages in conversation thread', () => {
    const db = createDb('thufir-dashboard-thread-strip-');
    storeChatMessage({
      sessionId: 'session-strip',
      role: 'user',
      content: 'Hello',
      createdAt: '2026-03-10T10:00:00.000Z',
    });
    storeChatMessage({
      sessionId: 'session-strip',
      role: 'assistant',
      content: "I'm Thufir Hawat.\nHere is the market update.",
      createdAt: '2026-03-10T10:01:00.000Z',
    });
    storeChatMessage({
      sessionId: 'session-strip',
      role: 'assistant',
      content: 'I am Thufir Hawat. Let me check that for you.',
      createdAt: '2026-03-10T10:02:00.000Z',
    });

    const payload = buildConversationThreadResponse('session-strip', { db });
    const assistant = payload.messages.filter((m) => m.role === 'assistant');
    expect(assistant[0]!.content).toBe('Here is the market update.');
    expect(assistant[1]!.content).toBe('Let me check that for you.');
  });

  it('returns merged decision and incident log entries with parsed tool traces', () => {
    const db = createDb('thufir-dashboard-logs-');
    recordDecisionAudit({
      source: 'heartbeat',
      sessionId: 'session-z',
      marketId: 'BTC',
      tradeAction: 'open_long',
      confidence: 0.71,
      edge: 0.042,
      criticApproved: true,
      toolCalls: 2,
      iterations: 1,
      toolTrace: [
        {
          toolName: 'perp_market_data',
          input: { symbol: 'BTC' },
          success: true,
        },
      ],
      planTrace: { plan: 'test' },
      notes: { why: 'edge' },
    });
    recordAgentIncident({
      goal: 'place order',
      toolName: 'perp_open_position',
      error: 'insufficient margin',
      blockerKind: 'hyperliquid_insufficient_collateral',
      details: { freeCollateral: 10 },
    });

    const payload = buildDashboardLogsResponse({ db, kind: 'all', limit: 10, offset: 0 });
    expect(payload.total).toBe(2);
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries.some((entry) => entry.kind === 'decision')).toBe(true);
    expect(payload.entries.some((entry) => entry.kind === 'incident')).toBe(true);
    const decision = payload.entries.find((entry) => entry.kind === 'decision');
    expect(decision && decision.kind === 'decision' ? decision.toolTrace[0]?.toolName : null).toBe('perp_market_data');
  });

  it('filters logs by kind and paginates results', () => {
    const db = createDb('thufir-dashboard-logs-filter-');
    recordDecisionAudit({ source: 'a', toolTrace: [] });
    recordDecisionAudit({ source: 'b', toolTrace: [] });
    recordAgentIncident({ error: 'problem' });

    const decisionsOnly = buildDashboardLogsResponse({ db, kind: 'decision', limit: 1, offset: 1 });
    expect(decisionsOnly.total).toBe(2);
    expect(decisionsOnly.entries).toHaveLength(1);
    expect(decisionsOnly.entries[0]?.kind).toBe('decision');

    const incidentsOnly = buildDashboardLogsResponse({ db, kind: 'incident', limit: 10, offset: 0 });
    expect(incidentsOnly.total).toBe(1);
    expect(incidentsOnly.entries).toHaveLength(1);
    expect(incidentsOnly.entries[0]?.kind).toBe('incident');
  });

  it('handles conversation and logs routes', () => {
    createDb('thufir-dashboard-routes-');
    const req = {
      method: 'GET',
      url: '/api/logs?kind=all&limit=50',
      headers: { host: 'localhost:18789' },
    } as any;
    const state: { status?: number; body?: string } = {};
    const res = {
      writeHead: (status: number) => {
        state.status = status;
      },
      end: (body?: string) => {
        state.body = body;
      },
    } as any;

    const handled = handleDashboardApiRequest(req, res);
    expect(handled).toBe(true);
    expect(state.status).toBe(200);
    expect(JSON.parse(String(state.body))).toEqual({ entries: [], total: 0 });
  });
});
