import { describe, expect, it, vi } from 'vitest';
import { PgStore } from '../../src/stores/postgres/PgStore.js';
import type { PgClientLike } from '../../src/stores/postgres/types.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('PgStore (mock client)', () => {
  it('sweep returns deleted row count and swallows errors', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 4 })
      .mockRejectedValueOnce(new Error('db down'));
    const onWarn = vi.fn();
    const store = new PgStore({
      client: { query } as unknown as PgClientLike,
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      autoSweepIntervalMs: 0,
      onWarn,
    });
    await expect(store.sweep()).resolves.toBe(4);
    await expect(store.sweep()).resolves.toBe(0);
    expect(onWarn).toHaveBeenCalled();
  });

  it('shutdown does not call pool.end on the client', async () => {
    const end = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query, end } as unknown as PgClientLike & { end: () => Promise<void> };
    const store = new PgStore({
      client,
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      autoSweepIntervalMs: 0,
    });
    await store.shutdown();
    expect(end).not.toHaveBeenCalled();
  });
});
