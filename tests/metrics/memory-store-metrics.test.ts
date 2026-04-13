import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrometheusAdapter } from '../../src/metrics/adapters/prometheus-adapter.js';
import { MetricsCollector } from '../../src/metrics/collector.js';
import { MetricsCounters } from '../../src/metrics/counters.js';
import { InMemoryShield } from '../../src/shield/InMemoryShield.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('MemoryStore metrics in snapshot and exporters', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('MetricsSnapshot includes store metrics when collector is wired to MemoryStore', async () => {
    vi.useFakeTimers();
    const mem = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      maxKeys: 100,
    });
    await mem.increment('x');
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000, windowSize: 3, store: mem });
    collector.start();
    counters.totalRequests = 1;
    counters.allowedRequests = 1;
    vi.advanceTimersByTime(1000);

    const snap = collector.getSnapshot();
    expect(snap?.store).toEqual({
      activeKeys: 1,
      totalEvictions: 0,
      maxKeys: 100,
    });

    await mem.shutdown();
    void collector.shutdown();
  });

  it('MetricsSnapshot omits store when backing store has no MemoryStore getMetrics', () => {
    vi.useFakeTimers();
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({
      counters,
      intervalMs: 1000,
      windowSize: 3,
      store: { increment: async () => ({ totalHits: 0, remaining: 0, resetTime: new Date(), isBlocked: false }) },
    });
    collector.start();
    counters.totalRequests = 1;
    vi.advanceTimersByTime(1000);
    expect(collector.getSnapshot()?.store).toBeUndefined();
    void collector.shutdown();
  });

  it('unwraps InMemoryShield to include inner MemoryStore metrics', async () => {
    vi.useFakeTimers();
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 5,
      maxKeys: 50,
    });
    const shield = new InMemoryShield(inner, { blockOnConsumed: 2, blockDurationMs: 60_000 });
    await inner.increment('k');

    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000, windowSize: 3, store: shield });
    collector.start();
    counters.totalRequests = 1;
    vi.advanceTimersByTime(1000);

    expect(collector.getSnapshot()?.store?.activeKeys).toBe(1);
    expect(collector.getSnapshot()?.store?.maxKeys).toBe(50);

    await shield.shutdown();
    await inner.shutdown();
    void collector.shutdown();
  });

  it('Prometheus text exposition includes the three store gauges with store="memory"', async () => {
    vi.useFakeTimers();
    const mem = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      maxKeys: 100,
    });
    await mem.increment('a');
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000, windowSize: 3, store: mem });
    const adapter = new PrometheusAdapter(collector);
    collector.start();
    counters.totalRequests = 1;
    vi.advanceTimersByTime(1000);

    const text = adapter.getMetricsText();
    expect(text).toContain('ratelimit_store_active_keys{store="memory"} 1');
    expect(text).toContain('ratelimit_store_total_evictions{store="memory"} 0');
    expect(text).toContain('ratelimit_store_max_keys{store="memory"} 100');
    expect(text).toMatch(/# (HELP|TYPE) ratelimit_store_active_keys/);

    await mem.shutdown();
    void collector.shutdown();
    adapter.destroy();
  });

  it('Prometheus store_total_evictions gauge updates when LRU evictions occur', async () => {
    vi.useFakeTimers();
    const mem = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      maxKeys: 2,
    });
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000, windowSize: 3, store: mem });
    const adapter = new PrometheusAdapter(collector);
    collector.start();

    await mem.increment('a');
    await mem.increment('b');
    counters.totalRequests = 1;
    vi.advanceTimersByTime(1000);
    expect(adapter.getMetricsText()).toMatch(/ratelimit_store_total_evictions\{store="memory"\} 0/);

    await mem.increment('c');
    counters.totalRequests = 2;
    vi.advanceTimersByTime(1000);
    expect(adapter.getMetricsText()).toMatch(/ratelimit_store_total_evictions\{store="memory"\} 1/);

    await mem.shutdown();
    void collector.shutdown();
    adapter.destroy();
  });
});
