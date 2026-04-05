import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRedisEvalEmulator } from '../helpers/redis-eval-emulator.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RedisStore } from '../../src/stores/redis-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('MemoryStore get / set / delete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('sliding window', () => {
    it('get returns null for unknown key', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      });
      await expect(store.get('nope')).resolves.toBeNull();
      await store.shutdown();
    });

    it('get returns correct state after increments', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      });
      await store.increment('k');
      await store.increment('k');
      const g = await store.get('k');
      expect(g).not.toBeNull();
      expect(g!.totalHits).toBe(2);
      expect(g!.remaining).toBe(8);
      expect(g!.isBlocked).toBe(false);
      await store.shutdown();
    });

    it('get does not modify the counter', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      });
      await store.increment('k');
      await store.increment('k');
      await store.increment('k');
      await store.get('k');
      const r = await store.increment('k');
      expect(r.totalHits).toBe(4);
      await store.shutdown();
    });

    it('set overwrites to a specific value', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      });
      await store.increment('k');
      await store.increment('k');
      const s = await store.set('k', 9);
      expect(s.totalHits).toBe(9);
      expect(s.remaining).toBe(1);
      expect(s.isBlocked).toBe(false);
      const g = await store.get('k');
      expect(g!.totalHits).toBe(9);
      await store.shutdown();
    });

    it('set with expiresAt clears state after wall-clock expiry', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      });
      const exp = new Date(Date.now() + 5000);
      await store.set('k', 3, exp);
      await expect(store.get('k')).resolves.not.toBeNull();
      vi.setSystemTime(new Date(exp.getTime() + 1));
      await expect(store.get('k')).resolves.toBeNull();
      await store.shutdown();
    });

    it('delete removes key entirely; delete on unknown returns false', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      });
      await store.increment('k');
      expect(await store.delete('k')).toBe(true);
      await expect(store.get('k')).resolves.toBeNull();
      expect(await store.delete('missing')).toBe(false);
      await store.shutdown();
    });
  });

  describe('fixed window', () => {
    it('get returns null for unknown key', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 1000,
        maxRequests: 5,
      });
      await expect(store.get('x')).resolves.toBeNull();
      await store.shutdown();
    });

    it('get returns correct state and does not advance counter', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 1000,
        maxRequests: 5,
      });
      await store.increment('k');
      await store.increment('k');
      const g = await store.get('k');
      expect(g!.totalHits).toBe(2);
      const r = await store.increment('k');
      expect(r.totalHits).toBe(3);
      await store.shutdown();
    });

    it('set overwrites counter; set with expiresAt', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 10_000,
        maxRequests: 5,
      });
      await store.increment('k');
      const at = new Date(Date.now() + 2000);
      const s = await store.set('k', 4, at);
      expect(s.totalHits).toBe(4);
      expect(s.isBlocked).toBe(false);
      vi.setSystemTime(new Date(at.getTime() + 1));
      await expect(store.get('k')).resolves.toBeNull();
      await store.shutdown();
    });

    it('delete removes key', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.FIXED_WINDOW,
        windowMs: 1000,
        maxRequests: 5,
      });
      await store.increment('k');
      expect(await store.delete('k')).toBe(true);
      await expect(store.get('k')).resolves.toBeNull();
      expect(await store.delete('n')).toBe(false);
      await store.shutdown();
    });
  });

  describe('token bucket', () => {
    it('get returns null for unknown key', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: 2,
        interval: 1000,
        bucketSize: 5,
      });
      await expect(store.get('tb')).resolves.toBeNull();
      await store.shutdown();
    });

    it('get matches increments and does not consume', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: 10,
        interval: 1000,
        bucketSize: 10,
      });
      await store.increment('k');
      await store.increment('k');
      const g = await store.get('k');
      expect(g!.totalHits).toBe(2);
      expect(g!.remaining).toBe(8);
      const r = await store.increment('k');
      expect(r.totalHits).toBe(3);
      await store.shutdown();
    });

    it('set overwrites consumption state', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: 2,
        interval: 1000,
        bucketSize: 5,
      });
      await store.increment('k');
      const s = await store.set('k', 4);
      expect(s.totalHits).toBe(4);
      expect(s.remaining).toBe(1);
      expect(s.isBlocked).toBe(false);
      await store.shutdown();
    });

    it('delete removes key', async () => {
      const store = new MemoryStore({
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: 2,
        interval: 1000,
        bucketSize: 5,
      });
      await store.increment('k');
      expect(await store.delete('k')).toBe(true);
      await expect(store.get('k')).resolves.toBeNull();
      expect(await store.delete('k')).toBe(false);
      await store.shutdown();
    });
  });
});

