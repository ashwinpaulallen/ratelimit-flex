import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RateLimiterQueue,
  RateLimiterQueueError,
} from '../../src/queue/RateLimiterQueue.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

function slidingStore(maxRequests: number, windowMs: number): MemoryStore {
  return new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs,
    maxRequests,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('RateLimiterQueue', () => {
  beforeEach(() => {
    // Do not fake setInterval — MemoryStore uses a cleanup interval; runAllTimers would loop forever.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('removeTokens resolves immediately when under limit', async () => {
    const store = slidingStore(10, 60_000);
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 10 });
    const r = await q.removeTokens('user-1');
    expect(r.remaining).toBe(9);
    expect(r.resetTime).toBeInstanceOf(Date);
    await store.shutdown();
  });

  it('removeTokens queues when at limit and resolves after window can accept again', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = slidingStore(1, 1000);
    const q = new RateLimiterQueue(store, { windowMs: 1000, maxRequests: 1 });

    const p1 = q.removeTokens('k');
    await flushMicrotasks();
    const r1 = await p1;
    expect(r1.remaining).toBe(0);

    const p2 = q.removeTokens('k');
    expect(q.getQueueSize()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const r2 = await p2;
    expect(r2.remaining).toBe(0);
    expect(q.getQueueSize()).toBe(0);

    await store.shutdown();
  });

  it('rejects when maxQueueSize is reached', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = slidingStore(1, 100_000);
    const q = new RateLimiterQueue(
      store,
      { windowMs: 100_000, maxRequests: 1 },
      { maxQueueSize: 1 },
    );

    const p1 = q.removeTokens('k');
    await flushMicrotasks();
    await p1;

    const p2 = q.removeTokens('k');
    expect(q.getQueueSize()).toBe(1);

    await expect(q.removeTokens('k')).rejects.toThrow(RateLimiterQueueError);
    await expect(q.removeTokens('k')).rejects.toThrow('Queue is full');

    await vi.advanceTimersByTimeAsync(100_000);
    await flushMicrotasks();
    await p2;

    await store.shutdown();
  });

  it('rejects when maxQueueTimeMs is exceeded', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = slidingStore(1, 100_000);
    const q = new RateLimiterQueue(
      store,
      { windowMs: 100_000, maxRequests: 1 },
      { maxQueueTimeMs: 200 },
    );

    await q.removeTokens('k');
    const p2 = q.removeTokens('k');
    expect(q.getQueueSize()).toBe(1);

    const expectTimeout = expect(p2).rejects.toThrow('Queue timeout exceeded');
    await vi.advanceTimersByTimeAsync(201);
    await flushMicrotasks();
    await expectTimeout;

    expect(q.getQueueSize()).toBe(0);

    await store.shutdown();
  });

  it('handles multiple keys independently', async () => {
    const store = slidingStore(5, 60_000);
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 5 });

    const a = await q.removeTokens('a');
    const b = await q.removeTokens('b');
    expect(a.remaining).toBe(4);
    expect(b.remaining).toBe(4);

    await store.shutdown();
  });

  it('rejects immediately when cost > maxRequests', async () => {
    const store = slidingStore(3, 60_000);
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 3 });

    await expect(q.removeTokens('k', 4)).rejects.toThrow('Requested tokens exceed maximum allowed');

    await store.shutdown();
  });

  it('rejects non-finite or sub-1 cost', async () => {
    const store = slidingStore(3, 60_000);
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 3 });
    await expect(q.removeTokens('k', 0)).rejects.toMatchObject({ code: 'invalid_cost' });
    await expect(q.removeTokens('k', Number.NaN)).rejects.toMatchObject({ code: 'invalid_cost' });
    await store.shutdown();
  });

  it('clear() rejects all pending with Queue cleared', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = slidingStore(1, 100_000);
    const q = new RateLimiterQueue(store, { windowMs: 100_000, maxRequests: 1 });

    await q.removeTokens('k');
    const p2 = q.removeTokens('k');
    q.clear();

    await expect(p2).rejects.toThrow('Queue cleared');
    expect(q.getQueueSize()).toBe(0);

    await store.shutdown();
  });

  it('shutdown() rejects pending and calls store.shutdown()', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = slidingStore(1, 100_000);
    const q = new RateLimiterQueue(store, { windowMs: 100_000, maxRequests: 1 });

    await q.removeTokens('k');
    const p2 = q.removeTokens('k');
    q.shutdown();

    await expect(p2).rejects.toThrow('Queue shut down');
    await expect(q.removeTokens('x')).rejects.toThrow('Queue shut down');
  });

  it('processes in FIFO order', async () => {
    const store = slidingStore(10, 60_000);
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 10 });

    const order: string[] = [];
    const p1 = q.removeTokens('same').then((r) => {
      order.push('1');
      return r;
    });
    const p2 = q.removeTokens('same').then((r) => {
      order.push('2');
      return r;
    });
    const p3 = q.removeTokens('same').then((r) => {
      order.push('3');
      return r;
    });

    await flushMicrotasks();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(['1', '2', '3']);

    await store.shutdown();
  });

  it('getQueueSize reflects waiting entries', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = slidingStore(1, 10_000);
    const q = new RateLimiterQueue(store, { windowMs: 10_000, maxRequests: 1 });

    expect(q.getQueueSize()).toBe(0);
    void q.removeTokens('k');
    await flushMicrotasks();
    expect(q.getQueueSize()).toBe(0);

    void q.removeTokens('k');
    expect(q.getQueueSize()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(q.getQueueSize()).toBe(0);

    await store.shutdown();
  });

  it('getTokensRemaining is a peek via increment+decrement', async () => {
    const store = slidingStore(5, 60_000);
    const q = new RateLimiterQueue(store, { windowMs: 60_000, maxRequests: 5 });

    await q.removeTokens('peek');
    const rem = await q.getTokensRemaining('peek');
    expect(rem).toBe(4);

    await store.shutdown();
  });

  it('drains automatically after blocked head waits for window', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = slidingStore(1, 500);
    const q = new RateLimiterQueue(store, { windowMs: 500, maxRequests: 1 });

    const first = q.removeTokens('k');
    const second = q.removeTokens('k');

    await flushMicrotasks();
    await first;

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    await second;
    expect(q.getQueueSize()).toBe(0);

    await store.shutdown();
  });
});
