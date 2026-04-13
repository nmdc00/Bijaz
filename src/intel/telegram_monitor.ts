import { randomUUID } from 'node:crypto';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';

import { Logger } from '../core/logger.js';
import type { ThufirConfig } from '../core/config.js';
import { storeIntel } from './store.js';

// ---------------------------------------------------------------------------
// Breaking-news keyword set (hardcoded baseline + configurable extras)
// ---------------------------------------------------------------------------

const BREAKING_KEYWORDS = new Set([
  // Geopolitical / military
  'blockad', 'sanction', 'invad', 'invasion', 'war', 'ceasefire',
  'nuclear', 'explos', 'attack', 'missile', 'coup', 'assassin',
  'emergency', 'breaking', 'halt', 'ban', 'freeze',
  'collapse', 'arrested', 'indicted', 'tariff', 'escalat',
  'sabotage',

  // Macro / monetary policy
  'fomc', 'rate hike', 'rate cut', 'rate decision', 'federal reserve',
  'inflation', 'cpi', 'pce', 'nfp', 'non-farm', 'unemployment',
  'recession', 'stagflation', 'gdp', 'debt ceiling', 'default',
  'quantitative', 'balance sheet', 'pivot', 'powell', 'lagarde',
  'devaluat', 'imf rescue', 'capital control',

  // Market structure shocks
  'circuit breaker', 'trading halt', 'margin call', 'liquidat',
  'flash crash', 'contagion', 'bank run', 'bail', 'insolvenc',
  'bankruptcy', 'chapter 11', 'seized', 'nationali',
  'squeeze',

  // Energy / commodities
  'opec', 'oil embargo', 'supply cut', 'pipeline',
  'production cut', 'output cut',

  // Shipping / chokepoints
  'strait', 'hormuz', 'suez', 'red sea', 'houthi', 'tanker',
  'outage',

  // Weather shocks
  'drought', 'flood', 'frost', 'heatwave', 'hurricane', 'el niño',

  // Animal disease / agri supply
  'outbreak', 'avian flu', 'bird flu', 'swine fever',

  // Export controls
  'export ban', 'export control', 'export restriction',

  // Labor disruptions
  'strike',
]);

// ---------------------------------------------------------------------------
// TelegramChannelMonitor
// ---------------------------------------------------------------------------

/**
 * Monitors one or more Telegram channels via MTProto user API (gramjs).
 *
 * On every new message:
 *   1. Stores the post as a `social` intel item (deduped by title+URL hash).
 *   2. If the text contains a breaking-news keyword, invokes `onBreakingNews`
 *      so the caller (gateway) can fire an immediate event-driven scan.
 *
 * Auth: requires a Telegram API ID, API hash, and a pre-generated session
 * string.  Run `scripts/telegram_monitor_auth.ts` once to obtain the string.
 *
 * Channel matching strategy: channel usernames are resolved to entity IDs
 * once at startup (getEntity by username always works, even on a cold session).
 * Incoming updates carry a numeric channelId in peerId which is matched against
 * those IDs directly — no per-message async lookup or entity cache dependency.
 */
export class TelegramChannelMonitor {
  private client: TelegramClient | null = null;
  private logger = new Logger('info');
  private stopped = false;
  /** channelId (bigint) → display username, populated at start() */
  private channelMap: Map<bigint, string> = new Map();

  constructor(
    private config: ThufirConfig,
    /** Called with itemCount=1 when a breaking-news message is stored. */
    private onBreakingNews: (itemCount: number) => Promise<void>,
    /** Optional: send a Telegram notification to the user's chat. */
    private notify?: (msg: string) => Promise<void>,
  ) {}

  isConfigured(): boolean {
    const m = this.config.channels?.telegram?.monitor;
    return !!(
      m?.enabled &&
      m.apiId &&
      m.apiHash &&
      m.sessionString &&
      (m.channels?.length ?? 0) > 0
    );
  }

