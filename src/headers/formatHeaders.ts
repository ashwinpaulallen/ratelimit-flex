/**
 * Input for {@link formatRateLimitHeaders} — framework-agnostic rate-limit snapshot fields.
 *
 * @since 1.4.0
 */
export interface HeaderInput {
  /** Max requests allowed in the window */
  limit: number;
  /** Remaining requests in the current window */
  remaining: number;
  /** When the window resets */
  resetTime: Date;
  /** Whether this request was rate-limited (for `Retry-After`) */
  isBlocked: boolean;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Policy identifier for draft-7/8 (e.g. `"100-per-60"`). Use {@link defaultRateLimitIdentifier} if needed. */
  identifier: string;
}

/**
 * Supported header profiles for {@link formatRateLimitHeaders} (same strings as the `standardHeaders` option: `'legacy'`, `'draft-6'`, `'draft-7'`, `'draft-8'`).
 *
 * @since 1.4.0
 */
export type HeaderFormat = 'legacy' | 'draft-6' | 'draft-7' | 'draft-8';

/**
 * Result of {@link formatRateLimitHeaders}: primary header map and optional legacy `X-RateLimit-*` map.
 *
 * @since 1.4.0
 */
export interface HeaderOutput {
  headers: Record<string, string>;
  legacyHeaders?: Record<string, string>;
}

/**
 * Default policy name: `{limit}-per-{windowSeconds}` (window length in whole seconds, at least 1).
 *
 * @since 1.4.0
 */
export function defaultRateLimitIdentifier(limit: number, windowMs: number): string {
  const w = Math.max(1, Math.ceil(windowMs / 1000));
  return `${limit}-per-${w}`;
}

/**
 * Keeps RFC 8941 `sf-string` safe: printable ASCII only; other code units become `-`.
 *
 * @since 1.4.0
 */
export function sanitizeIdentifierFor8941(id: string): string {
  return id.replace(/[^\x20-\x7E]/g, '-');
}

/**
 * Whole seconds from `nowMs` until `resetTime` (non-negative).
 *
 * @remarks
 * Returns **0** when the reset instant is already in the past (clock skew, slow paths, or stale `resetTime`).
 * **`Retry-After: 0`** is valid per RFC 7231 section 7.1.3 (“retry immediately”). Some clients treat **`0`** as “no wait” and may retry aggressively; that is spec-correct but worth knowing for operators.
 */
function secondsUntilReset(resetTime: Date, nowMs: number): number {
  return Math.max(0, Math.ceil((resetTime.getTime() - nowMs) / 1000));
}

function clampRemaining(n: number): number {
  return Math.max(0, n);
}

function legacyHeaderMap(input: HeaderInput, nowMs: number): Record<string, string> {
  const limit = input.limit;
  const remaining = clampRemaining(input.remaining);
  const resetEpochSec = Math.ceil(input.resetTime.getTime() / 1000);
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(resetEpochSec),
  };
  if (input.isBlocked) {
    headers['Retry-After'] = String(secondsUntilReset(input.resetTime, nowMs));
  }
  return headers;
}

function draft6Headers(input: HeaderInput, nowMs: number): Record<string, string> {
  const limit = input.limit;
  const remaining = clampRemaining(input.remaining);
  const sur = secondsUntilReset(input.resetTime, nowMs);
  const w = Math.ceil(input.windowMs / 1000);
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': String(remaining),
    'RateLimit-Reset': String(sur),
    'RateLimit-Policy': `${limit};w=${w}`,
  };
  if (input.isBlocked) {
    headers['Retry-After'] = String(sur);
  }
  return headers;
}

function draft7Headers(input: HeaderInput, nowMs: number): Record<string, string> {
  const limit = input.limit;
  const remaining = clampRemaining(input.remaining);
  const sur = secondsUntilReset(input.resetTime, nowMs);
  const w = Math.ceil(input.windowMs / 1000);
  const headers: Record<string, string> = {
    RateLimit: `limit=${limit}, remaining=${remaining}, reset=${sur}`,
    'RateLimit-Policy': `${limit};w=${w}`,
  };
  if (input.isBlocked) {
    headers['Retry-After'] = String(sur);
  }
  return headers;
}

/**
 * [draft-08](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-08) profile: **`RateLimit-Policy`** and **`RateLimit`** are distinct fields (section 4). Policy line: `sf-string` policy name + `q` + `w`; quota line: same policy id + `r` (remaining) + `t` (seconds until reset).
 */
function draft8Headers(input: HeaderInput, nowMs: number): Record<string, string> {
  const limit = input.limit;
  const remaining = clampRemaining(input.remaining);
  const sur = secondsUntilReset(input.resetTime, nowMs);
  const w = Math.ceil(input.windowMs / 1000);
  const id = sanitizeIdentifierFor8941(input.identifier);
  const headers: Record<string, string> = {
    'RateLimit-Policy': `"${id}";q=${limit};w=${w}`,
    RateLimit: `"${id}";r=${remaining};t=${sur}`,
  };
  if (input.isBlocked) {
    headers['Retry-After'] = String(sur);
  }
  return headers;
}

/**
 * Pure formatter: builds rate-limit HTTP header name → value maps for a given profile.
 *
 * @description No framework deps. When `includeLegacy` is true and `format` is not `'legacy'`, {@link HeaderOutput.legacyHeaders} contains `X-RateLimit-*` (and `Retry-After` when blocked).
 * @param input - Quota snapshot
 * @param format - Header profile
 * @param includeLegacy - If true and `format !== 'legacy'`, also populate `legacyHeaders`
 * @remarks Blocked responses use the same seconds-until-reset for `Retry-After` and for draft `RateLimit-Reset` / `t=`; that value can be **0** when `resetTime` is already in the past (clock skew, slow paths). See **`secondsUntilReset`** in this module.
 * @since 1.4.0
 */
export function formatRateLimitHeaders(
  input: HeaderInput,
  format: HeaderFormat,
  includeLegacy: boolean,
): HeaderOutput {
  const nowMs = Date.now(); // single snapshot: primary headers and optional legacyHeaders use the same `nowMs`

  let headers: Record<string, string>;
  switch (format) {
    case 'legacy':
      headers = legacyHeaderMap(input, nowMs);
      break;
    case 'draft-6':
      headers = draft6Headers(input, nowMs);
      break;
    case 'draft-7':
      headers = draft7Headers(input, nowMs);
      break;
    case 'draft-8':
      headers = draft8Headers(input, nowMs);
      break;
    default: {
      const exhaustive: never = format;
      throw new Error(`Unsupported header format: ${String(exhaustive)}`);
    }
  }

  if (includeLegacy && format !== 'legacy') {
    return {
      headers,
      legacyHeaders: legacyHeaderMap(input, nowMs),
    };
  }

  return { headers };
}
