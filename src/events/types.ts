/**
 * Causal event reasoning types — v1.95
 *
 * Core loop: intel → event → thought → forecast → outcome
 */

// ---------------------------------------------------------------------------
// NormalizedEvent
// ---------------------------------------------------------------------------

export type EventStatus = 'active' | 'superseded';

export interface NormalizedEvent {
  id: string;
  /** Stable deterministic key for deduplication (hash of title+date+domain). */
  eventKey: string;
  /** Short human-readable title for the event. */
  title: string;
  /** Broad market domain: 'crypto', 'energy', 'agri', 'macro', 'equity', etc. */
  domain: string;
  /** ISO8601 timestamp of when the event occurred (not ingested). */
  occurredAt: string;
  /** IDs from intel_items that triggered or confirmed this event. */
  sourceIntelIds: string[];
  /** Mechanism/category tags e.g. ['supply_shock', 'export_ban']. */
  tags: string[];
  status: EventStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedEventInput {
  title: string;
  domain: string;
  occurredAt: string;
  sourceIntelIds?: string[];
  tags?: string[];
  status?: EventStatus;
}

// ---------------------------------------------------------------------------
// EventThought
// ---------------------------------------------------------------------------

export interface ImpactedAsset {
  /** Ticker or commodity symbol e.g. 'BTC', 'WHEAT', 'CL1'. */
  symbol: string;
  /** Expected directional impact. */
  direction: 'up' | 'down' | 'neutral';
  /** 0–1 confidence the direction is correct. */
  confidence: number;
}

export interface EventThought {
  id: string;
  eventId: string;
  /** Monotonically increasing version number within the same event. */
  version: number;
  /** Plain-English description of the causal mechanism. */
  mechanism: string;
  /** Ordered list of causal steps: trigger → propagation → outcome. */
  causalChain: string[];
  /** Assets expected to be affected by this event. */
  impactedAssets: ImpactedAsset[];
  /** Conditions that would falsify or invalidate this thought. */
  invalidationConditions: string[];
  /** Model or analyst tag that produced this thought. */
  modelVersion?: string;
  createdAt: string;
}

export interface EventThoughtInput {
  eventId: string;
  mechanism: string;
  causalChain: string[];
  impactedAssets: ImpactedAsset[];
  invalidationConditions: string[];
  modelVersion?: string;
}

// ---------------------------------------------------------------------------
// EventForecast
// ---------------------------------------------------------------------------

export type ForecastDirection = 'up' | 'down' | 'neutral';
export type ForecastStatus = 'open' | 'confirmed' | 'invalidated' | 'expired';

export interface EventForecast {
  id: string;
  eventId: string;
  thoughtId: string;
  /** The asset or instrument being forecast. */
  asset: string;
  /** Domain of the asset for context-aware retrieval. */
  domain: string;
  direction: ForecastDirection;
  /** Forecast horizon in hours from createdAt. */
  horizonHours: number;
  /** 0–1 confidence in the direction within the horizon. */
  confidence: number;
  /** Conditions that would invalidate this forecast before resolution. */
  invalidationConditions: string[];
  status: ForecastStatus;
  /** ISO8601 — when this forecast expires if not resolved. */
  expiresAt: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface EventForecastInput {
  eventId: string;
  thoughtId: string;
  asset: string;
  domain: string;
  direction: ForecastDirection;
  horizonHours: number;
  confidence: number;
  invalidationConditions?: string[];
}

// ---------------------------------------------------------------------------
// EventOutcome
// ---------------------------------------------------------------------------

export type OutcomeResolutionStatus =
  | 'confirmed'
  | 'invalidated'
  | 'expired'
  | 'error';

export type ActualDirection = 'up' | 'down' | 'neutral' | 'unknown';

export interface EventOutcome {
  id: string;
  forecastId: string;
  eventId: string;
  resolutionStatus: OutcomeResolutionStatus;
  /** Human-readable explanation of the resolution. */
  resolutionNote?: string;
  actualDirection: ActualDirection;
  /** Price at resolution time if available. */
  resolutionPrice?: number;
  resolvedAt: string;
  createdAt: string;
}

export interface EventOutcomeInput {
  forecastId: string;
  eventId: string;
  resolutionStatus: OutcomeResolutionStatus;
  resolutionNote?: string;
  actualDirection: ActualDirection;
  resolutionPrice?: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_DOMAINS = new Set([
  'crypto',
  'energy',
  'agri',
  'macro',
  'equity',
  'rates',
  'fx',
  'metals',
  'other',
]);

const VALID_DIRECTIONS = new Set<string>(['up', 'down', 'neutral']);
const VALID_FORECAST_STATUSES = new Set<string>([
  'open',
  'confirmed',
  'invalidated',
  'expired',
]);
const VALID_OUTCOME_STATUSES = new Set<string>([
  'confirmed',
  'invalidated',
  'expired',
  'error',
]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateEventInput(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['input must be an object'] };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.title !== 'string' || obj.title.trim() === '') {
    errors.push('title must be a non-empty string');
  }
  if (typeof obj.domain !== 'string' || !VALID_DOMAINS.has(obj.domain)) {
    errors.push(`domain must be one of: ${[...VALID_DOMAINS].join(', ')}`);
  }
  if (typeof obj.occurredAt !== 'string' || obj.occurredAt.trim() === '') {
    errors.push('occurredAt must be a non-empty ISO8601 string');
  }

