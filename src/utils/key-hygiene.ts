import { createHash } from 'node:crypto';

/**
 * Clamp string length before using untrusted inputs as {@link RateLimitOptions.keyGenerator} output.
 *
 * Use only when shortening is acceptable — prefer stable normalization (tenant id / API-key id).
 *
 * @param input - Candidate key substring
 * @param maxUtf16CodeUnits - Maximum length (**UTF-16 code units**, same unit as `'abc'.length` in JS).
 * @returns Original string if shorter; otherwise prefix of length `maxUtf16CodeUnits`
 * @since 4.2.0
 */
export function truncateStorageKey(input: string, maxUtf16CodeUnits = 512): string {
  if (input.length <= maxUtf16CodeUnits) return input;
  return input.slice(0, maxUtf16CodeUnits);
}

/**
 * Deterministic fingerprint for hashing high-cardinality or sensitive strings into opaque keys.
 *
 * Returns **hex** SHA-256 (**64** chars unless `hexLength` is set lower). Prefer **explicit** truncation of the source before hashing when you already know collision trade-offs (e.g. first 128 bits → `hexLength = 32`).
 *
 * @param input - Payload to fingerprint
 * @param hexLength - Truncate hex digest prefix (minimum 8; clamped upwards if below)
 * @since 4.2.0
 */
export function hashStorageKeyFingerprint(input: string, hexLength = 64): string {
  const full = createHash('sha256').update(input).digest('hex');
  const n = Math.min(64, Math.max(8, hexLength));
  return full.slice(0, n);
}

/**
 * Remove IPv6 scoped **zone identifier** suffix (`fe80::1%eth0 → fe80::1`) for deterministic IP keys.
 * Does **not** validate that the remainder is an IP — pair with trusted proxy extraction.
 *
 * @since 4.2.0
 */
export function stripIpV6ZoneId(candidate: string): string {
  const i = candidate.indexOf('%');
  return i >= 0 ? candidate.slice(0, i) : candidate;
}
