#!/usr/bin/env node
import http from 'node:http';

import { loadConfig } from '../core/config.js';
import { Logger } from '../core/logger.js';
import { BijazAgent } from '../core/agent.js';
import { TelegramAdapter } from '../interface/telegram.js';
import { WhatsAppAdapter } from '../interface/whatsapp.js';
import { resolveOutcomes } from '../core/resolver.js';
import { runIntelPipelineDetailed } from '../intel/pipeline.js';
import { pruneChatMessages } from '../memory/chat.js';
import { listWatchlist } from '../memory/watchlist.js';
import { PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { pruneIntel } from '../intel/store.js';
import { rankIntelAlerts } from '../intel/alerts.js';
import { syncMarketCache } from '../core/markets_sync.js';
import { runProactiveSearch } from '../core/proactive_search.js';

const config = loadConfig();
const rawLevel = (process.env.BIJAZ_LOG_LEVEL ?? 'info').toLowerCase();
const level =
  rawLevel === 'debug' || rawLevel === 'info' || rawLevel === 'warn' || rawLevel === 'error'
    ? rawLevel
    : 'info';
const logger = new Logger(level);
const agent = new BijazAgent(config, logger);

const telegram = config.channels.telegram.enabled ? new TelegramAdapter(config) : null;
const whatsapp = config.channels.whatsapp.enabled ? new WhatsAppAdapter(config) : null;

agent.start();

const onIncoming = async (channel: 'telegram' | 'whatsapp', senderId: string, text: string) => {
  const reply = await agent.handleMessage(senderId, text);
  if (channel === 'telegram' && telegram) {
    await telegram.sendMessage(senderId, reply);
  }
  if (channel === 'whatsapp' && whatsapp) {
    await whatsapp.sendMessage(senderId, reply);
  }
};

const briefingConfig = config.notifications?.briefing;
let lastBriefingDate = '';
if (briefingConfig?.enabled) {
  setInterval(async () => {
    const now = new Date();
    const [hours, minutes] = briefingConfig.time.split(':').map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return;
    }
    const today = now.toISOString().split('T')[0]!;
    if (lastBriefingDate === today) {
      return;
    }
    if (now.getHours() !== hours || now.getMinutes() !== minutes) {
      return;
    }

    const message = await agent.generateBriefing();
    const channels = briefingConfig.channels ?? [];
    if (channels.includes('telegram') && telegram) {
      for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
        await telegram.sendMessage(String(chatId), message);
      }
    }
    if (channels.includes('whatsapp') && whatsapp) {
      for (const number of config.channels.whatsapp.allowedNumbers ?? []) {
        await whatsapp.sendMessage(number, message);
      }
    }
    lastBriefingDate = today;
  }, 60_000);
}

const resolverConfig = config.notifications?.resolver;
let lastResolverDate = '';
if (resolverConfig?.enabled) {
  setInterval(async () => {
    const now = new Date();
    const [hours, minutes] = resolverConfig.time.split(':').map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return;
    }
    const today = now.toISOString().split('T')[0]!;
    if (lastResolverDate === today) {
      return;
    }
    if (now.getHours() !== hours || now.getMinutes() !== minutes) {
      return;
    }

    try {
      const updated = await resolveOutcomes(config, resolverConfig.limit);
      logger.info(`Resolved ${updated} prediction(s).`);
    } catch (error) {
      logger.error('Outcome resolver failed', error);
    }
    lastResolverDate = today;
  }, 60_000);
}

const intelFetchConfig = config.notifications?.intelFetch;
let lastIntelFetchDate = '';
if (intelFetchConfig?.enabled) {
  setInterval(async () => {
    const now = new Date();
    const [hours, minutes] = intelFetchConfig.time.split(':').map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return;
    }
    const today = now.toISOString().split('T')[0]!;
    if (lastIntelFetchDate === today) {
      return;
    }
    if (now.getHours() !== hours || now.getMinutes() !== minutes) {
      return;
    }

    try {
      const result = await runIntelPipelineDetailed(config);
      logger.info(`Intel fetch stored ${result.storedCount} item(s).`);

      if (config.autonomy?.eventDriven) {
        const minItems = config.autonomy?.eventDrivenMinItems ?? 1;
        if (result.storedCount >= minItems) {
          const scanResult = await agent.getAutonomous().runScan();
          logger.info(`Event-driven scan: ${scanResult}`);
        }
      }

      const alertsConfig = config.notifications?.intelAlerts;
      if (alertsConfig?.enabled && result.storedItems.length > 0) {
        await sendIntelAlerts(result.storedItems, alertsConfig);
      }
    } catch (error) {
      logger.error('Intel fetch failed', error);
    }
    lastIntelFetchDate = today;
  }, 60_000);
}

