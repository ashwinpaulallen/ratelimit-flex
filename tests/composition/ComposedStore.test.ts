import { describe, expect, it, vi } from 'vitest';
import { ComposedStore } from '../../src/composition/ComposedStore.js';
import { compose } from '../../src/composition/compose.js';
import type { CompositionLayer } from '../../src/composition/types.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import type { RateLimitResult, RateLimitStore } from '../../src/types/index.js';

function sliding(max: number, windowMs = 60_000) {
  return new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs,
    maxRequests: max,
  });
}

function layer(label: string, store: MemoryStore, extra?: Partial<CompositionLayer>): CompositionLayer {
  return { label, store, ...extra };
}

describe('ComposedStore', () => {
  it('implements RateLimitStore (structural)', () => {
    const c = new ComposedStore({
      mode: 'all',
      layers: [layer('a', sliding(10)), layer('b', sliding(10))],
    });
    const _ok: RateLimitStore = c;
    expect(_ok).toBe(c);
  });

  describe("mode 'all'", () => {
    it('allows when both under limit; remaining is minimum; decidingLayer is tightest', async () => {
      const a = sliding(5);
      const b = sliding(10);
      const c = new ComposedStore({
        mode: 'all',
        layers: [layer('tight', a), layer('loose', b)],
      });
      const r = await c.increment('k');
      expect(r.isBlocked).toBe(false);
      expect(r.remaining).toBe(Math.min(4, 9));
      expect(r.decidingLayer).toBe('tight');
      expect(r.layers.tight.consulted).toBe(true);
      expect(r.layers.loose.consulted).toBe(true);
      await c.shutdown();
    });

    it('blocks when any layer blocks; rolls back successful siblings (rollbackOnBlock default)', async () => {
      const tight = sliding(1);
      const loose = sliding(100);
      const c = new ComposedStore({
        mode: 'all',
        layers: [layer('tight', tight), layer('loose', loose)],
      });
      await c.increment('k');
      const r2 = await c.increment('k');
      expect(r2.isBlocked).toBe(true);
      expect(r2.decidingLayer).toBe('tight');
      expect(loose.getActiveKeys().get('k')?.totalHits).toBe(1);
      await c.shutdown();
    });

    it('rollbackOnBlock: false does not decrement successful layers when another blocks', async () => {
      const tight = sliding(1);
      const loose = sliding(100);
      const c = new ComposedStore({
        mode: 'all',
        layers: [layer('tight', tight), layer('loose', loose)],
        rollbackOnBlock: false,
      });
      await c.increment('k');
      await c.increment('k');
      expect(loose.getActiveKeys().get('k')?.totalHits).toBe(2);
      await c.shutdown();
    });

    it('three layers: middle blocks → rollback first and third successful layers', async () => {
      const l0 = sliding(100);
      const l1 = sliding(1);
      const l2 = sliding(100);
      const c = new ComposedStore({
        mode: 'all',
        layers: [layer('a', l0), layer('b', l1), layer('c', l2)],
      });
      await c.increment('k');
      await c.increment('k');
      expect(l0.getActiveKeys().get('k')?.totalHits).toBe(1);
      expect(l2.getActiveKeys().get('k')?.totalHits).toBe(1);
      await c.shutdown();
    });
  });

  describe("mode 'overflow'", () => {
    it('primary under limit: burst not consulted', async () => {
      const primary = sliding(5);
      const burst = sliding(20);
      const c = new ComposedStore({
        mode: 'overflow',
        layers: [layer('primary', primary), layer('burst', burst)],
      });
      const r = await c.increment('k');
      expect(r.isBlocked).toBe(false);
      expect(r.decidingLayer).toBe('primary');
      expect(r.layers.burst.consulted).toBe(false);
      await c.shutdown();
    });

    it('primary blocked, burst allows → allowed; decidingLayer burst; combined resetTime', async () => {
      const primary = sliding(1);
      const burst = sliding(20);
      const c = new ComposedStore({
        mode: 'overflow',
        layers: [layer('primary', primary), layer('burst', burst)],
      });
      await c.increment('k');
      const r = await c.increment('k');
      expect(r.isBlocked).toBe(false);
      expect(r.decidingLayer).toBe('burst');
      expect(r.remaining).toBe(burst.getActiveKeys().get('burst:k')?.remaining ?? r.remaining);
      expect(r.resetTime.getTime()).toBe(
        Math.min(
          primary.getActiveKeys().get('k')!.resetTime.getTime(),
          burst.getActiveKeys().get('burst:k')!.resetTime.getTime(),
        ),
      );
      await c.shutdown();
    });

    it('both blocked → blocked', async () => {
      const primary = sliding(1);
      const burst = sliding(1);
      const c = new ComposedStore({
        mode: 'overflow',
        layers: [layer('primary', primary), layer('burst', burst)],
      });
      await c.increment('k');
      await c.increment('k');
      const r = await c.increment('k');
      expect(r.isBlocked).toBe(true);
      await c.shutdown();
    });

    it('primary at cap: totalHits reflects real count (e.g. 11) when blocked; burst does not roll back primary', async () => {
      const primary = sliding(10);
      const burst = sliding(100);
      const c = new ComposedStore({
        mode: 'overflow',
        layers: [layer('primary', primary), layer('burst', burst)],
      });
      const decPrimary = vi.spyOn(primary, 'decrement');
      for (let i = 0; i < 10; i++) {
        await c.increment('u');
      }
      const r = await c.increment('u');
      expect(r.isBlocked).toBe(false);
      expect(r.decidingLayer).toBe('burst');
      expect(r.totalHits).toBe(11);
      expect(primary.getActiveKeys().get('u')?.totalHits).toBe(11);
      expect(decPrimary).not.toHaveBeenCalled();
      await c.shutdown();
    });

    it('defaults burst storage to burst:${key}; keyTransform (k)=>k shares key with primary', async () => {
      const primary = sliding(1);
      const burst = sliding(20);
      const c = new ComposedStore({
        mode: 'overflow',
        layers: [layer('primary', primary), layer('burst', burst)],
      });
      await c.increment('k');
      await c.increment('k');
      expect(burst.getActiveKeys().has('burst:k')).toBe(true);

      const primary2 = sliding(1);
      const burst2 = sliding(20);
      const c2 = new ComposedStore({
        mode: 'overflow',
        layers: [
          layer('primary', primary2),
          layer('burst', burst2, { keyTransform: (k) => k }),
        ],
      });
      await c2.increment('x');
      await c2.increment('x');
      expect(burst2.getActiveKeys().has('x')).toBe(true);
      await c.shutdown();
      await c2.shutdown();
    });

    it('warns when burst windowMs < primary windowMs (both MemoryStore)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        /* noop */
      });
      const primary = sliding(100, 60_000);
      const burst = sliding(20, 1000);
      const c = new ComposedStore({
        mode: 'overflow',
        layers: [layer('primary', primary), layer('burst', burst)],
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('burst window is shorter than primary'),
      );
      warn.mockRestore();
      await c.shutdown();
    });

    it('decrement only touches the layer that served the request', async () => {
      const primary = sliding(1);
      const burst = sliding(20);
      const decP = vi.spyOn(primary, 'decrement');
      const decB = vi.spyOn(burst, 'decrement');
      const c = new ComposedStore({
        mode: 'overflow',
        layers: [layer('primary', primary), layer('burst', burst)],
      });
      await c.increment('k');
      await c.increment('k');
      expect(decP).not.toHaveBeenCalled();
      expect(decB).not.toHaveBeenCalled();
      await c.decrement('k');
      expect(decP).not.toHaveBeenCalled();
      expect(decB).toHaveBeenCalledTimes(1);
      expect(decB.mock.calls[0]![0]).toBe('burst:k');
      decP.mockRestore();
      decB.mockRestore();
      await c.shutdown();
    });

    it('after primary window elapses, traffic uses primary again (not burst)', async () => {
      vi.useFakeTimers();
      const primary = new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 100,
        maxRequests: 1,
      });
      const burst = new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      });
      const c = new ComposedStore({
        mode: 'overflow',
        layers: [layer('primary', primary), layer('burst', burst)],
      });
      const r1 = await c.increment('ip');
      expect(r1.decidingLayer).toBe('primary');
      const r2 = await c.increment('ip');
      expect(r2.decidingLayer).toBe('burst');
      vi.advanceTimersByTime(150);
      const r3 = await c.increment('ip');
      expect(r3.decidingLayer).toBe('primary');
      expect(r3.isBlocked).toBe(false);
      vi.useRealTimers();
      await c.shutdown();
    });
  });

  describe("mode 'first-available'", () => {
    it('first allows → others not consulted', async () => {
      const a = sliding(10);
      const b = sliding(10);
      const c = new ComposedStore({
        mode: 'first-available',
        layers: [layer('a', a), layer('b', b)],
      });
      const r = await c.increment('k');
      expect(r.isBlocked).toBe(false);
      expect(r.decidingLayer).toBe('a');
      expect(r.layers.b.consulted).toBe(false);
      await c.shutdown();
    });

    it('first blocks, second allows', async () => {
      const a = sliding(1);
      const b = sliding(10);
      const c = new ComposedStore({
        mode: 'first-available',
        layers: [layer('a', a), layer('b', b)],
      });
      await c.increment('k');
      const r = await c.increment('k');
      expect(r.isBlocked).toBe(false);
      expect(r.decidingLayer).toBe('b');
      await c.shutdown();
    });

    it('all block → soonest resetTime among consulted', async () => {
      const a = sliding(1);
      const b = sliding(1);
      const c = new ComposedStore({
        mode: 'first-available',
        layers: [layer('a', a), layer('b', b)],
      });
      await c.increment('k');
      await c.increment('k');
      const r = await c.increment('k');
      expect(r.isBlocked).toBe(true);
      const tA = a.getActiveKeys().get('k')!.resetTime.getTime();
      const tB = b.getActiveKeys().get('k')!.resetTime.getTime();
      expect(r.resetTime.getTime()).toBe(Math.min(tA, tB));
      await c.shutdown();
    });
  });

  describe("mode 'race'", () => {
    it('first resolved layer wins; losers rolled back', async () => {
      const a = sliding(5);
      const b = sliding(5);
      const c = new ComposedStore({
        mode: 'race',
        raceTimeoutMs: 5000,
        layers: [layer('a', a), layer('b', b)],
      });
      const r = await c.increment('k');
      expect(r.isBlocked).toBe(false);
      expect(['a', 'b']).toContain(r.decidingLayer);
      const hitsA = a.getActiveKeys().get('k')?.totalHits ?? 0;
      const hitsB = b.getActiveKeys().get('k')?.totalHits ?? 0;
      expect(hitsA + hitsB).toBe(1);
      await c.shutdown();
    });

    it('times out when no layer resolves in time', async () => {
      vi.useFakeTimers();
      try {
        const hang = (): RateLimitStore => ({
          increment: () => new Promise<RateLimitResult>(() => {}),
          decrement: async () => {},
          reset: async () => {},
          shutdown: async () => {},
        });
        const c = new ComposedStore({
          mode: 'race',
          raceTimeoutMs: 50,
          layers: [layer('slow', hang()), layer('slow2', hang())],
        });
        const p = c.increment('k');
        await vi.advanceTimersByTimeAsync(50);
        const r = await p;
        expect(r.decidingLayer).toBe('timeout');
        expect(r.isBlocked).toBe(true);
        await c.shutdown();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('decrement / reset / shutdown', () => {
    it('decrement all mode pops frame and decrements all stores', async () => {
      const a = sliding(10);
      const b = sliding(10);
      const c = new ComposedStore({ mode: 'all', layers: [layer('a', a), layer('b', b)] });
      await c.increment('x');
      await c.decrement('x');
      expect(a.getActiveKeys().get('x')).toBeUndefined();
      expect(b.getActiveKeys().get('x')).toBeUndefined();
      await c.shutdown();
    });

    it('overflow decrement targets recorded layer only', async () => {
      const primary = sliding(1);
      const burst = sliding(5);
      const c = new ComposedStore({
        mode: 'overflow',
        layers: [layer('primary', primary), layer('burst', burst)],
      });
      await c.increment('k');
      await c.increment('k');
      expect(burst.getActiveKeys().get('burst:k')).toBeDefined();
      await c.decrement('k');
      await c.shutdown();
    });

    it('first-available decrement uses winning layer', async () => {
      const a = sliding(1);
      const b = sliding(10);
      const c = new ComposedStore({
        mode: 'first-available',
        layers: [layer('a', a), layer('b', b)],
      });
      await c.increment('k');
      await c.increment('k');
      await c.decrement('k');
      expect(b.getActiveKeys().has('k')).toBe(false);
      await c.shutdown();
    });

    it('reset and shutdown propagate', async () => {
      const a = sliding(5);
      const b = sliding(5);
      const c = new ComposedStore({ mode: 'all', layers: [layer('a', a), layer('b', b)] });
      await c.increment('z');
      await c.reset('z');
      expect(a.getActiveKeys().get('z')).toBeUndefined();
      await c.shutdown();
    });
  });

  describe('constructor & keyTransform', () => {
    it('throws on duplicate labels', () => {
      expect(
        () =>
          new ComposedStore({
            mode: 'all',
            layers: [layer('x', sliding(1)), layer('x', sliding(1))],
          }),
      ).toThrow(/duplicate layer label/);
    });

    it('overflow requires exactly two layers', () => {
      expect(
        () =>
          new ComposedStore({
            mode: 'overflow',
            layers: [layer('a', sliding(1))],
          }),
      ).toThrow(/exactly two layers/);
    });

    it('applies keyTransform per layer', async () => {
      const a = sliding(2);
      const b = sliding(2);
      const c = new ComposedStore({
        mode: 'all',
        layers: [
          { label: 'a', store: a },
          { label: 'b', store: b, keyTransform: (k) => `ns:${k}` },
        ],
      });
      await c.increment('id');
      expect(a.getActiveKeys().has('id')).toBe(true);
      expect(b.getActiveKeys().has('ns:id')).toBe(true);
      await c.shutdown();
    });
  });

  it('compose helper builds ComposedStore', () => {
    const s = compose.all(compose.layer('a', sliding(1)), compose.layer('b', sliding(2)));
    expect(s).toBeInstanceOf(ComposedStore);
  });
});
