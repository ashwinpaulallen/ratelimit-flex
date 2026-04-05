import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrometheusAdapter } from '../../src/metrics/adapters/prometheus-adapter.js';
import { MetricsCollector } from '../../src/metrics/collector.js';
import { MetricsCounters } from '../../src/metrics/counters.js';
import { InMemoryShield } from '../../src/shield/InMemoryShield.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('shield metrics in MetricsSnapshot and Prometheus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('MetricsSnapshot omits shield when no InMemoryShield is wired', () => {
    vi.useFakeTimers();
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000, windowSize: 3 });
    collector.start();
    counters.totalRequests = 1;
    counters.allowedRequests = 1;
    vi.advanceTimersByTime(1000);
    expect(collector.getSnapshot()?.shield).toBeUndefined();
    void collector.shutdown();
  });

  it('MetricsSnapshot includes shield data when shield is active', async () => {
    vi.useFakeTimers();
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 2,
    });
    const shield = new InMemoryShield(inner, {
      blockOnConsumed: 2,
      blockDurationMs: 60_000,
    });
    await shield.increment('k');
    await shield.increment('k');
    await shield.increment('k');

    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000, windowSize: 3, shield });
    collector.start();
    counters.totalRequests = 1;
    counters.allowedRequests = 1;
    vi.advanceTimersByTime(1000);

    const snap = collector.getSnapshot();
    expect(snap?.shield).toBeDefined();
    expect(snap!.shield!.blockedKeyCount).toBe(1);
    expect(snap!.shield!.storeCalls).toBe(2);
    expect(snap!.shield!.storeCallsSaved).toBe(1);
    expect(snap!.shield!.hitRate).toBeGreaterThan(0);

    await shield.shutdown();
    await inner.shutdown();
    void collector.shutdown();
  });

  it('shield metrics update as requests flow across ticks', async () => {
    vi.useFakeTimers();
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 2,
    });
    const shield = new InMemoryShield(inner, {
      blockOnConsumed: 2,
      blockDurationMs: 60_000,
    });

    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000, windowSize: 3, shield });
    collector.start();
    counters.totalRequests = 1;
    counters.allowedRequests = 1;
    vi.advanceTimersByTime(1000);
    expect(collector.getSnapshot()?.shield?.storeCalls).toBe(0);

    await shield.increment('x');
    await shield.increment('x');
    await shield.increment('x');
    counters.totalRequests = 2;
    counters.allowedRequests = 2;
    vi.advanceTimersByTime(1000);

    const snap = collector.getSnapshot();
    expect(snap?.shield?.storeCalls).toBe(2);
    expect(snap?.shield?.storeCallsSaved).toBe(1);

    await shield.shutdown();
    await inner.shutdown();
    void collector.shutdown();
  });

  it('Prometheus text exposition includes shield gauges', async () => {
    vi.useFakeTimers();
    const inner = new MemoryStore({
      strategy: RateLimitStrategy.FIXED_WINDOW,
      windowMs: 60_000,
      maxRequests: 2,
    });
    const shield = new InMemoryShield(inner, {
      blockOnConsumed: 2,
      blockDurationMs: 60_000,
    });
    await shield.increment('p');
    await shield.increment('p');
    await shield.increment('p');

    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000, shield });
    const adapter = new PrometheusAdapter(collector);
    collector.start();
    counters.totalRequests = 1;
    counters.allowedRequests = 1;
    vi.advanceTimersByTime(1000);

    const text = adapter.getMetricsText();
    expect(text).toContain('ratelimit_shield_blocked_keys');
    expect(text).toContain('# TYPE ratelimit_shield_blocked_keys gauge');
    expect(text).toContain('ratelimit_shield_store_calls_saved_total');
    expect(text).toContain('ratelimit_shield_hit_rate');
    expect(text).toContain('ratelimit_shield_store_calls_total');
    expect(text).toMatch(/ratelimit_shield_store_calls_total \d+/);

    await shield.shutdown();
    await inner.shutdown();
    void collector.shutdown();
    adapter.destroy();
  });
});