const marketSyncConfig = config.notifications?.marketSync;
let lastMarketSyncDate = '';
if (marketSyncConfig?.enabled) {
  setInterval(async () => {
    const now = new Date();
    const [hours, minutes] = marketSyncConfig.time.split(':').map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return;
    }
    const today = now.toISOString().split('T')[0]!;
    if (lastMarketSyncDate === today) {
      return;
    }
    if (now.getHours() !== hours || now.getMinutes() !== minutes) {
      return;
    }

    try {
      const result = await syncMarketCache(config, marketSyncConfig.limit);
      logger.info(`Market cache sync stored ${result.stored} market(s).`);
    } catch (error) {
      logger.error('Market cache sync failed', error);
    }
    lastMarketSyncDate = today;
  }, 60_000);
}

const proactiveConfig = config.notifications?.proactiveSearch;
let lastProactiveDate = '';
if (proactiveConfig?.enabled) {
  setInterval(async () => {
    const now = new Date();
    const [hours, minutes] = proactiveConfig.time.split(':').map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return;
    }
    const today = now.toISOString().split('T')[0]!;
    if (lastProactiveDate === today) {
      return;
    }
    if (now.getHours() !== hours || now.getMinutes() !== minutes) {
      return;
    }

    try {
      const result = await runProactiveSearch(config, {
        maxQueries: proactiveConfig.maxQueries,
        watchlistLimit: proactiveConfig.watchlistLimit,
        useLlm: proactiveConfig.useLlm,
        recentIntelLimit: proactiveConfig.recentIntelLimit,
        extraQueries: proactiveConfig.extraQueries,
      });
      logger.info(`Proactive search stored ${result.storedCount} item(s).`);

      const alertsConfig = config.notifications?.intelAlerts;
      if (alertsConfig?.enabled && result.storedItems.length > 0) {
        await sendIntelAlerts(result.storedItems, alertsConfig);
      }
    } catch (error) {
      logger.error('Proactive search failed', error);
    }
    lastProactiveDate = today;
  }, 60_000);
}

const dailyReportConfig = config.notifications?.dailyReport;
if (dailyReportConfig?.enabled) {
  agent.getAutonomous().on('daily-report', async (report) => {
    const channels = dailyReportConfig.channels ?? [];
    if (channels.includes('telegram') && telegram) {
      for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
        await telegram.sendMessage(String(chatId), report);
      }
    }
    if (channels.includes('whatsapp') && whatsapp) {
      for (const number of config.channels.whatsapp.allowedNumbers ?? []) {
        await whatsapp.sendMessage(number, report);
      }
    }
  });
}

const retentionDays = config.memory?.retentionDays ?? 90;
if (retentionDays > 0) {
  setInterval(() => {
    const pruned = pruneChatMessages(retentionDays);
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} chat message(s) older than ${retentionDays} days.`);
    }
  }, 6 * 60 * 60 * 1000);
}

const intelRetentionDays = config.intel?.retentionDays ?? 30;
if (intelRetentionDays > 0) {
  setInterval(() => {
    const pruned = pruneIntel(intelRetentionDays);
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} intel item(s) older than ${intelRetentionDays} days.`);
    }
  }, 12 * 60 * 60 * 1000);
}

if (telegram) {
  telegram.startPolling(async (msg) => {
    logger.info(`Telegram message from ${msg.senderId}: ${msg.text}`);
    await onIncoming('telegram', msg.senderId, msg.text);
  });
}

