import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export type PaperPerpBookSummary = {
  startingCashUsdc: number;
  cashBalanceUsdc: number;
  realizedPnlUsdc: number;
};

export type PaperPerpPosition = {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  leverage: number | null;
  openedAt: string;
  updatedAt: string;
};

export type PaperPerpOpenOrder = {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  orderType: 'market' | 'limit';
  price: number | null;
  reduceOnly: boolean;
  leverage: number | null;
  createdAt: string;
  updatedAt: string;
};

type PlacePaperPerpOrderInput = {
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  orderType: 'market' | 'limit';
  price?: number | null;
  markPrice: number;
  leverage?: number | null;
  reduceOnly?: boolean;
  feeRate?: number;
};

export type PaperPerpFillResult = {
  orderId: string;
  filled: boolean;
  fillPrice: number | null;
  markPrice: number;
  slippageBps: number | null;
  realizedPnlUsd: number;
  feeUsd: number;
  message: string;
};

function ensurePaperPerpsSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_perp_book (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      starting_cash_usdc REAL NOT NULL DEFAULT 200,
      cash_balance_usdc REAL NOT NULL DEFAULT 200,
      realized_pnl_usdc REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS paper_perp_positions (
      symbol TEXT PRIMARY KEY,
      side TEXT NOT NULL CHECK (side IN ('long', 'short')),
      size REAL NOT NULL,
      entry_price REAL NOT NULL,
      leverage REAL,
      opened_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS paper_perp_orders (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      size REAL NOT NULL,
      order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
      price REAL,
      reduce_only INTEGER NOT NULL DEFAULT 0,
      leverage REAL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS paper_perp_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      size REAL NOT NULL,
      fill_price REAL NOT NULL,
      mark_price REAL NOT NULL,
      slippage_bps REAL,
      reduce_only INTEGER NOT NULL DEFAULT 0,
      realized_pnl_usd REAL NOT NULL DEFAULT 0,
      fee_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_paper_perp_orders_status ON paper_perp_orders(status);
    CREATE INDEX IF NOT EXISTS idx_paper_perp_fills_symbol_created ON paper_perp_fills(symbol, created_at);
  `);
}

function initializePaperPerpBook(initialCashUsdc = 200): void {
  ensurePaperPerpsSchema();
  const db = openDatabase();
  const initialCash = Number.isFinite(initialCashUsdc) && initialCashUsdc > 0 ? initialCashUsdc : 200;
  db.prepare(
    `
      INSERT INTO paper_perp_book (id, starting_cash_usdc, cash_balance_usdc, realized_pnl_usdc, created_at, updated_at)
      VALUES (1, @initialCash, @initialCash, 0, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO NOTHING
    `
  ).run({ initialCash });
}

export function getPaperPerpBookSummary(initialCashUsdc = 200): PaperPerpBookSummary {
  initializePaperPerpBook(initialCashUsdc);
  const db = openDatabase();
  const row = db
    .prepare(
      `
        SELECT starting_cash_usdc, cash_balance_usdc, realized_pnl_usdc
        FROM paper_perp_book
        WHERE id = 1
      `
    )
    .get() as Record<string, unknown> | undefined;

  return {
    startingCashUsdc: Number(row?.starting_cash_usdc ?? initialCashUsdc),
    cashBalanceUsdc: Number(row?.cash_balance_usdc ?? initialCashUsdc),
    realizedPnlUsdc: Number(row?.realized_pnl_usdc ?? 0),
  };
}

export function listPaperPerpPositions(initialCashUsdc = 200): PaperPerpPosition[] {
  initializePaperPerpBook(initialCashUsdc);
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT symbol, side, size, entry_price, leverage, opened_at, updated_at
        FROM paper_perp_positions
        ORDER BY symbol ASC
      `
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    symbol: String(row.symbol ?? ''),
    side: String(row.side ?? 'long') === 'short' ? 'short' : 'long',
    size: Number(row.size ?? 0),
    entryPrice: Number(row.entry_price ?? 0),
    leverage: row.leverage == null ? null : Number(row.leverage),
    openedAt: String(row.opened_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  }));
}

export function listPaperPerpOpenOrders(initialCashUsdc = 200): PaperPerpOpenOrder[] {
  initializePaperPerpBook(initialCashUsdc);
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT id, symbol, side, size, order_type, price, reduce_only, leverage, created_at, updated_at
        FROM paper_perp_orders
        WHERE status = 'open'
        ORDER BY created_at DESC
      `
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id ?? ''),
    symbol: String(row.symbol ?? ''),
    side: String(row.side ?? 'buy') === 'sell' ? 'sell' : 'buy',
    size: Number(row.size ?? 0),
    orderType: String(row.order_type ?? 'market') === 'limit' ? 'limit' : 'market',
    price: row.price == null ? null : Number(row.price),
    reduceOnly: Number(row.reduce_only ?? 0) === 1,
    leverage: row.leverage == null ? null : Number(row.leverage),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  }));
}

export function cancelPaperPerpOrder(orderId: string, initialCashUsdc = 200): void {
  initializePaperPerpBook(initialCashUsdc);
  const db = openDatabase();
  const result = db
    .prepare(
      `
        UPDATE paper_perp_orders
        SET status = 'cancelled',
            updated_at = datetime('now')
        WHERE id = @orderId
          AND status = 'open'
      `
    )
    .run({ orderId });
  if (Number(result.changes ?? 0) === 0) {
    throw new Error(`Open paper order not found: ${orderId}`);
  }
}

function realizedPnlForClose(params: {
  closeSide: 'buy' | 'sell';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  positionSide: 'long' | 'short';
}): number {
  const { quantity, entryPrice, exitPrice, positionSide } = params;
  const move = positionSide === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
  return move * quantity;
}

export function placePaperPerpOrder(
  input: PlacePaperPerpOrderInput,
  options?: { initialCashUsdc?: number }
): PaperPerpFillResult {
  const initialCashUsdc = options?.initialCashUsdc ?? 200;
  initializePaperPerpBook(initialCashUsdc);
  const db = openDatabase();

  const symbol = input.symbol.trim().toUpperCase();
  const side = input.side;
  const size = Number(input.size);
  const orderType = input.orderType;
  const markPrice = Number(input.markPrice);
  const reduceOnly = Boolean(input.reduceOnly ?? false);
  const leverage = input.leverage == null ? null : Number(input.leverage);
  const feeRate = Number.isFinite(Number(input.feeRate)) ? Math.max(0, Number(input.feeRate)) : 0.0005;

  if (!symbol || !Number.isFinite(size) || size <= 0) {
    throw new Error('Invalid paper order: missing symbol or size');
  }
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new Error(`Invalid paper order: missing mark price for ${symbol}`);
  }

  const explicitPrice = input.price == null ? null : Number(input.price);
  if (orderType === 'limit' && (!Number.isFinite(explicitPrice) || (explicitPrice ?? 0) <= 0)) {
    throw new Error('Invalid paper order: missing or invalid limit price');
  }

  const shouldFillNow =
    orderType === 'market' ||
    (side === 'buy' ? Number(explicitPrice ?? 0) >= markPrice : Number(explicitPrice ?? 0) <= markPrice);

  const orderId = `paper-${randomUUID().slice(0, 12)}`;
  const fillPrice =
    orderType === 'market'
      ? side === 'buy'
        ? markPrice * (1 + feeRate)
        : markPrice * (1 - feeRate)
      : Number(explicitPrice ?? markPrice);
  const slippageBps = ((fillPrice - markPrice) / markPrice) * 10_000;

  const writeOrder = db.prepare(
    `
      INSERT INTO paper_perp_orders (
        id, symbol, side, size, order_type, price, reduce_only, leverage, status, created_at, updated_at
      ) VALUES (
        @id, @symbol, @side, @size, @orderType, @price, @reduceOnly, @leverage, @status, datetime('now'), datetime('now')
      )
    `
  );
  const updateBook = db.prepare(
    `
      UPDATE paper_perp_book
      SET cash_balance_usdc = cash_balance_usdc + @cashDelta,
          realized_pnl_usdc = realized_pnl_usdc + @realizedDelta,
          updated_at = datetime('now')
      WHERE id = 1
    `
  );
  const readPosition = db.prepare(
    `
      SELECT symbol, side, size, entry_price, leverage, opened_at, updated_at
      FROM paper_perp_positions
      WHERE symbol = @symbol
      LIMIT 1
    `
  );
  const upsertPosition = db.prepare(
    `
      INSERT INTO paper_perp_positions (symbol, side, size, entry_price, leverage, opened_at, updated_at)
      VALUES (@symbol, @side, @size, @entryPrice, @leverage, @openedAt, datetime('now'))
      ON CONFLICT(symbol) DO UPDATE SET
        side = excluded.side,
        size = excluded.size,
        entry_price = excluded.entry_price,
        leverage = excluded.leverage,
        opened_at = excluded.opened_at,
        updated_at = datetime('now')
    `
  );
  const deletePosition = db.prepare(`DELETE FROM paper_perp_positions WHERE symbol = @symbol`);
  const insertFill = db.prepare(
    `
      INSERT INTO paper_perp_fills (
        order_id, symbol, side, size, fill_price, mark_price, slippage_bps, reduce_only, realized_pnl_usd, fee_usd, metadata
      ) VALUES (
        @orderId, @symbol, @side, @size, @fillPrice, @markPrice, @slippageBps, @reduceOnly, @realizedPnlUsd, @feeUsd, @metadata
      )
    `
  );

  const txn = db.transaction(() => {
    if (!shouldFillNow) {
      writeOrder.run({
        id: orderId,
        symbol,
        side,
        size,
        orderType,
        price: explicitPrice,
        reduceOnly: reduceOnly ? 1 : 0,
        leverage,
        status: 'open',
      });
      return {
        orderId,
        filled: false,
        fillPrice: null,
        markPrice,
        slippageBps: null,
        realizedPnlUsd: 0,
        feeUsd: 0,
        message: `Paper order resting (oid=${orderId}).`,
      } as PaperPerpFillResult;
    }

    writeOrder.run({
      id: orderId,
      symbol,
      side,
      size,
      orderType,
      price: explicitPrice,
      reduceOnly: reduceOnly ? 1 : 0,
      leverage,
      status: 'filled',
    });

    const existing = readPosition.get({ symbol }) as Record<string, unknown> | undefined;
    const existingSide = String(existing?.side ?? '');
    const existingSize = Number(existing?.size ?? 0);
    const existingEntry = Number(existing?.entry_price ?? 0);
    const openedAt = String(existing?.opened_at ?? new Date().toISOString());
    const targetSide = side === 'buy' ? 'long' : 'short';
    const opposite = existingSide && existingSide !== targetSide && existingSize > 0;

    let realizedPnlUsd = 0;
    let nextSize = size;
    let nextSide: 'long' | 'short' = targetSide;
    let nextEntry = fillPrice;
    let nextOpenedAt = new Date().toISOString();

    if (existingSide && existingSize > 0) {
      if (!opposite) {
        nextSize = existingSize + size;
        nextEntry = ((existingEntry * existingSize) + (fillPrice * size)) / Math.max(nextSize, 1e-9);
        nextSide = existingSide === 'short' ? 'short' : 'long';
        nextOpenedAt = openedAt;
      } else {
        const closingQty = Math.min(existingSize, size);
        realizedPnlUsd = realizedPnlForClose({
          closeSide: side,
          quantity: closingQty,
          entryPrice: existingEntry,
          exitPrice: fillPrice,
          positionSide: existingSide === 'short' ? 'short' : 'long',
        });

        const remainder = existingSize - closingQty;
        if (size > existingSize) {
          nextSize = size - existingSize;
          nextSide = targetSide;
          nextEntry = fillPrice;
          nextOpenedAt = new Date().toISOString();
        } else {
          nextSize = remainder;
          nextSide = existingSide === 'short' ? 'short' : 'long';
          nextEntry = existingEntry;
          nextOpenedAt = openedAt;
        }
      }
    }

    const feeUsd = Math.max(0, size * fillPrice * feeRate);
    updateBook.run({
      cashDelta: realizedPnlUsd - feeUsd,
      realizedDelta: realizedPnlUsd,
    });

    if (reduceOnly && (!existingSide || existingSize <= 0)) {
      throw new Error(`Reduce-only paper order blocked: no open ${symbol} position to reduce.`);
    }
    if (reduceOnly && !opposite) {
      throw new Error(`Reduce-only paper order blocked: ${side} would increase ${symbol} exposure.`);
    }

    if (nextSize <= 0) {
      deletePosition.run({ symbol });
    } else {
      upsertPosition.run({
        symbol,
        side: nextSide,
        size: nextSize,
        entryPrice: nextEntry,
        leverage,
        openedAt: nextOpenedAt,
      });
    }

    insertFill.run({
      orderId,
      symbol,
      side,
      size,
      fillPrice,
      markPrice,
      slippageBps,
      reduceOnly: reduceOnly ? 1 : 0,
      realizedPnlUsd,
      feeUsd,
      metadata: JSON.stringify({ leverage, orderType }),
    });

    return {
      orderId,
      filled: true,
      fillPrice,
      markPrice,
      slippageBps,
      realizedPnlUsd,
      feeUsd,
      message: `Paper order filled (oid=${orderId}).`,
    } as PaperPerpFillResult;
  });

  return txn();
}
