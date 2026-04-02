import type { RateLimitOptions } from '../types/index.js';

const STANDARD_HEADER_STRINGS = new Set(['legacy', 'draft-6', 'draft-7', 'draft-8']);

let hasWarnedNonAsciiIdentifier = false;

/**
 * Resets the one-time non-ASCII identifier `console.warn` guard. For unit tests only.
 */
export function resetNonAsciiIdentifierWarningForTests(): void {
  hasWarnedNonAsciiIdentifier = false;
}

function isInvalidStandardHeaders(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (value === true || value === false) {
    return false;
  }
  if (typeof value === 'string') {
    return !STANDARD_HEADER_STRINGS.has(value);
  }
  return true;
}

function formatStandardHeadersError(value: unknown): string {
  const shown =
    typeof value === 'string'
      ? `'${value}'`
      : typeof value === 'symbol'
        ? String(value)
        : `'${String(value)}'`;
  return `standardHeaders must be one of: 'legacy', 'draft-6', 'draft-7', 'draft-8', true, or false. Got: ${shown}`;
}

/**
 * Validates `standardHeaders` and `identifier` on user-supplied options.
 */
export function validateRateLimitHeaderOptions(options: Partial<RateLimitOptions>): void {
  const sh = options.standardHeaders;
  if (isInvalidStandardHeaders(sh)) {
    throw new Error(formatStandardHeadersError(sh));
  }

  const id = options.identifier;
  if (id !== undefined && typeof id !== 'string') {
    throw new TypeError('identifier must be a string when provided');
  }
  if (
    typeof id === 'string' &&
    [...id].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f) &&
    !hasWarnedNonAsciiIdentifier
  ) {
    hasWarnedNonAsciiIdentifier = true;
    console.warn(
      '[ratelimit-flex] identifier contains non-ASCII characters; they will be sanitized for RFC 8941 policy names.',
    );
  }
}