  return { valid: errors.length === 0, errors };
}

export function validateThoughtInput(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['input must be an object'] };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.eventId !== 'string' || obj.eventId.trim() === '') {
    errors.push('eventId must be a non-empty string');
  }
  if (typeof obj.mechanism !== 'string' || obj.mechanism.trim() === '') {
    errors.push('mechanism must be a non-empty string');
  }
  if (!Array.isArray(obj.causalChain) || obj.causalChain.length === 0) {
    errors.push('causalChain must be a non-empty array');
  }
  if (!Array.isArray(obj.impactedAssets) || obj.impactedAssets.length === 0) {
    errors.push('impactedAssets must be a non-empty array');
  } else {
    for (const asset of obj.impactedAssets as unknown[]) {
      if (!asset || typeof asset !== 'object') {
        errors.push('each impactedAsset must be an object');
        break;
      }
      const a = asset as Record<string, unknown>;
      if (typeof a.symbol !== 'string' || a.symbol.trim() === '') {
        errors.push('each impactedAsset must have a symbol');
        break;
      }
      if (!VALID_DIRECTIONS.has(String(a.direction))) {
        errors.push(`impactedAsset direction must be one of: up, down, neutral`);
        break;
      }
      if (typeof a.confidence !== 'number' || a.confidence < 0 || a.confidence > 1) {
        errors.push('impactedAsset confidence must be a number 0–1');
        break;
      }
    }
  }
  if (!Array.isArray(obj.invalidationConditions)) {
    errors.push('invalidationConditions must be an array');
  }

  return { valid: errors.length === 0, errors };
}

export function validateForecastInput(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['input must be an object'] };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.eventId !== 'string' || obj.eventId.trim() === '') {
    errors.push('eventId must be a non-empty string');
  }
  if (typeof obj.thoughtId !== 'string' || obj.thoughtId.trim() === '') {
    errors.push('thoughtId must be a non-empty string');
  }
  if (typeof obj.asset !== 'string' || obj.asset.trim() === '') {
    errors.push('asset must be a non-empty string');
  }
  if (typeof obj.domain !== 'string' || !VALID_DOMAINS.has(obj.domain)) {
    errors.push(`domain must be one of: ${[...VALID_DOMAINS].join(', ')}`);
  }
  if (!VALID_DIRECTIONS.has(String(obj.direction))) {
    errors.push('direction must be one of: up, down, neutral');
  }
  if (typeof obj.horizonHours !== 'number' || obj.horizonHours <= 0) {
    errors.push('horizonHours must be a positive number');
  }
  if (
    typeof obj.confidence !== 'number' ||
    obj.confidence < 0 ||
    obj.confidence > 1
  ) {
    errors.push('confidence must be a number 0–1');
  }

  return { valid: errors.length === 0, errors };
}

export function validateForecastStatus(status: unknown): status is ForecastStatus {
  return VALID_FORECAST_STATUSES.has(String(status));
}

export function validateOutcomeInput(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['input must be an object'] };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.forecastId !== 'string' || obj.forecastId.trim() === '') {
    errors.push('forecastId must be a non-empty string');
  }
  if (typeof obj.eventId !== 'string' || obj.eventId.trim() === '') {
    errors.push('eventId must be a non-empty string');
  }
  if (!VALID_OUTCOME_STATUSES.has(String(obj.resolutionStatus))) {
    errors.push('resolutionStatus must be one of: confirmed, invalidated, expired, error');
  }
  if (!['up', 'down', 'neutral', 'unknown'].includes(String(obj.actualDirection))) {
    errors.push('actualDirection must be one of: up, down, neutral, unknown');
  }

  return { valid: errors.length === 0, errors };
}
