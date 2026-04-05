import { describe, expect, it, vi } from 'vitest';
import { ComposedStore } from '../../src/composition/ComposedStore.js';
import { extractLayerMetrics } from '../../src/composition/extractLayerMetrics.js';
import type { CompositionLayer } from '../../src/composition/types.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

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

describe('ComposedStore inspection helpers', () => {
  it('getLayerResults returns correct breakdown after increment', async () => {
    const a = sliding(5);
    const b = sliding(10);
    const c = new ComposedStore({
      mode: 'all',
      layers: [layer('per-sec', a), layer('per-min', b)],
    });
    const r = await c.increment('client');
    const g = c.getLayerResults('client');
    expect(g).toBeDefined();
    const layers = g as NonNullable<typeof g>;
    expect(layers['per-sec']).toEqual(r.layers['per-sec']);
    expect(layers['per-min']).toEqual(r.layers['per-min']);
    await c.shutdown();
  });

  it('summarize returns human-readable string for allowed case', async () => {
    const a = sliding(10);
    const b = sliding(100);
    const c = new ComposedStore({
      mode: 'all',
      layers: [layer('per-sec', a), layer('per-min', b)],
    });
    await c.increment('k');
    const s = c.summarize('k');
    expect(s.startsWith("ALLOWED by '")).toBe(true);
    expect(s).toContain('per-sec:');
    expect(s).toContain('remaining');
    expect(s).toContain('per-min:');
    expect(s).not.toContain('BLOCKED');
    await c.shutdown();
  });

  it('summarize returns human-readable string for blocked case with rolled back sibling', async () => {
    const tight = sliding(1);
    const loose = sliding(100);
    const c = new ComposedStore({
      mode: 'all',
      layers: [layer('per-sec', tight), layer('per-min', loose)],
    });
    await c.increment('k');
    await c.increment('k');
    const s = c.summarize('k');
    expect(s.startsWith("BLOCKED by '")).toBe(true);
    expect(s).toContain('per-sec:');
    expect(s).toContain('(blocked)');
    expect(s).toContain('per-min:');
    expect(s).toContain('(rolled back)');
    await c.shutdown();
  });

  it('extractLayerMetrics returns one entry per layer', async () => {
    const a = sliding(5);
    const b = sliding(10);
    const c = new ComposedStore({
      mode: 'all',
      layers: [layer('a', a), layer('b', b)],
    });
    const r = await c.increment('x');
    const m = extractLayerMetrics(r);
    expect(m).toHaveLength(2);
    expect(m.map((e) => e.layer).sort()).toEqual(['a', 'b']);
    for (const row of m) {
      expect(row).toMatchObject({
        layer: expect.any(String),
        totalHits: expect.any(Number),
        remaining: expect.any(Number),
        isBlocked: expect.any(Boolean),
        consulted: expect.any(Boolean),
      });
    }
    await c.shutdown();
  });

  it('stale results are cleaned up after layer reset times pass', async () => {
    vi.useFakeTimers();
    const t0 = 17_000_000_000;
    vi.setSystemTime(t0);
    const a = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 1000,
      maxRequests: 10,
    });
    const b = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 2000,
      maxRequests: 10,
    });
    const c = new ComposedStore({
      mode: 'all',
      layers: [layer('a', a), layer('b', b)],
    });
    await c.increment('stale-key');
    expect(c.getLayerResults('stale-key')).toBeDefined();
    vi.advanceTimersByTime(2500);
    expect(c.getLayerResults('stale-key')).toBeUndefined();
    expect(c.summarize('stale-key')).toBe('(no cached increment for key)');
    vi.useRealTimers();
    await c.shutdown();
  });
});
