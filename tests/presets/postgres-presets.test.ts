import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeRateLimiterOptions } from '../../src/middleware/merge-options.js';
import {
  failClosedPostgresPreset,
  postgresInsuranceMemoryStore,
  postgresPreset,
  resilientPostgresPreset,
} from '../../src/presets/index.js';
import { PgStore } from '../../src/stores/postgres/PgStore.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

function mockPgPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
}

function memoryMaxRequests(store: MemoryStore): number {
  return (store as unknown as { maxRequests: number }).maxRequests;
}

function pgStoreLimits(store: PgStore): {
  maxRequests: number;
  windowMs: number;
  strategy: RateLimitStrategy;
} {
  const s = store as unknown as {
    maxRequests: number;
    windowMs: number;
    strategy: RateLimitStrategy;
  };
  return { maxRequests: s.maxRequests, windowMs: s.windowMs, strategy: s.strategy };
}

function pgStoreTokenBucket(store: PgStore): {
  bucketSize: number;
  tokensPerInterval: number;
  refillIntervalMs: number;
} {
  const s = store as unknown as {
    bucketSize: number;
    tokensPerInterval: number;
    refillIntervalMs: number;
  };
  return {
    bucketSize: s.bucketSize,
    tokensPerInterval: s.tokensPerInterval,
    refillIntervalMs: s.refillIntervalMs,
  };
}

const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(shutdowns.splice(0).map((fn) => fn()));
});

describe('postgresPreset', () => {
  it('returns sliding window PgStore with draft-6, shield, and legacyHeaders false', () => {
    const pool = mockPgPool();
    const p = postgresPreset({ pool });
    expect(p.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
    expect(p.windowMs).toBe(60_000);
    expect(p.maxRequests).toBe(100);
    expect(p.standardHeaders).toBe('draft-6');
    expect(p.legacyHeaders).toBe(false);
    expect(p.inMemoryBlock).toBe(true);
    expect(p.store).toBeInstanceOf(PgStore);
  });

  it('merges overrides after defaults', () => {
    const pool = mockPgPool();
    const p = postgresPreset({ pool }, { maxRequests: 333, identifier: 'api' });
    expect(p.maxRequests).toBe(333);
    expect(p.identifier).toBe('api');
  });

  it('builds PgStore from merged limits so overrides apply to the store', () => {
    const pool = mockPgPool();
    const p = postgresPreset(
      { pool },
      { maxRequests: 500, windowMs: 120_000, strategy: RateLimitStrategy.FIXED_WINDOW },
    );
    expect(pgStoreLimits(p.store as PgStore)).toEqual({
      maxRequests: 500,
      windowMs: 120_000,
      strategy: RateLimitStrategy.FIXED_WINDOW,
    });
  });

  it('forwards token bucket fields to PgStore', () => {
    const pool = mockPgPool();
    const p = postgresPreset(
      { pool },
      {
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        bucketSize: 200,
        tokensPerInterval: 20,
        interval: 30_000,
      },
    );
    expect(pgStoreLimits(p.store as PgStore).strategy).toBe(RateLimitStrategy.TOKEN_BUCKET);
    expect(pgStoreTokenBucket(p.store as PgStore)).toEqual({
      bucketSize: 200,
      tokensPerInterval: 20,
      refillIntervalMs: 30_000,
    });
  });

  it('fail-open: merged middleware allows traffic when Postgres errors', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('db down')),
      connect: vi.fn(),
    };
    const p = postgresPreset({ pool });
    const merged = mergeRateLimiterOptions(p);
    shutdowns.push(() => merged.store.shutdown());
    const r = await merged.store.increment('k');
    expect(r.isBlocked).toBe(false);
    expect(r.storeUnavailable).toBe(true);
  });
});

describe('failClosedPostgresPreset', () => {
  it('uses fail-closed PgStore and strips estimatedWorkers from the preset object', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('db down')),
      connect: vi.fn(),
    };
    const p = failClosedPostgresPreset(
      { pool },
      { maxRequests: 40, estimatedWorkers: 7 },
    );
    expect((p as { estimatedWorkers?: number }).estimatedWorkers).toBeUndefined();
    expect(p.maxRequests).toBe(40);
    const merged = mergeRateLimiterOptions(p);
    shutdowns.push(() => merged.store.shutdown());
    const r = await merged.store.increment('k');
    expect(r.isBlocked).toBe(true);
    expect(r.storeUnavailable).toBe(true);
  });

  it('merges rate limit fields without estimatedWorkers leaking', () => {
    const pool = mockPgPool();
    const p = failClosedPostgresPreset({ pool }, { estimatedWorkers: 3 });
    expect((p as { estimatedWorkers?: number }).estimatedWorkers).toBeUndefined();
  });

  it('builds fail-closed PgStore from merged strategy and windowMs', () => {
    const pool = mockPgPool();
    const p = failClosedPostgresPreset(
      { pool },
      { maxRequests: 400, windowMs: 30_000, strategy: RateLimitStrategy.FIXED_WINDOW },
    );
    expect(pgStoreLimits(p.store as PgStore)).toEqual({
      maxRequests: 400,
      windowMs: 30_000,
      strategy: RateLimitStrategy.FIXED_WINDOW,
    });
  });

  it('forwards token bucket fields to fail-closed PgStore', () => {
    const pool = mockPgPool();
    const p = failClosedPostgresPreset(
      { pool },
      {
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        bucketSize: 200,
        tokensPerInterval: 20,
        interval: 30_000,
      },
    );
    expect(pgStoreLimits(p.store as PgStore).strategy).toBe(RateLimitStrategy.TOKEN_BUCKET);
    expect(pgStoreTokenBucket(p.store as PgStore)).toEqual({
      bucketSize: 200,
      tokensPerInterval: 20,
      refillIntervalMs: 30_000,
    });
    const s = p.store as unknown as { onPostgresError: string };
    expect(s.onPostgresError).toBe('fail-closed');
  });

  it('deprecated resilientPostgresPreset matches failClosedPostgresPreset', () => {
    const pool = mockPgPool();
    const a = failClosedPostgresPreset({ pool }, { maxRequests: 77, windowMs: 12_000 });
    const b = resilientPostgresPreset({ pool }, { maxRequests: 77, windowMs: 12_000 });
    expect(pgStoreLimits(a.store as PgStore)).toEqual(pgStoreLimits(b.store as PgStore));
  });
});

describe('postgresInsuranceMemoryStore', () => {
  it('sets per-replica cap to ceil(globalMax / workers)', () => {
    const m = postgresInsuranceMemoryStore(100, 4);
    shutdowns.push(() => m.shutdown());
    expect(m).toBeInstanceOf(MemoryStore);
    expect(memoryMaxRequests(m)).toBe(25);
    expect(m.getWindowLengthMs()).toBe(60_000);
  });

  it('accepts optional windowMs for alignment with PgStore / presets', () => {
    const m = postgresInsuranceMemoryStore(100, 4, 30_000);
    shutdowns.push(() => m.shutdown());
    expect(m.getWindowLengthMs()).toBe(30_000);
    expect(memoryMaxRequests(m)).toBe(25);
  });

  it('allows default workers with explicit windowMs', () => {
    const m = postgresInsuranceMemoryStore(200, undefined, 15_000);
    shutdowns.push(() => m.shutdown());
    expect(m.getWindowLengthMs()).toBe(15_000);
  });
});
