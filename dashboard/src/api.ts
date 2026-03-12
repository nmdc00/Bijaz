import type {
  ConversationsListResponse,
  ConversationThreadResponse,
  DashboardMode,
  DashboardPayload,
  DashboardTimeframe,
  LogsResponse,
} from './types';

export type DashboardQuery = {
  mode: DashboardMode;
  timeframe: DashboardTimeframe;
  period: string;
  from: string;
  to: string;
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function buildDashboardQuery(query: DashboardQuery): string {
  const params = new URLSearchParams();
  params.set('mode', query.mode);
  params.set('timeframe', query.timeframe);
  if (query.timeframe === 'period') {
    params.set('period', query.period);
  }
  if (query.timeframe === 'custom') {
    if (query.from) {
      params.set('from', new Date(query.from).toISOString());
    }
    if (query.to) {
      params.set('to', new Date(query.to).toISOString());
    }
  }
  return params.toString();
}

export function fetchDashboardSummary(query: DashboardQuery): Promise<DashboardPayload> {
  return getJson<DashboardPayload>(`/api/dashboard?${buildDashboardQuery(query)}`);
}

export function fetchConversations(): Promise<ConversationsListResponse> {
  return getJson<ConversationsListResponse>('/api/conversations');
}

export function fetchConversationThread(sessionId: string): Promise<ConversationThreadResponse> {
  return getJson<ConversationThreadResponse>(`/api/conversations/${encodeURIComponent(sessionId)}`);
}

export function fetchLogs(
  kind: 'all' | 'decision' | 'incident',
  limit: number,
  offset: number
): Promise<LogsResponse> {
  return getJson<LogsResponse>(`/api/logs?kind=${kind}&limit=${limit}&offset=${offset}`);
}
