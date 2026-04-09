/**
 * Weighted fixed sub-window model for approximate sliding window rate limiting.
 *
 * @see DynamoStore — persists state in DynamoDB
 */

/** Start of the fixed window slice containing `now` (epoch ms). */
export function fixedWindowBoundaryMs(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/**
 * Linear decay weight for the previous sub-window: 1 at window start → 0 at window end.
 */
export function slidingWeight(
  nowMs: number,
  windowMs: number,
  currentWindowStartMs: number,
): number {
  const elapsedInCurrent = nowMs - currentWindowStartMs;
  if (elapsedInCurrent <= 0) {
    return 1;
  }
  if (elapsedInCurrent >= windowMs) {
    return 0;
  }
  return 1 - elapsedInCurrent / windowMs;
}

/**
 * Approximate sliding-window usage from two sub-window counters.
 */
export function weightedSlidingCount(
  previousCount: number,
  currentCount: number,
  nowMs: number,
  windowMs: number,
  currentWindowStartMs: number,
): number {
  const w = slidingWeight(nowMs, windowMs, currentWindowStartMs);
  return previousCount * w + currentCount;
}

/** TTL epoch seconds — keep rows long enough for two-window math + slack. */
export function ttlEpochSeconds(nowMs: number, windowMs: number): number {
  return Math.ceil((nowMs + 3 * windowMs) / 1000);
}

/**
 * In-memory simulation of one increment (same branching rules as DynamoStore UpdateItem sequence).
 * Used by tests and for validating approximation bounds.
 */
export function simulateWeightedIncrement(
  state: WeightedWindowState | null,
  nowMs: number,
  windowMs: number,
  cost: number,
): WeightedWindowState {
  const thisBoundary = fixedWindowBoundaryMs(nowMs, windowMs);

  if (state === null) {
    return {
      currentWindowStart: thisBoundary,
      currentCount: cost,
      previousCount: 0,
    };
  }

  const { currentWindowStart, currentCount, previousCount } = state;

  if (currentWindowStart === thisBoundary) {
    return {
      currentWindowStart,
      currentCount: currentCount + cost,
      previousCount,
    };
  }

  if (currentWindowStart + windowMs === thisBoundary) {
    return {
      currentWindowStart: thisBoundary,
      previousCount: currentCount,
      currentCount: cost,
    };
  }

  if (currentWindowStart + windowMs < thisBoundary) {
    return {
      currentWindowStart: thisBoundary,
      previousCount: 0,
      currentCount: cost,
    };
  }

  // Clock moved backward vs stored window (skew): treat as reset into current boundary.
  return {
    currentWindowStart: thisBoundary,
    previousCount: 0,
    currentCount: cost,
  };
}

export interface WeightedWindowState {
  currentWindowStart: number;
  currentCount: number;
  previousCount: number;
}
