import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';

import { mergeRateLimiterOptions } from '../../src/middleware/merge-options.js';
import {
  decrementStoresAfterConsumeAsync,
} from '../../src/middleware/decrement-stores-after-consume.js';
import { failoverPreset } from '../../src/composition/index.js';
import { dynamoPreset } from '../../src/presets/dynamo.js';
import {
  authEndpointPreset,
  hybridWindowsPreset,
  multiInstancePreset,
  publicApiPreset,
  redisWithShieldPreset,
  resilientRedisPreset,
  singleInstancePreset,
} from '../../src/presets/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import type { RateLimitOptions } from '../../src/types/index.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import type { RedisLikeClient } from '../../src/stores/redis-store.js';

function mockRedisClient(overrides: Partial<RedisLikeClient> = {}): RedisLikeClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

/** Deep walk public option graph; skips functions/class instances deeply (stops at object boundary). */
function collectPrimitivesDeep(root: unknown): Set<string | number | boolean | bigint | symbol> {
  const out = new Set<string | number | boolean | bigint | symbol>();
  const seen = new WeakSet<object>();

  function visit(v: unknown): void {
    if (v === null || v === undefined) {
      return;
    }
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') {
      out.add(v as never);
      return;
    }
    if (t === 'function') {
      return;
    }
    if (typeof v !== 'object') {
      return;
    }
    if (seen.has(v as object)) {
      return;
    }
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (const item of v) {
        visit(item);
      }
      return;
    }
    for (const val of Object.values(v as Record<string, unknown>)) {
      visit(val);
    }
  }

  visit(root);
  return out;
}

describe('rollback helpers — decrement cost pairing', () => {
  it('decrementStoresAfterConsumeAsync fans out matching decrement cost across grouped stores', async () => {
    const groupedA = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });
    const groupedB = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });
    const main = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });

    const spyA = vi.spyOn(groupedA, 'decrement');
    const spyB = vi.spyOn(groupedB, 'decrement');

    const merged = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      store: main,
      incrementCost: 11,
      groupedWindowStores: [
        { label: 'a', maxRequests: 100, store: groupedA },
        { label: 'b', maxRequests: 100, store: groupedB },
      ],
    } as RateLimitOptions);

    await decrementStoresAfterConsumeAsync(merged, 'k', {});

    expect(spyA).toHaveBeenCalledWith('k', { cost: 11 });
    expect(spyB).toHaveBeenCalledWith('k', { cost: 11 });

    await Promise.all([main.shutdown(), groupedA.shutdown(), groupedB.shutdown()]);
  });

  it('decrementStoresAfterConsumeAsync passes dynamic incrementCost resolved from req', async () => {
    const groupedA = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });
    const main = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });

    const spy = vi.spyOn(groupedA, 'decrement');
    const merged = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      store: main,
      incrementCost: (req: unknown) => Number((req as { weight?: number }).weight ?? 1),
      groupedWindowStores: [{ label: 'group', maxRequests: 100, store: groupedA }],
    } as RateLimitOptions);

    await decrementStoresAfterConsumeAsync(merged, 'rk', { weight: 33 });
    expect(spy).toHaveBeenCalledWith('rk', { cost: 33 });

    await Promise.all([main.shutdown(), groupedA.shutdown()]);
  });
});

describe('preset security surface (contract)', () => {
  /** Strings that must never appear in preset merge output primitives (guards leaked dev-only admin wiring). */
  const forbiddenSubstring = 'unsafe-no-auth';

  it('merged presets omit KeyManager mounts and forbid unsafe-no-auth primitives', async () => {
    const presetsToMerge = (): RateLimitOptions[] => [
      mergeRateLimiterOptions(singleInstancePreset()),
      mergeRateLimiterOptions(multiInstancePreset({ client: mockRedisClient() })),
      mergeRateLimiterOptions(resilientRedisPreset({ client: mockRedisClient() })),
      mergeRateLimiterOptions(authEndpointPreset({ client: mockRedisClient() })),
      mergeRateLimiterOptions(publicApiPreset()),
      mergeRateLimiterOptions(redisWithShieldPreset({ client: mockRedisClient() })),
      mergeRateLimiterOptions(hybridWindowsPreset() as Partial<RateLimitOptions>),
      mergeRateLimiterOptions(
        dynamoPreset({
          client: {} as DynamoDBDocumentClient,
          tableName: 'preset-contract',
        }),
      ),
      mergeRateLimiterOptions(
        failoverPreset(
          [
            {
              label: 'p',
              store: new MemoryStore({
                strategy: RateLimitStrategy.FIXED_WINDOW,
                windowMs: 60_000,
                maxRequests: 5,
              }),
            },
            {
              label: 'f',
              store: new MemoryStore({
                strategy: RateLimitStrategy.FIXED_WINDOW,
                windowMs: 60_000,
                maxRequests: 50,
              }),
            },
          ],
          { maxRequests: 5 },
        ),
      ),
    ];

    const samples = presetsToMerge();
    try {
      for (const merged of samples) {
        expect(merged.keyManager, 'preset must not silently attach KeyManager').toBeUndefined();

        const prim = collectPrimitivesDeep(merged);
        for (const p of prim) {
          if (typeof p !== 'string') {
            continue;
          }
          expect(p.includes(forbiddenSubstring), JSON.stringify({ hit: p })).toBe(false);
        }
      }
    } finally {
      await Promise.all(samples.map((s) => s.store.shutdown().catch(() => {})));
    }
  });
});
