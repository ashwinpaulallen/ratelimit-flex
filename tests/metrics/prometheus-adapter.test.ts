import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { PrometheusAdapter } from '../../src/metrics/adapters/prometheus-adapter.js';
import { MetricsCollector } from '../../src/metrics/collector.js';
import { MetricsCounters } from '../../src/metrics/counters.js';

function makeSnapshot(overrides?: Partial<import('../../src/types/metrics.js').MetricsSnapshot>) {
  const base: import('../../src/types/metrics.js').MetricsSnapshot = {
    timestamp: new Date(),
    window: {
      durationMs: 10_000,
      requestsPerSecond: 1,
      blocksPerSecond: 0,
      blockRate: 0,
      allowRate: 1,
    },
    totals: {
      requests: 10,
      allowed: 8,
      blocked: 2,
      skipped: 0,
      allowlisted: 0,
    },
    blockReasons: {
      rateLimit: 2,
      blocklist: 0,
      penalty: 0,
      serviceUnavailable: 0,
    },
    latency: { min: 0, max: 1, mean: 0.5, p50: 0.5, p95: 0.9, p99: 1, stdDev: 0.1 },
    storeLatency: { min: 0, max: 1, mean: 0.5, p50: 0.5, p95: 0.9, p99: 1 },
    hotKeys: [{ key: 'k1', hits: 5, blocked: 0 }],
    trends: {
      requestRateTrend: 'stable',
      blockRateTrend: 'stable',
      latencyTrend: 'stable',
    },
    latencySamplesMs: Object.freeze([0.5, 1.2]),
    storeLatencySamplesMs: Object.freeze([0.3]),
  };
  return { ...base, ...overrides };
}

describe('PrometheusAdapter', () => {
  it('generates valid Prometheus exposition with HELP and TYPE lines', () => {
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 60_000 });
    const adapter = new PrometheusAdapter(collector);
    const text = adapter.getMetricsText();
    expect(text).toMatch(/^# HELP /m);
    expect(text).toMatch(/^# TYPE /m);
    expect(text.endsWith('\n')).toBe(true);
    void collector.shutdown();
    adapter.destroy();
  });

  it('includes expected metric names and types', () => {
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 60_000 });
    const adapter = new PrometheusAdapter(collector, { prefix: 'rl_' });
    const text = adapter.getMetricsText();
    expect(text).toContain('rl_requests_total');
    expect(text).toContain('# TYPE rl_requests_total counter');
    expect(text).toContain('rl_middleware_duration_milliseconds');
    expect(text).toContain('# TYPE rl_middleware_duration_milliseconds histogram');
    expect(text).toContain('rl_store_duration_milliseconds');
    expect(text).toContain('rl_requests_per_second');
    expect(text).toContain('# TYPE rl_requests_per_second gauge');
    expect(text).toContain('rl_block_rate');
    expect(text).toContain('rl_hot_key_hits');
    void collector.shutdown();
    adapter.destroy();
  });

  it('formats labels with escaped quotes in hot key', () => {
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 60_000 });
    const adapter = new PrometheusAdapter(collector);
    (collector as unknown as { emit: (e: string, s: unknown) => void }).emit(
      'metrics',
      makeSnapshot({
        hotKeys: [{ key: 'a"b', hits: 1, blocked: 0 }],
      }),
    );
    const text = adapter.getMetricsText();
    expect(text).toMatch(/key="a\\"b"/);
    void collector.shutdown();
    adapter.destroy();
  });

  it('accumulates histogram counts across metrics events', () => {
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 60_000 });
    const adapter = new PrometheusAdapter(collector, { prefix: 't_' });
    const emit = (collector as unknown as { emit: (e: string, s: unknown) => void }).emit.bind(collector);
    emit(
      'metrics',
      makeSnapshot({
        latencySamplesMs: Object.freeze([1, 2]),
        storeLatencySamplesMs: Object.freeze([]),
      }),
    );
    const mid = adapter.getMetricsText();
    const mwCount1 = mid.match(/t_middleware_duration_milliseconds_count (\d+)/);
    expect(mwCount1?.[1]).toBe('2');
    emit(
      'metrics',
      makeSnapshot({
        latencySamplesMs: Object.freeze([3]),
        storeLatencySamplesMs: Object.freeze([]),
      }),
    );
    const full = adapter.getMetricsText();
    const mwCount2 = full.match(/t_middleware_duration_milliseconds_count (\d+)/);
    expect(Number(mwCount2?.[1])).toBe(3);
    void collector.shutdown();
    adapter.destroy();
  });

  it('metricsEndpoint() serves text/plain GET responses', async () => {
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 60_000 });
    const adapter = new PrometheusAdapter(collector);
    const mw = adapter.metricsEndpoint();
    const end = vi.fn();
    const setHeader = vi.fn();
    const res = { setHeader, end } as unknown as Response;
    const next = vi.fn() as NextFunction;
    mw({ method: 'GET' } as Request, res, next);
    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    expect(end).toHaveBeenCalled();
    expect(typeof end.mock.calls[0]![0]).toBe('string');
    expect(next).not.toHaveBeenCalled();
    void collector.shutdown();
    adapter.destroy();
  });

  it('metricsEndpoint defers non-GET to next()', () => {
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 60_000 });
    const adapter = new PrometheusAdapter(collector);
    const mw = adapter.metricsEndpoint();
    const next = vi.fn() as NextFunction;
    mw({ method: 'POST' } as Request, {} as Response, next);
    expect(next).toHaveBeenCalled();
    void collector.shutdown();
    adapter.destroy();
  });
});
