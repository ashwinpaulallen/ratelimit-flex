import { afterEach, describe, expect, it } from 'vitest';
import { getLimit, mergeRateLimiterOptions } from '../../src/middleware/merge-options.js';
import type { RateLimitStore } from '../../src/types/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('merge / getLimit invariants (bounded random exploration)', () => {
  const stores: RateLimitStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((s) => s.shutdown()));
  });

  it('limits[] min cap matches getLimit for sampled permutations', () => {
    for (let seed = 0; seed < 400; seed++) {
      const slots = [1, 2, 3].map((i) => ({
        windowMs: 5000 + ((seed * i * 17) % 50_000),
        max: 5 + ((seed * 13 * i) % 200),
      }));
      const merged = mergeRateLimiterOptions({
        limits: slots,
        strategy: RateLimitStrategy.SLIDING_WINDOW,
      });
      stores.push(merged.store);
      const expected = Math.min(...slots.map((s) => s.max));
      expect(getLimit(merged)).toBe(expected);
    }
  });
});
