import { describe, expect, it } from 'vitest';
import { defaultRateLimitIdentifier, formatRateLimitHeaders } from '../../src/headers/formatHeaders.js';

describe('formatRateLimitHeaders — extreme inputs', () => {
  const mk = (over: Partial<Parameters<typeof formatRateLimitHeaders>[0]>) => ({
    limit: Number.MAX_SAFE_INTEGER,
    remaining: Number.MAX_SAFE_INTEGER,
    resetTime: new Date(8_640_000_000_000),
    isBlocked: false,
    windowMs: 86_400_000,
    identifier: defaultRateLimitIdentifier(100, 60_000),
    ...over,
  });

  const formats = ['legacy', 'draft-6', 'draft-7', 'draft-8'] as const;

  for (const fmt of formats) {
    it(`never throws for enormous numerics (${fmt})`, () => {
      const { headers } = formatRateLimitHeaders(mk({ isBlocked: false }), fmt, false);
      for (const v of Object.values(headers)) {
        expect(v).toEqual(expect.any(String));
        expect(v.length).toBeGreaterThan(0);
      }
    });
  }

  it('blocked Retry-After remains numeric string for legacy', () => {
    const { headers } = formatRateLimitHeaders(
      mk({ isBlocked: true, remaining: 0 }),
      'legacy',
      false,
    );
    expect(headers['Retry-After']).toMatch(/^\d+$/);
  });
});
