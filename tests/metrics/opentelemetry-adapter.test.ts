import { describe, expect, it, vi } from 'vitest';
import { OpenTelemetryAdapter } from '../../src/metrics/adapters/opentelemetry-adapter.js';
import { MetricsCollector } from '../../src/metrics/collector.js';
import { MetricsCounters } from '../../src/metrics/counters.js';

function createMockMeter() {
  const counterApi = { add: vi.fn() };
  const histApi = { record: vi.fn() };
  const mkGauge = () => ({
    addCallback: vi.fn(),
    removeCallback: vi.fn(),
  });
  const rps = mkGauge();
  const br = mkGauge();
  const hk = mkGauge();
  const meter = {
    createCounter: vi.fn(() => counterApi),
    createHistogram: vi.fn(() => histApi),
    createObservableGauge: vi.fn((name: string) => {
      if (String(name).includes('requests_per_second')) return rps;
      if (String(name).includes('block_rate')) return br;
      return hk;
    }),
  };
  return { meter, counterApi, histApi, rps, br, hk };
}

describe('OpenTelemetryAdapter', () => {
  it('registers instruments and observable callbacks, then removes them on shutdown', () => {
    const { meter, rps, br, hk } = createMockMeter();
    const counters = new MetricsCounters();
    const collector = new MetricsCollector({ counters, intervalMs: 10_000 });
    const adapter = new OpenTelemetryAdapter({ collector, meter, prefix: 'rl' });

    expect(meter.createCounter).toHaveBeenCalledWith('rl_requests_total', expect.any(Object));
    expect(meter.createHistogram).toHaveBeenCalledWith('rl_middleware_duration_ms', expect.any(Object));
    expect(meter.createHistogram).toHaveBeenCalledWith('rl_store_duration_ms', expect.any(Object));
    expect(meter.createObservableGauge).toHaveBeenCalledWith('rl_requests_per_second', expect.any(Object));
    expect(meter.createObservableGauge).toHaveBeenCalledWith('rl_block_rate', expect.any(Object));
    expect(meter.createObservableGauge).toHaveBeenCalledWith('rl_hot_key_hits', expect.any(Object));
    expect(meter.createObservableGauge).toHaveBeenCalledWith('rl_shield_blocked_keys', expect.any(Object));
    expect(meter.createObservableGauge).toHaveBeenCalledWith('rl_shield_store_calls_saved_total', expect.any(Object));
    expect(meter.createObservableGauge).toHaveBeenCalledWith('rl_shield_total_keys_blocked', expect.any(Object));
    expect(meter.createObservableGauge).toHaveBeenCalledWith('rl_shield_total_keys_expired', expect.any(Object));
    expect(meter.createObservableGauge).toHaveBeenCalledWith('rl_shield_total_keys_evicted', expect.any(Object));
    expect(meter.createObservableGauge).toHaveBeenCalledWith('rl_shield_hit_rate', expect.any(Object));
    expect(meter.createObservableGauge).toHaveBeenCalledWith('rl_shield_store_calls_total', expect.any(Object));

    expect(rps.addCallback).toHaveBeenCalledTimes(1);
    expect(br.addCallback).toHaveBeenCalledTimes(1);
    expect(hk.addCallback).toHaveBeenCalledTimes(8);

    adapter.shutdown();
    expect(rps.removeCallback).toHaveBeenCalledTimes(1);
    expect(br.removeCallback).toHaveBeenCalledTimes(1);
    expect(hk.removeCallback).toHaveBeenCalledTimes(8);
  });

  it('applies counter deltas and histogram records when metrics events fire', () => {
    vi.useFakeTimers();
    const { meter, counterApi, histApi } = createMockMeter();
    const counters = new MetricsCounters();
    counters.allowedRequests = 5;
    const now = performance.now();
    counters.recordLatency(now - 4);
    counters.recordStoreLatency(now - 2);
    const collector = new MetricsCollector({ counters, intervalMs: 1000 });
    const adapter = new OpenTelemetryAdapter({ collector, meter });
    collector.start();
    vi.advanceTimersByTime(1000);
    adapter.shutdown();
    void collector.shutdown();
    vi.useRealTimers();
    expect(counterApi.add).toHaveBeenCalled();
    expect(histApi.record).toHaveBeenCalled();
  });
});
