import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiterQueue } from '../../src/queue/createRateLimiterQueue.js';
import { ShutdownError } from '../../src/queue/errors.js';
import { KeyedRateLimiterQueue } from '../../src/queue/KeyedRateLimiterQueue.js';
import { RateLimiterQueue } from '../../src/queue/RateLimiterQueue.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function slidingStore(maxRequests: number, windowMs: number): MemoryStore {
  return new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs,
    maxRequests,
  });
}

describe('RateLimiterQueue.shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('rejects all queued waiters with ShutdownError and gates removeTokens', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = slidingStore(1, 100_000);
    const q = new RateLimiterQueue(store, { windowMs: 100_000, maxRequests: 1 }, { ownsStore: false });

    await q.removeTokens('k');
    const pending = Array.from({ length: 10 }, () => q.removeTokens('k'));
    await flushMicrotasks();

    const out = await q.shutdown();
    expect(out.rejected).toBe(10);
    expect(out.drained).toBe(0);

    const results = await Promise.allSettled(pending);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(ShutdownError);
      }
    }
    await expect(q.removeTokens('x')).rejects.toBeInstanceOf(ShutdownError);

    await store.shutdown();
  });

  it('drainTimeoutMs allows queued entries to complete before rejecting the rest', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = slidingStore(1, 1000);
    const q = new RateLimiterQueue(store, { windowMs: 1000, maxRequests: 1 }, { ownsStore: false });

    await q.removeTokens('k');
    const p2 = q.removeTokens('k');
    await flushMicrotasks();
    expect(q.getQueueSize()).toBe(1);

    const pShut = q.shutdown({ drainTimeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(1000);
    const out = await pShut;

    await expect(p2).resolves.toMatchObject({ remaining: expect.any(Number) });
    expect(out.rejected).toBe(0);
    expect(out.drained).toBe(1);

    await store.shutdown();
  });

  it('drainTimeoutMs is best-effort: some complete, remainder rejected', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = slidingStore(1, 500);
    const q = new RateLimiterQueue(store, { windowMs: 500, maxRequests: 1 }, { ownsStore: false });

    await q.removeTokens('k');
    const waiters = [
      q.removeTokens('k'),
      q.removeTokens('k'),
      q.removeTokens('k'),
      q.removeTokens('k'),
      q.removeTokens('k'),
      q.removeTokens('k'),
      q.removeTokens('k'),
      q.removeTokens('k'),
      q.removeTokens('k'),
      q.removeTokens('k'),
    ];
    for (const w of waiters) {
      void w.catch(() => {});
    }
    await flushMicrotasks();
    expect(q.getQueueSize()).toBe(10);

    const pShut = q.shutdown({ drainTimeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3500);
    await pShut;

    const settled = await Promise.allSettled(waiters);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled').length;
    const rejected = settled.filter((s) => s.status === 'rejected').length;
    expect(fulfilled + rejected).toBe(10);
    expect(rejected).toBeGreaterThan(0);
    expect(fulfilled).toBeGreaterThan(0);

    await store.shutdown();
  });

  it('is idempotent', async () => {
    const store = slidingStore(5, 60_000);
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 5 }, { ownsStore: false });

    const a = await q.shutdown();
    const b = await q.shutdown();
    expect(a).toEqual({ rejected: 0, drained: 0 });
    expect(b).toEqual({ rejected: 0, drained: 0 });

    await store.shutdown();
  });

  it('with ownsStore true, shuts down internal store from createRateLimiterQueue', async () => {
    const spy = vi.spyOn(MemoryStore.prototype, 'shutdown');
    const q = createRateLimiterQueue({ maxRequests: 1, windowMs: 60_000 });
    await q.shutdown();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('with ownsStore false, does not shut down user store', async () => {
    const store = slidingStore(3, 60_000);
    const spy = vi.spyOn(store, 'shutdown');
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 3 }, { ownsStore: false });
    await q.shutdown();
    expect(spy).not.toHaveBeenCalled();
    await store.increment('x');
    spy.mockRestore();
    await store.shutdown();
  });

  it('clear() after shutdown throws ShutdownError', async () => {
    const store = slidingStore(1, 60_000);
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 1 }, { ownsStore: false });
    await q.shutdown();
    expect(() => q.clear()).toThrow(ShutdownError);
    await store.shutdown();
  });
});

describe('KeyedRateLimiterQueue.shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('aggregates rejected across keys', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const keyed = new KeyedRateLimiterQueue({
      maxRequests: 1,
      windowMs: 100_000,
      maxKeys: 10,
      strategy: RateLimitStrategy.SLIDING_WINDOW,
    });

    await keyed.removeTokens('a', 'a');
    await keyed.removeTokens('b', 'b');
    const pa = keyed.removeTokens('a', 'a');
    const pb = keyed.removeTokens('b', 'b');
    await flushMicrotasks();

    const out = await keyed.shutdown();
    expect(out.rejected).toBe(2);
    await expect(pa).rejects.toBeInstanceOf(ShutdownError);
    await expect(pb).rejects.toBeInstanceOf(ShutdownError);
    await expect(keyed.removeTokens('c', 'c')).rejects.toBeInstanceOf(ShutdownError);
  });

  it('is idempotent', async () => {
    const keyed = new KeyedRateLimiterQueue({
      maxRequests: 2,
      windowMs: 60_000,
      maxKeys: 5,
    });
    const a = await keyed.shutdown();
    const b = await keyed.shutdown();
    expect(a.rejected).toBe(0);
    expect(b.rejected).toBe(0);
  });
});
