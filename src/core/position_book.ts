import { listPaperPerpPositions, listPaperPerpPositionsWithMark } from '../memory/paper_perps.js';
import { getPositionExitPolicy } from '../memory/position_exit_policy.js';
import { openDatabase } from '../memory/db.js';
import { parseExitContract, summarizeExitContract, type ExitContract } from './exit_contract.js';

export interface BookEntry {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  currentMarkPrice: number | null;
  unrealizedPnlUsd: number | null;
  entryReasoningText: string;
  thesisExpiresAtMs: number;
  exitContract: ExitContract | null;
  exitContractSummary: string | null;
  lastConsultAtMs: number | null;
  lastConsultDecision: string | null;
  entryAtMs: number | null;
}

function normalizeSide(side: string): 'long' | 'short' {
  const s = side.trim().toLowerCase();
  if (s === 'sell' || s === 'short') return 'short';
  return 'long';
}

function lookupReasoningForSymbol(symbol: string): string {
  try {
    const db = openDatabase();
    const row = db
      .prepare(
        `SELECT reasoning FROM autonomous_trades
         WHERE market_id = ?
         ORDER BY timestamp DESC LIMIT 1`
      )
      .get(symbol) as { reasoning?: string | null } | undefined;
    return row?.reasoning ?? '';
  } catch {
    return '';
  }
}

export class PositionBook {
  private static instance: PositionBook | null = null;

  private entries = new Map<string, BookEntry>();

  private constructor() {}

  static getInstance(): PositionBook {
    if (!PositionBook.instance) {
      PositionBook.instance = new PositionBook();
    }
    return PositionBook.instance;
  }

  async refresh(): Promise<void> {
    const positions = listPaperPerpPositions();
    const next = new Map<string, BookEntry>();

    for (const pos of positions) {
      const symbol = pos.symbol;
      const existing = this.entries.get(symbol);
      const policy = (() => {
        try { return getPositionExitPolicy(symbol); } catch { return null; }
      })();
      const reasoning = lookupReasoningForSymbol(symbol);
      const exitContract = parseExitContract(policy?.notes ?? null);

      const defaultTtlMs = 2 * 60 * 60 * 1000; // 2-hour fallback
      next.set(symbol, {
        symbol,
        side: pos.side,
        size: pos.size,
        entryPrice: pos.entryPrice,
        currentMarkPrice: existing?.currentMarkPrice ?? null,
        unrealizedPnlUsd: existing?.unrealizedPnlUsd ?? null,
        entryReasoningText: reasoning,
        thesisExpiresAtMs: policy?.timeStopAtMs ?? Date.now() + defaultTtlMs,
        exitContract,
        exitContractSummary: summarizeExitContract(exitContract),
        lastConsultAtMs: existing?.lastConsultAtMs ?? null,
        lastConsultDecision: existing?.lastConsultDecision ?? null,
        entryAtMs: policy?.entryAtMs ?? null,
      });
    }

    this.entries = next;

    try {
      const markedPositions = listPaperPerpPositionsWithMark();
      for (const pos of markedPositions) {
        const entry = this.entries.get(pos.symbol);
        if (!entry) continue;
        entry.currentMarkPrice = pos.currentMarkPrice;
        entry.unrealizedPnlUsd = pos.unrealizedPnlUsd;
      }
    } catch {
      // Best-effort enrichment only.
    }
  }

  get(symbol: string): BookEntry | undefined {
    return this.entries.get(symbol);
  }

  getAll(): BookEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Returns true if `symbol` already has an open position on the *opposite* side.
   * 'buy'/'long' and 'sell'/'short' are treated as equivalent.
   */
  hasConflict(symbol: string, side: 'long' | 'short' | 'buy' | 'sell'): boolean {
    const entry = this.entries.get(symbol);
    if (!entry) return false;
    const normalized = normalizeSide(side);
    return entry.side !== normalized;
  }

  /**
   * Returns true if `symbol` already has an open position on the *same* side.
   * Used to detect same-side stacking (concentration risk).
   */
  hasPosition(symbol: string, side: 'long' | 'short' | 'buy' | 'sell'): boolean {
    const entry = this.entries.get(symbol);
    if (!entry) return false;
    const normalized = normalizeSide(side);
    return entry.side === normalized;
  }

  findOppositeSideLosers(
    side: 'long' | 'short' | 'buy' | 'sell',
    minLossUsd = 0.5,
  ): Array<BookEntry & { unrealizedPnlUsd: number }> {
    const normalized = normalizeSide(side);
    return this.getAll().flatMap((entry) => {
      if (entry.side === normalized) return [];
      if (entry.unrealizedPnlUsd == null || !Number.isFinite(entry.unrealizedPnlUsd)) return [];
      if (entry.unrealizedPnlUsd > -Math.abs(minLossUsd)) return [];
      return [{ ...entry, unrealizedPnlUsd: entry.unrealizedPnlUsd }];
    });
  }
}