async function sendIntelAlerts(
  items: Array<{ title: string; url?: string; source: string; content?: string }>,
  alertsConfig: {
    channels?: string[];
    watchlistOnly?: boolean;
    maxItems?: number;
    includeSources?: string[];
    excludeSources?: string[];
    includeKeywords?: string[];
    excludeKeywords?: string[];
    minKeywordOverlap?: number;
    minTitleLength?: number;
    minSentiment?: number;
    maxSentiment?: number;
    sentimentPreset?: 'any' | 'positive' | 'negative' | 'neutral';
    includeEntities?: string[];
    excludeEntities?: string[];
    minEntityOverlap?: number;
    useContent?: boolean;
    minScore?: number;
    keywordWeight?: number;
    entityWeight?: number;
    sentimentWeight?: number;
    positiveSentimentThreshold?: number;
    negativeSentimentThreshold?: number;
    showScore?: boolean;
    showReasons?: boolean;
    entityAliases?: Record<string, string[]>;
  }
): Promise<void> {
  const settings = {
    channels: alertsConfig.channels ?? [],
    watchlistOnly: alertsConfig.watchlistOnly ?? true,
    maxItems: alertsConfig.maxItems ?? 10,
    includeSources: alertsConfig.includeSources ?? [],
    excludeSources: alertsConfig.excludeSources ?? [],
    includeKeywords: alertsConfig.includeKeywords ?? [],
    excludeKeywords: alertsConfig.excludeKeywords ?? [],
    minKeywordOverlap: alertsConfig.minKeywordOverlap ?? 1,
    minTitleLength: alertsConfig.minTitleLength ?? 8,
    minSentiment: alertsConfig.minSentiment ?? undefined,
    maxSentiment: alertsConfig.maxSentiment ?? undefined,
    sentimentPreset: alertsConfig.sentimentPreset ?? 'any',
    includeEntities: alertsConfig.includeEntities ?? [],
    excludeEntities: alertsConfig.excludeEntities ?? [],
    minEntityOverlap: alertsConfig.minEntityOverlap ?? 1,
    useContent: alertsConfig.useContent ?? true,
    minScore: alertsConfig.minScore ?? 0,
    keywordWeight: alertsConfig.keywordWeight ?? 1,
    entityWeight: alertsConfig.entityWeight ?? 1,
    sentimentWeight: alertsConfig.sentimentWeight ?? 1,
    positiveSentimentThreshold: alertsConfig.positiveSentimentThreshold ?? 0.05,
    negativeSentimentThreshold: alertsConfig.negativeSentimentThreshold ?? -0.05,
    showScore: alertsConfig.showScore ?? false,
    showReasons: alertsConfig.showReasons ?? false,
    entityAliases: alertsConfig.entityAliases ?? {},
  };

  const marketClient = new PolymarketMarketClient(config);
  let watchlistTitles: string[] = [];

  if (settings.watchlistOnly) {
    const watchlist = listWatchlist(50);
    for (const item of watchlist) {
      try {
        const market = await marketClient.getMarket(item.marketId);
        if (market.question) {
          watchlistTitles.push(market.question);
        }
      } catch {
        continue;
      }
    }
  }

  const alerts = rankIntelAlerts(items, settings, watchlistTitles).map((item) => item.text);

  if (alerts.length === 0) {
    return;
  }

  const message = `📰 **Intel Alert**\n\n${alerts.join('\n')}`;
  if (settings.channels.includes('telegram') && telegram) {
    for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
      await telegram.sendMessage(String(chatId), message);
    }
  }
  if (settings.channels.includes('whatsapp') && whatsapp) {
    for (const number of config.channels.whatsapp.allowedNumbers ?? []) {
      await whatsapp.sendMessage(number, message);
    }
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (!whatsapp) {
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/whatsapp/webhook')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === whatsapp.getVerifyToken()) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge ?? '');
      return;
    }
    res.writeHead(403);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/whatsapp/webhook')) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        await whatsapp.handleWebhook(payload, async (msg) => {
          logger.info(`WhatsApp message from ${msg.senderId}: ${msg.text}`);
          await onIncoming('whatsapp', msg.senderId, msg.text);
        });
        res.writeHead(200);
        res.end('ok');
      } catch (err) {
        logger.error('WhatsApp webhook failed', err);
        res.writeHead(500);
        res.end();
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(config.gateway.port, () => {
  logger.info(`Gateway listening on port ${config.gateway.port}`);
});
