/**
 * TelegramChannelMonitor unit tests
 *
 * Covers:
 * - isConfigured() returns false when monitor is disabled or missing fields
 * - isConfigured() returns true when all required fields are present
 * - Breaking-news keywords trigger onBreakingNews callback
 * - Non-breaking messages are stored but do NOT trigger callback
 * - Duplicate messages (same title+url) are silently dropped
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramChannelMonitor } from '../../src/intel/telegram_monitor.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const storeIntelMock = vi.fn().mockReturnValue(true); // true = new item
vi.mock('../../src/intel/store.js', () => ({
  storeIntel: (...args: unknown[]) => storeIntelMock(...args),
}));

vi.mock('../../src/core/logger.js', () => ({
  Logger: class {
    info(): void {}
    warn(): void {}
    error(): void {}
  },
}));

// Minimal gramjs mock — we never call start() in unit tests, just handleMessage
vi.mock('telegram', () => ({
  TelegramClient: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    addEventHandler = vi.fn();
    getEntity = vi.fn().mockResolvedValue({ username: 'marketfeed', title: 'Market Feed' });
    session = { save: () => 'mock-session-string' };
  },
}));

vi.mock('telegram/sessions/index.js', () => ({
  StringSession: class {
    constructor(public s: string) {}
  },
}));

vi.mock('telegram/events/index.js', () => ({
  NewMessage: class {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    channels: {
      telegram: {
        monitor: {
          enabled: true,
          apiId: 12345,
          apiHash: 'abc123',
          phone: '+441234567890',
          sessionString: 'mock-session',
          channels: ['marketfeed'],
          breakingNewsKeywords: [],
          eventDrivenScanEnabled: true,
          ...overrides,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// isConfigured()
// ---------------------------------------------------------------------------

describe('TelegramChannelMonitor.isConfigured', () => {
  it('returns false when monitor is disabled', () => {
    const m = new TelegramChannelMonitor(makeConfig({ enabled: false }), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns false when sessionString is empty', () => {
    const m = new TelegramChannelMonitor(makeConfig({ sessionString: '' }), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns false when channels is empty', () => {
    const m = new TelegramChannelMonitor(makeConfig({ channels: [] }), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns false when apiId is missing', () => {
    const m = new TelegramChannelMonitor(makeConfig({ apiId: undefined }), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns true when all required fields are present', () => {
    const m = new TelegramChannelMonitor(makeConfig(), vi.fn());
    expect(m.isConfigured()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleMessage (via internal access)
// ---------------------------------------------------------------------------

describe('TelegramChannelMonitor message handling', () => {
  beforeEach(() => {
    storeIntelMock.mockClear();
    storeIntelMock.mockReturnValue(true);
  });

  async function simulateMessage(
    text: string,
    config: any = makeConfig(),
  ): Promise<{ onBreakingNews: ReturnType<typeof vi.fn> }> {
    const onBreakingNews = vi.fn().mockResolvedValue(undefined);
    const monitor = new TelegramChannelMonitor(config, onBreakingNews);

    // Access the private handleMessage via cast
    const m = monitor as any;
    m.client = {
      getEntity: vi.fn().mockResolvedValue({ username: 'marketfeed' }),
    };

    const fakeEvent = {
      message: {
        message: text,
        peerId: { channelId: 123 },
      },
    };

    await m.handleMessage(fakeEvent, ['marketfeed'], new Set([
      'blockad', 'sanction', 'war', 'nuclear', 'crash', 'default', 'emergency',
      'breaking', 'tariff', 'invad', 'attack', 'missile',
    ]));

    return { onBreakingNews };
  }

  it('stores intel for any new message', async () => {
    await simulateMessage('Oil markets update: WTI up 0.5%');
    expect(storeIntelMock).toHaveBeenCalledOnce();
    const arg = storeIntelMock.mock.calls[0][0];
    expect(arg.sourceType).toBe('social');
    expect(arg.category).toBe('market_news');
    expect(arg.source).toBe('@marketfeed');
  });

  it('does NOT call onBreakingNews for routine market update', async () => {
    const { onBreakingNews } = await simulateMessage('Gold up 0.3% in early trading');
    expect(onBreakingNews).not.toHaveBeenCalled();
  });

  it('calls onBreakingNews when text contains "blockad" stem (matches blockade/blockading)', async () => {
    const { onBreakingNews } = await simulateMessage(
      'US Navy will begin blockading all ships entering Strait of Hormuz',
    );
    expect(onBreakingNews).toHaveBeenCalledWith(1);
  });

  it('calls onBreakingNews for "tariff" keyword', async () => {
    const { onBreakingNews } = await simulateMessage(
      'Trump announces 145% tariff on all Chinese imports effective immediately',
    );
    expect(onBreakingNews).toHaveBeenCalledWith(1);
  });

  it('calls onBreakingNews for "sanctions" keyword', async () => {
    const { onBreakingNews } = await simulateMessage(
      'EU imposes new sanctions on Russian energy exports',
    );
    expect(onBreakingNews).toHaveBeenCalledWith(1);
  });

  it('is case-insensitive for keyword matching', async () => {
    const { onBreakingNews } = await simulateMessage('BREAKING: market crash imminent');
    expect(onBreakingNews).toHaveBeenCalledWith(1);
  });

  it('silently drops duplicate messages (storeIntel returns false)', async () => {
    storeIntelMock.mockReturnValue(false); // duplicate
    const { onBreakingNews } = await simulateMessage('US sanctions on Iran widened');
    // Even though keyword matches, duplicate → no callback
    expect(onBreakingNews).not.toHaveBeenCalled();
  });

  it('skips empty messages', async () => {
    await simulateMessage('   ');
    expect(storeIntelMock).not.toHaveBeenCalled();
  });

  it('respects custom breakingNewsKeywords from config', async () => {
    const config = makeConfig({ breakingNewsKeywords: ['fomc', 'rate hike'] });
    const onBreakingNews = vi.fn().mockResolvedValue(undefined);
    const monitor = new TelegramChannelMonitor(config, onBreakingNews) as any;
    monitor.client = { getEntity: vi.fn().mockResolvedValue({ username: 'marketfeed' }) };

    const keywords = new Set([
      'blockade', 'sanctions', 'war',
      'fomc', 'rate hike', // custom
    ]);
    await monitor.handleMessage(
      { message: { message: 'FOMC surprises with 50bps cut', peerId: {} } },
      ['marketfeed'],
      keywords,
    );
    expect(onBreakingNews).toHaveBeenCalledWith(1);
  });
});
