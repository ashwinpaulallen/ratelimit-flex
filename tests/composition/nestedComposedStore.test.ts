import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposedStore } from '../../src/composition/ComposedStore.js';
import { extractLayerMetrics } from '../../src/composition/extractLayerMetrics.js';
import type { CompositionLayer } from '../../src/composition/types.js';
import { isComposedIncrementResult } from '../../src/composition/types.js';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

function sliding(max: number, windowMs = 60_000) {
  return new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs,
    maxRequests: max,
  });
}

function layer(label: string, store: MemoryStore | ComposedStore, extra?: Partial<CompositionLayer>): CompositionLayer {
  return { label, store, ...extra };
}

const stores: Array<MemoryStore | ComposedStore> = [];
function track<T extends MemoryStore | ComposedStore>(s: T): T {
  stores.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.shutdown()));
});

describe('nested ComposedStore', () => {
  it('merges inner ComposedIncrementResult into innerLayers (overflow inside all)', async () => {
    const steady = track(sliding(10, 1000));
    const burst = track(sliding(50, 60_000));
    const rate = track(
      new ComposedStore({
        mode: 'overflow',
        layers: [layer('steady', steady), layer('burst', burst)],
      }),
    );
    const daily = track(sliding(1000, 3_600_000));
    const top = track(
      new ComposedStore({
        mode: 'all',
        layers: [layer('rate', rate), layer('daily-cap', daily)],
      }),
    );

    const r = await top.increment('k');
    expect(isComposedIncrementResult(r)).toBe(true);
    expect(r.layers['rate']!.innerLayers).toBeDefined();
    expect(r.layers['rate']!.innerLayers!.steady).toMatchObject({
      consulted: true,
      isBlocked: false,
    });
    expect(r.layers['rate']!.innerLayers!.burst).toMatchObject({
      consulted: false,
    });
    expect(r.layers['daily-cap']!.innerLayers).toBeUndefined();
    expect(r.decidingPath).toMatch(/^(rate\.steady|daily-cap)$/);

    const s = top.summarize('k');
    expect(s.startsWith("ALLOWED by '")).toBe(true);
    expect(s).toContain('rate.steady:');
    expect(s).toContain('rate.burst: not consulted');
    expect(s).toContain('daily-cap:');

    const metrics = extractLayerMetrics(r);
    expect(metrics.map((m) => m.layer)).toEqual(
      expect.arrayContaining(['rate.steady', 'rate.burst', 'daily-cap']),
    );
  });

  it('three-level: all > overflow > firstAvailable exposes nested innerLayers', async () => {
    const a = track(sliding(5, 1000));
    const b = track(sliding(5, 1000));
    const fa = track(
      new ComposedStore({
        mode: 'first-available',
        layers: [layer('a', a), layer('b', b)],
      }),
    );
    const burst = track(sliding(20, 60_000));
    const ov = track(
      new ComposedStore({
        mode: 'overflow',
        layers: [layer('stack', fa), layer('burst', burst)],
      }),
    );
    const cap = track(sliding(100, 3_600_000));
    const top = track(
      new ComposedStore({
        mode: 'all',
        layers: [layer('pipe', ov), layer('cap', cap)],
      }),
    );

    const r = await top.increment('k3');
    expect(r.layers.pipe!.innerLayers).toBeDefined();
    expect(r.layers.pipe!.innerLayers!.stack!.innerLayers).toBeDefined();
    expect(r.layers.pipe!.innerLayers!.stack!.innerLayers!.a).toMatchObject({ consulted: true });
    expect(r.layers.pipe!.innerLayers!.stack!.innerLayers!.b).toMatchObject({ consulted: false });
    expect(r.layers.pipe!.innerLayers!.burst).toMatchObject({ consulted: false });
    expect(r.decidingPath).toMatch(/^pipe\.(stack\.a|cap)$/);

    const m = extractLayerMetrics(r);
    expect(m.map((e) => e.layer)).toEqual(
      expect.arrayContaining(['pipe.stack.a', 'pipe.stack.b', 'pipe.burst', 'cap']),
    );
  });

  it('decrement propagates through nested composition', async () => {
    const leaf = track(sliding(10, 60_000));
    const inner = track(
      new ComposedStore({
        mode: 'all',
        layers: [layer('leaf', leaf)],
      }),
    );
    const top = track(
      new ComposedStore({
        mode: 'all',
        layers: [layer('nested', inner)],
      }),
    );

    const spy = vi.spyOn(leaf, 'decrement');

    await top.increment('dec');
    expect(spy).not.toHaveBeenCalled();

    await top.decrement('dec');
    expect(spy).toHaveBeenCalledTimes(1);

    const r2 = await top.increment('dec');
    expect(r2.isBlocked).toBe(false);
  });

  it('reset propagates through nested composition', async () => {
    const inner = track(
      new ComposedStore({
        mode: 'all',
        layers: [layer('a', track(sliding(10, 60_000))), layer('b', track(sliding(10, 60_000)))],
      }),
    );
    const sibling = track(sliding(1, 60_000));
    const top = track(
      new ComposedStore({
        mode: 'all',
        layers: [layer('nested', inner), layer('sibling', sibling)],
      }),
    );

    expect((await top.increment('rk')).isBlocked).toBe(false);
    expect((await top.increment('rk')).isBlocked).toBe(true);

    await top.reset('rk');

    const r = await top.increment('rk');
    expect(r.isBlocked).toBe(false);
  });

  it('shutdown propagates through nested composition', async () => {
    const steady = track(sliding(10, 1000));
    const burst = track(sliding(50, 60_000));
    const rate = track(
      new ComposedStore({
        mode: 'overflow',
        layers: [layer('steady', steady), layer('burst', burst)],
      }),
    );
    const daily = track(sliding(1000, 3_600_000));
    const top = track(
      new ComposedStore({
        mode: 'all',
        layers: [layer('rate', rate), layer('daily-cap', daily)],
      }),
    );

    const sd = vi.spyOn(steady, 'shutdown');
    const bd = vi.spyOn(burst, 'shutdown');
    const dd = vi.spyOn(daily, 'shutdown');

    await top.shutdown();

    expect(sd).toHaveBeenCalled();
    expect(bd).toHaveBeenCalled();
    expect(dd).toHaveBeenCalled();
  });

  it('express standardHeaders reflect tightest nested constraint', async () => {
    const steady = track(sliding(5, 60_000));
    const burst = track(sliding(100, 60_000));
    const rate = track(
      new ComposedStore({
        mode: 'overflow',
        layers: [layer('steady', steady), layer('burst', burst)],
      }),
    );
    const daily = track(sliding(1000, 60_000));
    const store = track(
      new ComposedStore({
        mode: 'all',
        layers: [layer('rate', rate), layer('daily-cap', daily)],
      }),
    );

    const app = express();
    app.use(express.json());
    app.use(
      expressRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        standardHeaders: true,
        windowMs: 60_000,
        maxRequests: 5,
        store,
      }),
    );
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(Number(res.headers['x-ratelimit-limit'])).toBe(5);
    expect(Number(res.headers['x-ratelimit-remaining'])).toBe(4);
  });
});
