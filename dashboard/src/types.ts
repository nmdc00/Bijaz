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
      reason?: string | null;
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
    learningAudit: {
      comparable: {
        totalCaseCount: number;
        byDomain: Array<{
          domain: string;
          count: number;
        }>;
      };
      execution: {
        totalCaseCount: number;
        byDomain: Array<{
          domain: string;
          count: number;
        }>;
      };
      exclusions: {
        totalCaseCount: number;
        byReason: Array<{
          reason: string;
          count: number;
        }>;
      };
      policyOutputs: Array<{
        sourceTrack: 'comparable_forecast' | 'execution_quality' | 'combined';
        action: 'block' | 'resize' | 'bias' | 'suppress' | 'prior_adjustment';
        scope: string;
        count: number;
        blocked: boolean;
        sizeMultiplier: number | null;
        reason: string | null;
        updatedAt: string | null;
      }>;
    };
    learningObservability: {
      runtimeContext: {
        runId: string;
        policyVersion: string;
        updatedAt: string | null;
        source: string | null;
      };
      activeWeights: Array<{
        domain: string;
        weights: {
          technical: number;
          news: number;
          onChain: number;
        };
        samples: number;
        updatedAt: string | null;
      }>;
      totalShadowAudits: number;
      runSummaries: Array<{
        runId: string;
        policyVersion: string;
        eventCount: number;
        changedVsDefaultCount: number;
        changedAfterUpdateCount: number;
        avgConfidenceDeltaVsDefault: number | null;
        avgConfidenceDeltaAfterUpdate: number | null;
        lastRecordedAt: string | null;
      }>;
      recentAudits: Array<{
        domain: string;
        runId: string;
        policyVersion: string;
        baselineDirection: string | null;
        decisionDirection: string | null;
        activeDirectionAfter: string | null;
        changedVsDefault: boolean;
        changedAfterUpdate: boolean;
        confidenceDeltaVsDefault: number | null;
        confidenceDeltaAfterUpdate: number | null;
        createdAt: string;
      }>;
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
