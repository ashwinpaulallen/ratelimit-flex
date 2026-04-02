import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeRateLimiterOptions } from '../src/middleware/merge-options.js';
import { resetNonAsciiIdentifierWarningForTests } from '../src/middleware/validate-header-options.js';
import { createRateLimiter } from '../src/strategies/rate-limit-engine.js';
import { RateLimitStrategy } from '../src/types/index.js';

describe('validateRateLimitHeaderOptions', () => {
  beforeEach(() => {
    resetNonAsciiIdentifierWarningForTests();
  });

  afterEach(() => {
    resetNonAsciiIdentifierWarningForTests();
  });

  it('throws for invalid standardHeaders string', () => {
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: 'draft-99' as unknown as 'draft-6',
      }),
    ).toThrow(
      "standardHeaders must be one of: 'legacy', 'draft-6', 'draft-7', 'draft-8', true, or false. Got: 'draft-99'",
    );
  });

  it('throws for non-boolean non-string standardHeaders', () => {
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: 1 as unknown as boolean,
      }),
    ).toThrow(
      "standardHeaders must be one of: 'legacy', 'draft-6', 'draft-7', 'draft-8', true, or false. Got: '1'",
    );
  });

  it('throws when identifier is not a string', () => {
    expect(() =>
      mergeRateLimiterOptions({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        identifier: 123 as unknown as string,
      }),
    ).toThrow('identifier must be a string when provided');
  });

  it('warns when identifier contains non-ASCII characters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* no-op */
    });
    mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      identifier: 'café',
    });
    expect(warn).toHaveBeenCalledWith(
      '[ratelimit-flex] identifier contains non-ASCII characters; they will be sanitized for RFC 8941 policy names.',
    );
    warn.mockRestore();
  });

  it('warns at most once per process for non-ASCII identifiers (even across multiple merges)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* no-op */
    });
    mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      identifier: 'café',
    });
    mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      identifier: 'naïve',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('createRateLimiter validates standardHeaders', () => {
    expect(() =>
      createRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: 'bad' as unknown as 'draft-6',
      }),
    ).toThrow(
      "standardHeaders must be one of: 'legacy', 'draft-6', 'draft-7', 'draft-8', true, or false. Got: 'bad'",
    );
  });
});
