import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryShield } from '../../src/shield/InMemoryShield.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

function createWindowStore(maxRequests: number, windowMs = 60_000) {
  return new MemoryStore({
    strategy: RateLimitStrategy.FIXED_WINDOW,
    windowMs,
    maxRequests,
  });
}

describe('InMemoryShield', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('hot path', () => {
    it('first request for a key goes to the store (not cached)', async () => {
      const inner = createWindowStore(3);
      const inc = vi.spyOn(inner, 'increment');
      const shield = new InMemoryShield(inner, { blockOnConsumed: 3 });

      const r1 = await shield.increment('a');
      expect(inc).toHaveBeenCalledTimes(1);
      expect(r1.shielded).toBeUndefined();
      expect(r1.isBlocked).toBe(false);

      await shield.shutdown();
    });

    it('when store returns totalHits >= blockOnConsumed, key is cached', async () => {
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      await shield.increment('a');
      await shield.increment('a');
      expect(shield.isShielded('a')).toBe(true);

      await shield.shutdown();
    });

    it('subsequent requests return cached result without calling inner.increment', async () => {
      const inner = createWindowStore(2);
      const inc = vi.spyOn(inner, 'increment');
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      await shield.increment('a');
      await shield.increment('a');
      expect(inc).toHaveBeenCalledTimes(2);

      await shield.increment('a');
      await shield.increment('a');
      expect(inc).toHaveBeenCalledTimes(2);

      await shield.shutdown();
    });

    it('shielded: true on cached hits; absent on store-backed results', async () => {
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      const r1 = await shield.increment('a');
      expect(r1.shielded).toBeUndefined();

      const r2 = await shield.increment('a');
      expect(r2.shielded).toBeUndefined();

      const r3 = await shield.increment('a');
      expect(r3.shielded).toBe(true);
      expect(r3.isBlocked).toBe(true);

      await shield.shutdown();
    });
  });

  describe('expiry', () => {
    it('cached entry expires after blockDurationMs', async () => {
      const inner = createWindowStore(2);
      const inc = vi.spyOn(inner, 'increment');
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 2,
        blockDurationMs: 5_000,
      });

      await shield.increment('a');
      await shield.increment('a');
      expect(inc).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(5_001);
      await shield.increment('a');
      expect(inc).toHaveBeenCalledTimes(3);

      await shield.shutdown();
    });

    it('after expiry, next request goes to the store again', async () => {
      const inner = createWindowStore(2);
      const inc = vi.spyOn(inner, 'increment');
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 2,
        blockDurationMs: 1_000,
      });

      await shield.increment('k');
      await shield.increment('k');
      vi.advanceTimersByTime(1_001);
      await shield.increment('k');
      expect(inc).toHaveBeenCalledTimes(3);

      await shield.shutdown();
    });

    it('blockDurationMs: 0 uses store resetTime for expiry', async () => {
      const inner = createWindowStore(2, 10_000);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 2,
        blockDurationMs: 0,
      });

      await shield.increment('z');
      const rBlock = await shield.increment('z');
      expect(shield.isShielded('z')).toBe(true);

      const entry = shield.getShieldedKeys().find((e) => e.key === 'z');
      expect(entry).toBeDefined();
      expect(entry!.expiresAt.getTime()).toBe(rBlock.resetTime.getTime());

      await shield.shutdown();
    });

    it('proactive sweep removes expired entries', async () => {
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 2,
        blockDurationMs: 100,
        sweepIntervalMs: 500,
      });

      await shield.increment('s');
      await shield.increment('s');
      expect(shield.isShielded('s')).toBe(true);

      vi.advanceTimersByTime(200);
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();

      expect(shield.isShielded('s')).toBe(false);

      await shield.shutdown();
    });

    it('sweep() returns count of removed entries', async () => {
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 2,
        blockDurationMs: 50,
        sweepIntervalMs: 0,
      });

      await shield.increment('x');
      await shield.increment('x');
      vi.advanceTimersByTime(100);
      expect(shield.sweep()).toBe(1);

      await shield.shutdown();
    });
  });

  describe('LRU eviction', () => {
    it('when maxBlockedKeys is reached, oldest key is evicted', async () => {
      const inner = createWindowStore(1);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 1,
        maxBlockedKeys: 2,
      });

      await shield.increment('a');
      await shield.increment('b');
      expect(shield.getShieldedKeys().map((e) => e.key).sort()).toEqual(['a', 'b']);

      await shield.increment('c');
      const keys = shield.getShieldedKeys().map((e) => e.key).sort();
      expect(keys).toEqual(['b', 'c']);
      expect(shield.isShielded('a')).toBe(false);

      await shield.shutdown();
    });

    it('eviction fires onEvict callback (not onExpire)', async () => {
      const onEvict = vi.fn();
      const onExpire = vi.fn();
      const inner = createWindowStore(1);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 1,
        maxBlockedKeys: 1,
        onEvict,
        onExpire,
      });

      await shield.increment('first');
      await shield.increment('second');
      expect(onEvict).toHaveBeenCalledWith('first');
      expect(onExpire).not.toHaveBeenCalled();

      await shield.shutdown();
    });

    it('new key is added after eviction', async () => {
      const inner = createWindowStore(1);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 1,
        maxBlockedKeys: 1,
      });

      await shield.increment('p');
      await shield.increment('q');
      expect(shield.isShielded('q')).toBe(true);
      expect(shield.getShieldedKeys().map((e) => e.key)).toEqual(['q']);

      await shield.shutdown();
    });
  });

  describe('callbacks', () => {
    it('onBlock fires when key is first cached', async () => {
      const onBlock = vi.fn();
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 2,
        onBlock,
      });

      await shield.increment('a');
      expect(onBlock).not.toHaveBeenCalled();
      await shield.increment('a');
      expect(onBlock).toHaveBeenCalledTimes(1);
      expect(onBlock.mock.calls[0][0]).toBe('a');
      expect(onBlock.mock.calls[0][1]).toBe(2);
      expect(onBlock.mock.calls[0][2]).toBeInstanceOf(Date);

      await shield.shutdown();
    });

    it('onExpire fires on lazy expiry when increment touches an expired entry', async () => {
      const onExpire = vi.fn();
      const inner = createWindowStore(3);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 3,
        blockDurationMs: 100,
        sweepIntervalMs: 0,
        onExpire,
      });

      await shield.increment('a');
      await shield.increment('a');
      await shield.increment('a');
      vi.advanceTimersByTime(150);
      await shield.increment('a');
      expect(onExpire).toHaveBeenCalledWith('a');

      await shield.shutdown();
    });

    it('onExpire fires when sweep() removes expired entries', async () => {
      const onExpire = vi.fn();
      const inner = createWindowStore(3);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 3,
        blockDurationMs: 100,
        sweepIntervalMs: 0,
        onExpire,
      });

      await shield.increment('b');
      await shield.increment('b');
      await shield.increment('b');
      vi.advanceTimersByTime(150);
      expect(shield.sweep()).toBe(1);
      expect(onExpire).toHaveBeenCalledWith('b');

      await shield.shutdown();
    });

    it('onShieldHit fires on every cache hit', async () => {
      const onShieldHit = vi.fn();
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 2,
        onShieldHit,
      });

      await shield.increment('a');
      await shield.increment('a');
      await shield.increment('a');
      await shield.increment('a');
      expect(onShieldHit).toHaveBeenCalledTimes(2);
      expect(onShieldHit).toHaveBeenCalledWith('a');

      await shield.shutdown();
    });
  });

  describe('invalidation', () => {
    it('decrement removes key from cache', async () => {
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      await shield.increment('a');
      await shield.increment('a');
      expect(shield.isShielded('a')).toBe(true);

      await shield.decrement('a');
      expect(shield.isShielded('a')).toBe(false);

      await shield.shutdown();
    });

    it('reset removes key from cache', async () => {
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      await shield.increment('a');
      await shield.increment('a');
      await shield.reset('a');
      expect(shield.isShielded('a')).toBe(false);

      await shield.shutdown();
    });

    it('delete removes key from cache', async () => {
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      await shield.increment('a');
      await shield.increment('a');
      await shield.delete('a');
      expect(shield.isShielded('a')).toBe(false);

      await shield.shutdown();
    });

    it('set with totalHits < threshold removes from cache', async () => {
      const inner = createWindowStore(3);
      const shield = new InMemoryShield(inner, { blockOnConsumed: 3 });

      await shield.increment('a');
      await shield.increment('a');
      await shield.increment('a');
      expect(shield.isShielded('a')).toBe(true);

      await shield.set('a', 0);
      expect(shield.isShielded('a')).toBe(false);

      await shield.shutdown();
    });
  });

  describe('passthrough', () => {
    it('get returns cached result for shielded keys without calling inner.get', async () => {
      const inner = createWindowStore(2);
      const getSpy = vi.spyOn(inner, 'get');
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      await shield.increment('a');
      await shield.increment('a');
      getSpy.mockClear();

      const g = await shield.get('a');
      expect(getSpy).not.toHaveBeenCalled();
      expect(g?.isBlocked).toBe(true);

      await shield.shutdown();
    });

    it('get calls inner store for non-shielded keys', async () => {
      const inner = createWindowStore(2);
      const getSpy = vi.spyOn(inner, 'get');
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      await shield.get('noshield');
      expect(getSpy).toHaveBeenCalledWith('noshield');

      await shield.shutdown();
    });

    it('getActiveKeys proxies to inner store', async () => {
      const inner = createWindowStore(2);
      const spy = vi.spyOn(inner, 'getActiveKeys');
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      shield.getActiveKeys();
      expect(spy).toHaveBeenCalled();

      await shield.shutdown();
    });

    it('resetAll clears cache and proxies to inner', async () => {
      const inner = createWindowStore(2);
      const spy = vi.spyOn(inner, 'resetAll');
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      await shield.increment('a');
      await shield.increment('a');
      expect(shield.isShielded('a')).toBe(true);

      shield.resetAll();
      expect(spy).toHaveBeenCalled();
      expect(shield.isShielded('a')).toBe(false);

      await shield.shutdown();
    });
  });

  describe('metrics', () => {
    it('storeCallsSaved and storeCalls; hitRate', async () => {
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      await shield.increment('a');
      await shield.increment('a');
      await shield.increment('a');
      await shield.increment('a');

      const m = shield.getMetrics();
      expect(m.storeCalls).toBe(2);
      expect(m.storeCallsSaved).toBe(2);
      expect(m.hitRate).toBe(0.5);

      await shield.shutdown();
    });

    it('resetMetrics clears counters but not cache', async () => {
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      await shield.increment('a');
      await shield.increment('a');
      shield.resetMetrics();

      const m = shield.getMetrics();
      expect(m.storeCalls).toBe(0);
      expect(m.storeCallsSaved).toBe(0);
      expect(m.hitRate).toBe(0);
      expect(m.blockedKeyCount).toBe(1);

      await shield.shutdown();
    });

    it('blockedKeyCount matches cache size', async () => {
      const inner = createWindowStore(1);
      const shield = new InMemoryShield(inner, { blockOnConsumed: 1 });

      await shield.increment('x');
      expect(shield.getMetrics().blockedKeyCount).toBe(1);
      await shield.unshield('x');
      expect(shield.getMetrics().blockedKeyCount).toBe(0);

      await shield.shutdown();
    });
  });

  describe('edge cases', () => {
    it('blockOnConsumed = 1 caches on first increment (MemoryStore: isBlocked when totalHits > cap)', async () => {
      const inner = createWindowStore(1);
      const shield = new InMemoryShield(inner, { blockOnConsumed: 1 });

      const r1 = await shield.increment('a');
      expect(r1.totalHits).toBe(1);
      expect(r1.isBlocked).toBe(false);
      expect(shield.isShielded('a')).toBe(true);

      await shield.shutdown();
    });

    it('maxBlockedKeys = 1 only caches one key at a time', async () => {
      const inner = createWindowStore(1);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 1,
        maxBlockedKeys: 1,
      });

      await shield.increment('a');
      await shield.increment('b');
      expect(shield.getShieldedKeys().length).toBe(1);

      await shield.shutdown();
    });

    it('sweepIntervalMs = 0 disables proactive sweep (expiry is lazy or manual sweep only)', async () => {
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, {
        blockOnConsumed: 2,
        blockDurationMs: 50,
        sweepIntervalMs: 0,
      });

      await shield.increment('t');
      await shield.increment('t');
      expect(shield.isShielded('t')).toBe(true);

      vi.advanceTimersByTime(10_000);
      expect(shield.isShielded('t')).toBe(false);

      expect(shield.sweep()).toBe(1);

      await shield.shutdown();
    });

    it('inner increment error propagates and does not cache', async () => {
      const inner = createWindowStore(2);
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });
      const spy = vi.spyOn(inner, 'increment').mockRejectedValueOnce(new Error('store down'));

      await expect(shield.increment('err')).rejects.toThrow('store down');
      expect(shield.isShielded('err')).toBe(false);

      spy.mockRestore();
      await shield.shutdown();
    });

    it('concurrent shielded hits do not call inner.increment', async () => {
      const inner = createWindowStore(2);
      const inc = vi.spyOn(inner, 'increment');
      const shield = new InMemoryShield(inner, { blockOnConsumed: 2 });

      await shield.increment('c');
      await shield.increment('c');
      expect(inc).toHaveBeenCalledTimes(2);

      await Promise.all([
        shield.increment('c'),
        shield.increment('c'),
        shield.increment('c'),
        shield.increment('c'),
        shield.increment('c'),
      ]);

      expect(inc).toHaveBeenCalledTimes(2);

      await shield.shutdown();
    });
  });
});
