/**
 * Normalize a rate-limit cap: finite integers ≥ 1, otherwise `fallback`.
 * Prevents NaN/Infinity/negative values from breaking sliding/fixed window logic.
 */
export function sanitizeRateLimitCap(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n >= 1) {
      return Math.min(n, Number.MAX_SAFE_INTEGER);
    }
  }
  return fallback;
}

/**
 * Per-increment weight: finite integers ≥ 1, otherwise `fallback`.
 *
 * @description Used for {@link RateLimitIncrementOptions.cost} and {@link RateLimitDecrementOptions.cost}.
 * @since 1.3.1
 */
export function sanitizeIncrementCost(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n >= 1) {
      return Math.min(n, Number.MAX_SAFE_INTEGER);
    }
  }
  return fallback;
}

/** Window length in ms: finite integers ≥ 1, otherwise `fallback`. */
export function sanitizeWindowMs(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n >= 1) {
      return Math.min(n, Number.MAX_SAFE_INTEGER);
    }
  }
  return fallback;
}

/** Penalty duration in ms: finite integers ≥ 0, otherwise `fallback`. */
export function sanitizePenaltyDurationMs(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n >= 0) {
      return Math.min(n, Number.MAX_SAFE_INTEGER);
    }
  }
  return fallback;
}
