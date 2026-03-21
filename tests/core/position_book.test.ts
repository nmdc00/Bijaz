/**
 * Tests for PositionBook singleton.
 *
 * Validates:
 * - hasConflict returns false when book is empty
 * - hasConflict returns false for same symbol, same side
 * - hasConflict returns true for same symbol, opposite side
 * - buy/long and sell/short normalisation is consistent
 * - getAll() returns empty array when book is empty
 * - get(symbol) returns undefined for unknown symbol
 * - refresh() populates entries from mock DB data
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockListPaperPerpPositions = vi.fn();
const mockGetPositionExitPolicy = vi.fn();

vi.mock('../../src/memory/paper_perps.js', () => ({
  listPaperPerpPositions: (...args: unknown[]) => mockListPaperPerpPositions(...args),
}));

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  getPositionExitPolicy: (...args: unknown[]) => mockGetPositionExitPolicy(...args),
}));

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({
    prepare: () => ({
      get: () => null,
    }),
  }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

// We need to reset the singleton between tests.
// Import the module and access the private static via casting.
import { PositionBook } from '../../src/core/position_book.js';

// Helper to reset singleton between tests.
function resetSingleton(): void {
  (PositionBook as any).instance = null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PositionBook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSingleton();
    mockListPaperPerpPositions.mockReturnValue([]);
    mockGetPositionExitPolicy.mockReturnValue(null);
  });

  describe('getAll() / get()', () => {
    it('returns empty array when book is empty', () => {
      const book = PositionBook.getInstance();
      expect(book.getAll()).toEqual([]);
    });

    it('get() returns undefined for unknown symbol', () => {
      const book = PositionBook.getInstance();
      expect(book.get('BTC')).toBeUndefined();
    });
  });

  describe('hasConflict()', () => {
    it('returns false when book is empty', () => {
      const book = PositionBook.getInstance();
      expect(book.hasConflict('BTC', 'long')).toBe(false);
    });

    it('returns false for same symbol, same side (long)', async () => {
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'BTC', side: 'long', size: 0.1, entryPrice: 50000 },
      ]);
      const book = PositionBook.getInstance();
      await book.refresh();
      expect(book.hasConflict('BTC', 'long')).toBe(false);
    });

    it('returns false for same symbol, same side (short)', async () => {
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'ETH', side: 'short', size: 1, entryPrice: 2000 },
      ]);
      const book = PositionBook.getInstance();
      await book.refresh();
      expect(book.hasConflict('ETH', 'short')).toBe(false);
    });

    it('returns true for same symbol, opposite side (long vs short)', async () => {
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'BTC', side: 'long', size: 0.1, entryPrice: 50000 },
      ]);
      const book = PositionBook.getInstance();
      await book.refresh();
      expect(book.hasConflict('BTC', 'short')).toBe(true);
    });

    it('returns true for same symbol, opposite side (short vs long)', async () => {
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'ETH', side: 'short', size: 1, entryPrice: 2000 },
      ]);
      const book = PositionBook.getInstance();
      await book.refresh();
      expect(book.hasConflict('ETH', 'long')).toBe(true);
    });

    it('normalises buy as equivalent to long — no conflict', async () => {
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'SOL', side: 'long', size: 5, entryPrice: 100 },
      ]);
      const book = PositionBook.getInstance();
      await book.refresh();
      // 'buy' normalises to 'long' — same side, no conflict
      expect(book.hasConflict('SOL', 'buy')).toBe(false);
    });

    it('normalises sell as equivalent to short — conflict with long', async () => {
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'SOL', side: 'long', size: 5, entryPrice: 100 },
      ]);
      const book = PositionBook.getInstance();
      await book.refresh();
      // 'sell' normalises to 'short' — opposite of 'long', conflict
      expect(book.hasConflict('SOL', 'sell')).toBe(true);
    });

    it('returns false for a different symbol', async () => {
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'BTC', side: 'long', size: 0.1, entryPrice: 50000 },
      ]);
      const book = PositionBook.getInstance();
      await book.refresh();
      expect(book.hasConflict('ETH', 'short')).toBe(false);
    });
  });

  describe('refresh()', () => {
    it('populates entries from mock positions', async () => {
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'BTC', side: 'long', size: 0.5, entryPrice: 60000 },
        { symbol: 'ETH', side: 'short', size: 2, entryPrice: 3000 },
      ]);
      mockGetPositionExitPolicy.mockReturnValue(null);

      const book = PositionBook.getInstance();
      await book.refresh();

      const all = book.getAll();
      expect(all).toHaveLength(2);

      const btc = book.get('BTC');
      expect(btc).toBeDefined();
      expect(btc!.symbol).toBe('BTC');
      expect(btc!.side).toBe('long');
      expect(btc!.size).toBe(0.5);
      expect(btc!.entryPrice).toBe(60000);

      const eth = book.get('ETH');
      expect(eth).toBeDefined();
      expect(eth!.side).toBe('short');
    });

    it('uses thesisExpiresAtMs from exit policy when present', async () => {
      const futureMs = Date.now() + 60 * 60 * 1000;
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'BTC', side: 'long', size: 0.1, entryPrice: 50000 },
      ]);
      mockGetPositionExitPolicy.mockReturnValue({
        symbol: 'BTC',
        side: 'long',
        timeStopAtMs: futureMs,
        invalidationPrice: null,
        notes: null,
      });

      const book = PositionBook.getInstance();
      await book.refresh();

      expect(book.get('BTC')!.thesisExpiresAtMs).toBe(futureMs);
    });

    it('parses exit contract notes into the book entry summary', async () => {
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'BTC', side: 'long', size: 0.1, entryPrice: 50000 },
      ]);
      mockGetPositionExitPolicy.mockReturnValue({
        symbol: 'BTC',
        side: 'long',
        timeStopAtMs: null,
        invalidationPrice: null,
        notes: JSON.stringify({
          thesis: 'BTC continuation',
          hardRules: [
            { metric: 'mark_price', op: '<=', value: 49000, action: 'close', reason: 'support lost' },
          ],
          reviewGuidance: ['Reduce if momentum stalls.'],
        }),
      });

      const book = PositionBook.getInstance();
      await book.refresh();

      expect(book.get('BTC')!.exitContract).toEqual(
        expect.objectContaining({
          thesis: 'BTC continuation',
        })
      );
      expect(book.get('BTC')!.exitContractSummary).toContain('support lost');
    });

    it('preserves lastConsultAtMs and lastConsultDecision across refresh', async () => {
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'BTC', side: 'long', size: 0.1, entryPrice: 50000 },
      ]);

      const book = PositionBook.getInstance();
      await book.refresh();

      // Simulate a consult being recorded externally.
      const entry = book.get('BTC')!;
      (entry as any).lastConsultAtMs = 12345;
      (entry as any).lastConsultDecision = '{"action":"hold"}';

      // Refresh again — should carry over consult fields.
      await book.refresh();
      const refreshed = book.get('BTC')!;
      expect(refreshed.lastConsultAtMs).toBe(12345);
      expect(refreshed.lastConsultDecision).toBe('{"action":"hold"}');
    });

    it('removes entries that are no longer in positions after refresh', async () => {
      mockListPaperPerpPositions.mockReturnValue([
        { symbol: 'BTC', side: 'long', size: 0.1, entryPrice: 50000 },
      ]);
      const book = PositionBook.getInstance();
      await book.refresh();
      expect(book.get('BTC')).toBeDefined();

      // Position closed — no longer returned.
      mockListPaperPerpPositions.mockReturnValue([]);
      await book.refresh();
      expect(book.get('BTC')).toBeUndefined();
      expect(book.getAll()).toHaveLength(0);
    });

    it('getInstance() always returns the same instance', () => {
      const a = PositionBook.getInstance();
      const b = PositionBook.getInstance();
      expect(a).toBe(b);
    });
  });
});
