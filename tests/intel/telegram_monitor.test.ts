/**
 * TelegramChannelMonitor unit tests
 *
 * Covers:
 * - isConfigured() returns false when monitor is disabled or missing fields
 * - isConfigured() returns true when all required fields are present
 * - Breaking-news keywords trigger onBreakingNews callback
 * - Non-breaking messages are stored but do NOT trigger callback
 * - Duplicate messages (same title+url) are silently dropped
 * - notify() is called on breaking-news events
 * - Messages from non-monitored channels (wrong ID, DMs) are ignored
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
    getEntity = vi.fn().mockResolvedValue({ id: BigInt(123), username: 'marketfeed', title: 'Market Feed' });
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

const CHANNEL_ID = BigInt(123);

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

const TEST_KEYWORDS = new Set([
  'blockad', 'sanction', 'war', 'nuclear', 'crash', 'default', 'emergency',
  'breaking', 'tariff', 'invad', 'attack', 'missile',
]);

/** Set up a monitor with channelMap pre-populated (bypasses start()) */
function makeMonitor(
  config = makeConfig(),
  onBreakingNews = vi.fn().mockResolvedValue(undefined),
  notify = vi.fn().mockResolvedValue(undefined),
) {
  const monitor = new TelegramChannelMonitor(config, onBreakingNews, notify) as any;
  monitor.channelMap = new Map([[CHANNEL_ID, 'marketfeed']]);
  monitor.entityObjects = new Map([['marketfeed', {}]]);
  return { monitor, onBreakingNews, notify };
}

function makeEvent(text: string, channelId: bigint | null = CHANNEL_ID) {
  return {
    message: {
      message: text,
      peerId: channelId != null ? { channelId } : {},
    },
  };
}

// ---------------------------------------------------------------------------
// isConfigured()
// ---------------------------------------------------------------------------

describe('TelegramChannelMonitor.isConfigured', () => {
  it('returns false when monitor is disabled', () => {
    const m = new TelegramChannelMonitor(makeConfig({ enabled: false }), vi.fn(), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns false when sessionString is empty', () => {
    const m = new TelegramChannelMonitor(makeConfig({ sessionString: '' }), vi.fn(), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns false when channels is empty', () => {
    const m = new TelegramChannelMonitor(makeConfig({ channels: [] }), vi.fn(), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns false when apiId is missing', () => {
    const m = new TelegramChannelMonitor(makeConfig({ apiId: undefined }), vi.fn(), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns true when all required fields are present', () => {
    const m = new TelegramChannelMonitor(makeConfig(), vi.fn(), vi.fn());
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

  it('stores intel for any new message from a monitored channel', async () => {
    const { monitor } = makeMonitor();
    await monitor.handleMessage(makeEvent('Oil markets update: WTI up 0.5%'), TEST_KEYWORDS);
    expect(storeIntelMock).toHaveBeenCalledOnce();
    const arg = storeIntelMock.mock.calls[0][0];
    expect(arg.sourceType).toBe('social');
    expect(arg.category).toBe('market_news');
    expect(arg.source).toBe('@marketfeed');
  });

  it('does NOT call onBreakingNews for routine market update', async () => {
    const { monitor, onBreakingNews, notify } = makeMonitor();
    await monitor.handleMessage(makeEvent('Gold up 0.3% in early trading'), TEST_KEYWORDS);
    expect(onBreakingNews).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('calls onBreakingNews when text contains "blockad" stem (matches blockade/blockading)', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    await monitor.handleMessage(
      makeEvent('US Navy will begin blockading all ships entering Strait of Hormuz'),
      TEST_KEYWORDS,
    );
    expect(onBreakingNews).toHaveBeenCalledWith(1);
  });

  it('calls onBreakingNews for "tariff" keyword', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    await monitor.handleMessage(
      makeEvent('Trump announces 145% tariff on all Chinese imports effective immediately'),
      TEST_KEYWORDS,
    );
    expect(onBreakingNews).toHaveBeenCalledWith(1);
  });

  it('calls onBreakingNews for "sanctions" keyword', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    await monitor.handleMessage(
      makeEvent('EU imposes new sanctions on Russian energy exports'),
      TEST_KEYWORDS,
    );
    expect(onBreakingNews).toHaveBeenCalledWith(1);
  });

  it('calls notify with preview on breaking news', async () => {
    const { monitor, notify } = makeMonitor();
    await monitor.handleMessage(makeEvent('Emergency: nuclear test detected'), TEST_KEYWORDS);
    expect(notify).toHaveBeenCalledOnce();
    const msg: string = notify.mock.calls[0][0];
    expect(msg).toContain('📡');
    expect(msg).toContain('@marketfeed');
  });

  it('is case-insensitive for keyword matching', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    await monitor.handleMessage(makeEvent('BREAKING: market crash imminent'), TEST_KEYWORDS);
    expect(onBreakingNews).toHaveBeenCalledWith(1);
  });

  it('silently drops duplicate messages (storeIntel returns false)', async () => {
    storeIntelMock.mockReturnValue(false); // duplicate
    const { monitor, onBreakingNews } = makeMonitor();
    await monitor.handleMessage(makeEvent('US sanctions on Iran widened'), TEST_KEYWORDS);
    // Even though keyword matches, duplicate → no callback
    expect(onBreakingNews).not.toHaveBeenCalled();
  });

  it('skips empty messages', async () => {
    const { monitor } = makeMonitor();
    await monitor.handleMessage(makeEvent('   '), TEST_KEYWORDS);
    expect(storeIntelMock).not.toHaveBeenCalled();
  });

  it('ignores messages with no channelId in peerId (DMs, groups)', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    // peerId has no channelId — simulates a DM or group message
    await monitor.handleMessage(
      makeEvent('war breaking emergency sanctions', null),
      TEST_KEYWORDS,
    );
    expect(storeIntelMock).not.toHaveBeenCalled();
    expect(onBreakingNews).not.toHaveBeenCalled();
  });

  it('ignores messages from an unknown channel ID', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    // Different channel ID — not in channelMap
    await monitor.handleMessage(
      makeEvent('war breaking emergency sanctions', BigInt(999)),
      TEST_KEYWORDS,
    );
    expect(storeIntelMock).not.toHaveBeenCalled();
    expect(onBreakingNews).not.toHaveBeenCalled();
  });

  it('respects custom breakingNewsKeywords from config', async () => {
    const config = makeConfig({ breakingNewsKeywords: ['fomc', 'rate hike'] });
    const onBreakingNews = vi.fn().mockResolvedValue(undefined);
    const monitor = new TelegramChannelMonitor(config, onBreakingNews, vi.fn().mockResolvedValue(undefined)) as any;
    monitor.channelMap = new Map([[CHANNEL_ID, 'marketfeed']]);

    const keywords = new Set(['blockade', 'sanctions', 'war', 'fomc', 'rate hike']);
    await monitor.handleMessage(makeEvent('FOMC surprises with 50bps cut'), keywords);
    expect(onBreakingNews).toHaveBeenCalledWith(1);
  });
});
