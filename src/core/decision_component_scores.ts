function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function toFinite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSize(size: number): number {
  return Math.abs(size) / (1 + Math.abs(size));
}

export interface ClosedTradeComponentScoreInput {
  entrySide: 'buy' | 'sell';
  thesisCorrect?: boolean | null;
  size?: number | null;
  expectedEdge?: number | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  pricePathHigh?: number | null;
  pricePathLow?: number | null;
  invalidationPrice?: number | null;
}

export interface ClosedTradeComponentScores {
  directionScore: number;
  timingScore: number;
  sizingScore: number;
  exitScore: number;
  capturedR: number | null;
  leftOnTableR: number | null;
  wouldHit2R: boolean | null;
  wouldHit3R: boolean | null;
}

export function computeClosedTradeComponentScores(
  input: ClosedTradeComponentScoreInput
): ClosedTradeComponentScores {
  const directionScore =
    input.thesisCorrect === true ? 1 : input.thesisCorrect === false ? 0 : 0.5;

  const size = toFinite(input.size);
  const expectedEdge = toFinite(input.expectedEdge);
  const sizingScore =
    size == null || expectedEdge == null
      ? 0.5
      : clamp01(1 - Math.abs(normalizeSize(size) - clamp01(Math.abs(expectedEdge))));

  const entryPrice = toFinite(input.entryPrice);
  const exitPrice = toFinite(input.exitPrice);
  const pathHigh = toFinite(input.pricePathHigh);
  const pathLow = toFinite(input.pricePathLow);

  if (entryPrice == null || entryPrice <= 0) {
    return {
      directionScore,
      timingScore: 0.5,
      sizingScore,
      exitScore: 0.5,
      capturedR: null,
      leftOnTableR: null,
      wouldHit2R: null,
      wouldHit3R: null,
    };
  }

  const high = Math.max(entryPrice, pathHigh ?? entryPrice, pathLow ?? entryPrice, exitPrice ?? entryPrice);
  const low = Math.min(entryPrice, pathHigh ?? entryPrice, pathLow ?? entryPrice, exitPrice ?? entryPrice);
  const range = high - low;

  const timingScore =
    range <= 0
      ? 0.5
      : clamp01(
          input.entrySide === 'buy'
            ? (high - entryPrice) / range
            : (entryPrice - low) / range
        );

  if (exitPrice == null || exitPrice <= 0 || range <= 0) {
    return {
      directionScore,
      timingScore,
      sizingScore,
      exitScore: 0.5,
      capturedR: null,
      leftOnTableR: null,
      wouldHit2R: null,
      wouldHit3R: null,
    };
  }

  const availableMove = input.entrySide === 'buy' ? high - entryPrice : entryPrice - low;
  if (availableMove <= 0) {
    return {
      directionScore,
      timingScore,
      sizingScore,
      exitScore: 0.5,
      capturedR: null,
      leftOnTableR: null,
      wouldHit2R: null,
      wouldHit3R: null,
    };
  }

  const capturedMove = input.entrySide === 'buy' ? exitPrice - entryPrice : entryPrice - exitPrice;
  const exitScore = clamp01(capturedMove / availableMove);
  const invalidationPrice = toFinite(input.invalidationPrice);
  const riskPerUnit =
    invalidationPrice != null ? Math.abs(entryPrice - invalidationPrice) : null;
  const usableRiskPerUnit =
    riskPerUnit != null && Number.isFinite(riskPerUnit) && riskPerUnit > 0 ? riskPerUnit : null;
  const capturedR = usableRiskPerUnit != null ? capturedMove / usableRiskPerUnit : null;
  const leftOnTableMove = Math.max(0, availableMove - Math.max(capturedMove, 0));
  const leftOnTableR =
    usableRiskPerUnit != null ? leftOnTableMove / usableRiskPerUnit : null;
  const wouldHit2R = usableRiskPerUnit != null ? availableMove >= 2 * usableRiskPerUnit : null;
  const wouldHit3R = usableRiskPerUnit != null ? availableMove >= 3 * usableRiskPerUnit : null;

  return {
    directionScore,
    timingScore,
    sizingScore,
    exitScore,
    capturedR,
    leftOnTableR,
    wouldHit2R,
    wouldHit3R,
  };
}
