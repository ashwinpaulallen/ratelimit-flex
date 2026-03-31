import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsCollector } from '../../src/metrics/collector.js';
import { MetricsCounters } from '../../src/metrics/counters.js';

describe('MetricsCollector', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes snapshots on interval', () => {
    vi.useFakeTimers();
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000, windowSize: 6 });
    collector.start();
    counters.totalRequests = 5;
    counters.allowedRequests = 5;
    vi.advanceTimersByTime(1000);
    const snap = collector.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.totals.requests).toBe(5);
    expect(snap!.totals.allowed).toBe(5);
    void collector.shutdown();
  });

  it('computes percentiles from latency samples', () => {
    vi.useFakeTimers();
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000, windowSize: 6 });
    collector.start();
    const t = performance.now();
    for (let i = 0; i < 20; i++) {
      counters.recordLatency(t - i * 0.5);
    }
    counters.totalRequests = 20;
    counters.allowedRequests = 20;
    vi.advanceTimersByTime(1000);
    const snap = collector.getSnapshot()!;
    expect(snap.latency.p50).toBeGreaterThan(0);
    expect(snap.latency.p95).toBeGreaterThanOrEqual(snap.latency.p50);
    expect(snap.latency.p99).toBeGreaterThanOrEqual(snap.latency.p95);
    void collector.shutdown();
  });

  it('detects increasing trend when request rate rises', () => {
    vi.useFakeTimers();
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({
      counters,
      intervalMs: 1000,
      windowSize: 6,
    });
    collector.start();
    let cumulative = 0;
    for (let tick = 1; tick <= 6; tick++) {
      cumulative += tick;
      counters.totalRequests = cumulative;
      counters.allowedRequests = cumulative;
      vi.advanceTimersByTime(1000);
    }
    const snap = collector.getSnapshot()!;
    expect(snap.trends.requestRateTrend).toBe('increasing');
    void collector.shutdown();
  });

  it('ranks hot keys by hit count descending', () => {
    vi.useFakeTimers();
    const counters = new MetricsCounters({ hotKeyMaxEntries: 100 });
    const collector = new MetricsCollector({ counters, intervalMs: 1000, topKSize: 5, windowSize: 6 });
    collector.start();
    counters.recordKey('low');
    counters.recordKey('high');
    counters.recordKey('high');
    counters.recordKey('mid');
    counters.recordKey('mid');
    counters.recordKey('mid');
    counters.totalRequests = 10;
    vi.advanceTimersByTime(1000);
    const snap = collector.getSnapshot()!;
    expect(snap.hotKeys[0]!.key).toBe('mid');
    expect(snap.hotKeys[1]!.key).toBe('high');
    expect(snap.hotKeys[2]!.key).toBe('low');
    void collector.shutdown();
  });

  it('onMetrics callback receives snapshot with expected shape', () => {
    vi.useFakeTimers();
    const counters = new MetricsCounters();
    const received: unknown[] = [];
    const collector = new MetricsCollector({
      counters,
      intervalMs: 1000,
      onMetrics: (s) => {
        received.push(s);
      },
    });
    collector.start();
    counters.totalRequests = 1;
    counters.allowedRequests = 1;
    vi.advanceTimersByTime(1000);
    expect(received).toHaveLength(1);
    const s = received[0] as import('../../src/types/metrics.js').MetricsSnapshot;
    expect(s).toMatchObject({
      totals: expect.objectContaining({ requests: 1 }),
      window: expect.objectContaining({ durationMs: expect.any(Number) }),
      latency: expect.any(Object),
      trends: expect.any(Object),
    });
    void collector.shutdown();
  });

  it('history window drops oldest snapshots beyond windowSize', () => {
    vi.useFakeTimers();
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000, windowSize: 3 });
    collector.start();
    for (let i = 0; i < 5; i++) {
      counters.totalRequests = i + 1;
      vi.advanceTimersByTime(1000);
    }
    expect(collector.getHistory().length).toBe(3);
    void collector.shutdown();
  });

  it('shutdown clears interval', async () => {
    vi.useFakeTimers();
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 1000 });
    collector.start();
    await collector.shutdown();
    vi.advanceTimersByTime(10_000);
    const before = collector.getSnapshot();
    counters.totalRequests = 999;
    vi.advanceTimersByTime(1000);
    expect(collector.getSnapshot()).toBe(before);
  });
});
