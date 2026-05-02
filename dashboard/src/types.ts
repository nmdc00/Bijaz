export type DashboardMode = 'paper' | 'live' | 'combined';
export type DashboardTimeframe = 'day' | 'period' | 'all' | 'custom';

export type DashboardPayload = {
  meta: {
    generatedAt: string;
    mode: DashboardMode;
    timeframe: DashboardTimeframe;
    period: string | null;
    from: string | null;
    to: string | null;
    recordCounts?: {
      perpTrades?: number;
      journals?: number;
      openPaperPositions?: number;
      alerts?: number;
    };
  };
  sections: {
    equityCurve: {
      points: Array<{
        timestamp: string;
        equity: number;
      }>;
      summary: {
        startEquity: number | null;
        endEquity: number | null;
        returnPct: number | null;
        maxDrawdownPct: number | null;
      };
    };
    openPositions: {
      rows: Array<Record<string, unknown>>;
      summary: {
        totalUnrealizedPnlUsd: number;
        longCount: number;
        shortCount: number;
      };
    };
    tradeLog: {
      rows: Array<Record<string, unknown>>;
    };
    promotionGates: {
      rows: Array<Record<string, unknown>>;
    };
    policyState: {
      observationMode: boolean;
      leverageCap: number | null;
      drawdownCapRemainingUsd: number | null;
      tradesRemainingToday: number | null;
      updatedAt: string | null;
    };
    performanceBreakdown: {
      bySignalClass: Array<Record<string, unknown>>;
      byRegime: Array<Record<string, unknown>>;
      bySession: Array<Record<string, unknown>>;
    };
    predictionAccuracy: {
      global: Array<{
        windowSize: number;
        sampleCount: number;
        accuracy: number | null;
        brierModel: number | null;
        brierMarket: number | null;
        brierDelta: number | null;
        avgModelProbability: number | null;
        avgMarketProbability: number | null;
        avgEdge: number | null;
        totalPnl: number | null;
      }>;
      byDomain: Record<string, Array<{
        windowSize: number;
        sampleCount: number;
        accuracy: number | null;
        brierModel: number | null;
        brierMarket: number | null;
        brierDelta: number | null;
        avgModelProbability: number | null;
        avgMarketProbability: number | null;
        avgEdge: number | null;
        totalPnl: number | null;
      }>>;
      totalFinalPredictions: number;
    };
  };
};

export type ConversationSession = {
  sessionId: string;
  messageCount: number;
  firstMessage: string;
  startedAt: string;
  lastMessageAt: string;
};

export type ConversationsListResponse = {
  sessions: ConversationSession[];
};

export type ConversationThreadResponse = {
  sessionId: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
  }>;
};

export type LogsResponse = {
  entries: Array<Record<string, unknown>>;
  total: number;
};