  async start(): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.info('TelegramChannelMonitor: not configured, skipping');
      return;
    }

    const m = this.config.channels.telegram.monitor!;
    const channels = (m.channels ?? []).map((c) => c.replace(/^@/, ''));
    const extraKeywords = (m.breakingNewsKeywords ?? []).map((k) => k.toLowerCase());
    const allKeywords: Set<string> = new Set([...BREAKING_KEYWORDS, ...extraKeywords]);

    const session = new StringSession(m.sessionString);
    this.client = new TelegramClient(session, m.apiId!, m.apiHash!, {
      connectionRetries: 5,
      retryDelay: 1000,
      autoReconnect: true,
    });

    await this.client.connect();

    // Resolve each channel username → entity ID now, while we have the username
    // to look up by.  Incoming updates only carry a numeric channelId in peerId;
    // resolving by ID alone fails on a cold session because the access hash is
    // missing.  Resolving by username always works and caches the entity.
    this.channelMap = new Map();
    for (const ch of channels) {
      try {
        const entity = await this.client.getEntity(ch) as any;
        const id: bigint | number | undefined = entity?.id;
        if (id != null) {
          this.channelMap.set(BigInt(id), ch);
          this.logger.info(`TelegramChannelMonitor: resolved @${ch} → id=${id}`);
        } else {
          this.logger.warn(`TelegramChannelMonitor: entity for @${ch} has no id — messages may be missed`);
        }
      } catch (err) {
        this.logger.warn(`TelegramChannelMonitor: could not resolve @${ch}`, err);
      }
    }

    this.logger.info(`TelegramChannelMonitor: connected, monitoring [${channels.map((c) => '@' + c).join(', ')}]`);

    // No chats filter — gramJS resolves the filter at registration time using
    // only the entity cache; on a cold restart it silently drops the filter and
    // the handler never fires.  We match by channelId in handleMessage instead.
    this.client.addEventHandler(
      async (event: NewMessageEvent) => {
        if (this.stopped) return;
        try {
          await this.handleMessage(event, allKeywords);
        } catch (err) {
          this.logger.warn('TelegramChannelMonitor: message handler error', err);
        }
      },
      new NewMessage({}),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.client) {
      try { await this.client.disconnect(); } catch { /* best-effort */ }
      this.client = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async handleMessage(
    event: NewMessageEvent,
    keywords: Set<string>,
  ): Promise<void> {
    const text: string = (event.message as any).message ?? (event.message as any).text ?? '';
    if (!text.trim()) return;

    // Match by channel ID — fast, no async, no entity-cache dependency.
    // peerId.channelId is present for channel messages; absent for DMs/groups.
    const rawChannelId = (event.message as any).peerId?.channelId;
    if (rawChannelId == null) return;
    const source = this.channelMap.get(BigInt(rawChannelId));
    if (!source) return; // not a monitored channel

    const isNew = storeIntel({
      id: randomUUID(),
      title: text.slice(0, 120),
      content: text,
      source: `@${source}`,
      sourceType: 'social',
      category: 'market_news',
      timestamp: new Date().toISOString(),
    });

    if (!isNew) return; // already stored (duplicate)

    this.logger.info(`TelegramChannelMonitor: stored intel from @${source} (${text.length} chars)`);

    // Check for breaking-news keywords
    const lowerText = text.toLowerCase();
    const matched = [...keywords].find((k) => lowerText.includes(k));
    if (!matched) return;

    const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
    this.logger.info(`TelegramChannelMonitor: breaking keyword "${matched}" → triggering event scan`);

    if (this.notify) {
      await this.notify(
        `📡 [Channel Monitor] Breaking: @${source}\n${preview}`,
      ).catch(() => {});
    }

    await this.onBreakingNews(1).catch((err) =>
      this.logger.warn('TelegramChannelMonitor: event scan callback failed', err),
    );
  }
}