describe('RedisStore get / set / delete (in-memory emulator)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T08:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function slidingRedis() {
    const client = createRedisEvalEmulator();
    const store = new RedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      client,
    });
    return store;
  }

  function fixedRedis() {
    const client = createRedisEvalEmulator();
    const store = new RedisStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 1000,
      maxRequests: 5,
      client,
    });
    return store;
  }

  function bucketRedis() {
    const client = createRedisEvalEmulator();
    const store = new RedisStore({
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: 10,
      interval: 1000,
      bucketSize: 10,
      client,
    });
    return store;
  }

  describe('sliding window', () => {
    it('get returns null for unknown key', async () => {
      const store = slidingRedis();
      await expect(store.get('nope')).resolves.toBeNull();
      await store.shutdown();
    });

    it('get returns correct state after increments', async () => {
      const store = slidingRedis();
      await store.increment('k');
      await store.increment('k');
      const g = await store.get('k');
      expect(g!.totalHits).toBe(2);
      expect(g!.remaining).toBe(8);
      await store.shutdown();
    });

    it('get does not modify the counter', async () => {
      const store = slidingRedis();
      await store.increment('k');
      await store.increment('k');
      await store.increment('k');
      await store.get('k');
      const r = await store.increment('k');
      expect(r.totalHits).toBe(4);
      await store.shutdown();
    });

    it('set overwrites', async () => {
      const store = slidingRedis();
      await store.increment('k');
      const s = await store.set('k', 9);
      expect(s.totalHits).toBe(9);
      const g = await store.get('k');
      expect(g!.totalHits).toBe(9);
      await store.shutdown();
    });

    it('delete removes key', async () => {
      const store = slidingRedis();
      await store.increment('k');
      expect(await store.delete('k')).toBe(true);
      await expect(store.get('k')).resolves.toBeNull();
      expect(await store.delete('x')).toBe(false);
      await store.shutdown();
    });
  });

  describe('fixed window', () => {
    it('get null unknown', async () => {
      const store = fixedRedis();
      await expect(store.get('z')).resolves.toBeNull();
      await store.shutdown();
    });

    it('get does not advance counter', async () => {
      const store = fixedRedis();
      await store.increment('k');
      await store.increment('k');
      await store.get('k');
      const r = await store.increment('k');
      expect(r.totalHits).toBe(3);
      await store.shutdown();
    });

    it('set overwrites; fixed get after set', async () => {
      const store = fixedRedis();
      await store.increment('k');
      await store.set('k', 4);
      const g = await store.get('k');
      expect(g!.totalHits).toBe(4);
      await store.shutdown();
    });

    it('delete', async () => {
      const store = fixedRedis();
      await store.increment('k');
      expect(await store.delete('k')).toBe(true);
      await expect(store.get('k')).resolves.toBeNull();
      await store.shutdown();
    });
  });

  describe('token bucket', () => {
    it('get null unknown', async () => {
      const store = bucketRedis();
      await expect(store.get('tb')).resolves.toBeNull();
      await store.shutdown();
    });

    it('get after increments does not consume extra', async () => {
      const store = bucketRedis();
      await store.increment('k');
      await store.increment('k');
      await store.get('k');
      const r = await store.increment('k');
      expect(r.totalHits).toBe(3);
      await store.shutdown();
    });

    it('set overwrites bucket state', async () => {
      const store = bucketRedis();
      await store.increment('k');
      const s = await store.set('k', 8);
      expect(s.totalHits).toBe(8);
      expect(s.remaining).toBe(2);
      await store.shutdown();
    });

    it('delete', async () => {
      const store = bucketRedis();
      await store.increment('k');
      expect(await store.delete('k')).toBe(true);
      await expect(store.get('k')).resolves.toBeNull();
      await store.shutdown();
    });
  });
});
