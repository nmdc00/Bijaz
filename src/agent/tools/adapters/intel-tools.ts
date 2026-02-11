/**
 * Intel Tools Adapter
 *
 * Wraps existing intel/news-related tools from tool-executor.ts.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { executeToolCall, type ToolExecutorContext } from '../../../core/tool-executor.js';
import { listRecentIntel, searchIntel } from '../../../intel/store.js';

const DEFAULT_CACHE_TTL = 30_000; // 30 seconds

/**
 * Convert ToolContext to ToolExecutorContext.
 */
function toExecutorContext(ctx: ToolContext): ToolExecutorContext {
  return ctx as unknown as ToolExecutorContext;
}

/**
 * Intel search tool - search the intel database.
 */
export const intelSearchTool: ToolDefinition = {
  name: 'intel_search',
  description: 'Search the intel/news database for recent information about a topic.',
  category: 'intel',
  schema: z.object({
    query: z.string().describe('Search query for intel'),
    limit: z.number().optional().describe('Maximum results (default: 5)'),
    from_days: z.number().optional().describe('Only search within last N days (default: 14)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('intel_search', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Intel search tool (dot-notation alias).
 */
export const intelSearchAliasTool: ToolDefinition = {
  name: 'intel.search',
  description: 'Search the intel/news database for recent information about a topic.',
  category: 'intel',
  schema: z.object({
    query: z.string().describe('Search query for intel'),
    limit: z.number().optional().describe('Maximum results (default: 5)'),
    from_days: z.number().optional().describe('Only search within last N days (default: 14)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('intel_search', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Intel recent tool - get recent intel items.
 */
export const intelRecentTool: ToolDefinition = {
  name: 'intel_recent',
  description: 'Get the most recent intel/news items. Use when user asks for updates.',
  category: 'intel',
  schema: z.object({
    limit: z.number().optional().describe('Number of items (default: 10)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('intel_recent', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Twitter search tool - search recent tweets.
 */
export const twitterSearchTool: ToolDefinition = {
  name: 'twitter_search',
  description: 'Search recent tweets via Twitter API. Use to find real-time discussion on a topic.',
  category: 'intel',
  schema: z.object({
    query: z.string().describe('Search query for Twitter (e.g., "Palantir earnings")'),
    limit: z.number().optional().describe('Maximum number of results (default: 10, max: 50)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('twitter_search', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 60_000, // 1 minute for social data
};

/**
 * Proactive search run tool - trigger iterative proactive research loop now.
 */
export const proactiveSearchRunTool: ToolDefinition = {
  name: 'proactive_search_run',
  description:
    'Run iterative proactive web research now and store findings into intel memory.',
  category: 'intel',
  schema: z.object({
    max_queries: z.number().optional().describe('Maximum queries to run (default: 8)'),
    iterations: z.number().optional().describe('Research rounds (default: 2, max: 3)'),
    watchlist_limit: z.number().optional().describe('Watchlist seed limit (default: 20)'),
    use_llm: z.boolean().optional().describe('Use LLM for query refinement/follow-up'),
    recent_intel_limit: z.number().optional().describe('Recent intel seed limit (default: 25)'),
    extra_queries: z.array(z.string()).optional().describe('Additional seed queries'),
    include_learned_queries: z
      .boolean()
      .optional()
      .describe('Include learned query seeds (default: true)'),
    learned_query_limit: z.number().optional().describe('Max learned seeds (default: 8)'),
    web_limit_per_query: z.number().optional().describe('Web results per query (default: 5)'),
    fetch_per_query: z.number().optional().describe('Fetched pages per query (default: 1)'),
    fetch_max_chars: z.number().optional().describe('Max chars per fetched page (default: 4000)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall(
      'proactive_search_run',
      input as Record<string, unknown>,
      toExecutorContext(ctx)
    );
  },
  sideEffects: true,
  requiresConfirmation: false,
  cacheTtlMs: 0,
};

/**
 * Comments get tool - fetch recent market discussion items from intel store.
 */
const commentsGetSchema = z.object({
  query: z.string().optional().describe('Optional search query to filter comments'),
  limit: z.number().optional().describe('Maximum results (default: 10, max: 50)'),
  from_days: z.number().optional().describe('Only include comments from the last N days (default: 14)'),
});

export const commentsGetTool: ToolDefinition = {
  name: 'comments.get',
  description: 'Get recent market discussion items stored in intel. Useful for sentiment and user discussion.',
  category: 'intel',
  schema: commentsGetSchema,
  execute: async (input, _ctx): Promise<ToolResult> => {
    const payload = input as { query?: unknown; limit?: unknown; from_days?: unknown };
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    const limit = Math.min(Math.max(Number(payload.limit ?? 10), 1), 50);
    const fromDays = Number(payload.from_days ?? 14);

    const items = query
      ? searchIntel({ query, limit, fromDays })
      : listRecentIntel(Math.max(limit * 2, 20));

    const comments = items.filter((item) => {
      const source = item.source?.toLowerCase?.() ?? '';
      return source.includes('comment') || source.includes('discussion');
    });

    return { success: true, data: comments.slice(0, limit) };
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * All intel tools.
 */
export const intelTools: ToolDefinition[] = [
  intelSearchTool,
  intelSearchAliasTool,
  intelRecentTool,
  twitterSearchTool,
  proactiveSearchRunTool,
  commentsGetTool,
];
