import { describe, expect, it } from 'vitest';
import { fromExpressRateLimitOptions } from '../../src/compat/expressRateLimitCompat.js';

describe('fromExpressRateLimitOptions', () => {
  it('maps draft-8, legacyHeaders, windowMs, and max to ratelimit-flex fields', () => {
    const out = fromExpressRateLimitOptions({
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      windowMs: 900_000,
      max: 100,
    });
    expect(out).toEqual({
      windowMs: 900_000,
      maxRequests: 100,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    });
  });

  it('maps standardHeaders: true to draft-6 (express-rate-limit semantics)', () => {
    const out = fromExpressRateLimitOptions({ standardHeaders: true });
    expect(out).toEqual({
      standardHeaders: 'draft-6',
      legacyHeaders: false,
    });
  });

  it('maps standardHeaders: false to false (no rate-limit headers)', () => {
    const out = fromExpressRateLimitOptions({ standardHeaders: false });
    expect(out).toEqual({
      standardHeaders: false,
      legacyHeaders: true,
    });
  });
});
