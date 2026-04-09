/**
 * Shared helpers for Postgres / MongoDB-backed rate limit stores (and similar layers).
 */

/** Coerce DB/driver values to a finite number or NaN (matches JSONB / BSON looseness). */
export function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  if (typeof v === 'bigint') {
    return Number(v);
  }
  return NaN;
}

/** Token-bucket refill in whole intervals (aligned with MemoryStore). */
export function refillBucketState(
  tokens: number,
  lastRefillMs: number,
  now: number,
  bucketSize: number,
  tokensPerInterval: number,
  intervalMs: number,
): { tokens: number; lastRefillMs: number } {
  let t = tokens;
  let lr = lastRefillMs;
  const elapsed = now - lr;
  const intervals = Math.floor(elapsed / intervalMs);
  if (intervals > 0) {
    t = Math.min(bucketSize, t + intervals * tokensPerInterval);
    lr += intervals * intervalMs;
  }
  return { tokens: t, lastRefillMs: lr };
}

/**
 * Sliding-window reset time: **oldest hit + windowMs** (Rate-Limit-Reset semantics).
 * Empty `stamps` uses `nowMs + windowMs` (same as a synthetic empty window).
 */
export function resetTimeDateFromSlidingStamps(
  stamps: readonly number[],
  windowMs: number,
  nowMs: number,
): Date {
  if (stamps.length === 0) {
    return new Date(nowMs + windowMs);
  }
  return new Date(Math.min(...stamps) + windowMs);
}
