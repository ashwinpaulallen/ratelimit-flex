import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeMetricsConfig, validateMetricsConfig } from '../../src/metrics/normalize.js';
import type { MetricsConfig } from '../../src/types/metrics.js';

describe('normalizeMetricsConfig / validateMetricsConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when disabled or omitted', () => {
    expect(normalizeMetricsConfig(undefined)).toBeUndefined();
    expect(normalizeMetricsConfig(false)).toBeUndefined();
    expect(normalizeMetricsConfig({ enabled: false })).toBeUndefined();
  });

  it('expands metrics: true with defaults', () => {
    const out = normalizeMetricsConfig(true);
    expect(out).toEqual({
      enabled: true,
      intervalMs: 10_000,
      topKSize: 20,
    });
  });

  it('merges partial config and validates', () => {
    const out = normalizeMetricsConfig({
      enabled: true,
      intervalMs: 5000,
      topKSize: 50,
    });
    expect(out?.intervalMs).toBe(5000);
    expect(out?.topKSize).toBe(50);
  });

  it('throws when intervalMs < 1000', () => {
    expect(() =>
      normalizeMetricsConfig({
        enabled: true,
        intervalMs: 999,
      }),
    ).toThrow(/intervalMs must be >= 1000/);
  });

  it('warns when intervalMs is between 1000 and 4999', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    normalizeMetricsConfig({
      enabled: true,
      intervalMs: 1000,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('5000'));
  });

  it('throws when topKSize is out of range', () => {
    expect(() =>
      normalizeMetricsConfig({
        enabled: true,
        topKSize: 0,
      }),
    ).toThrow(/topKSize/);
    expect(() =>
      normalizeMetricsConfig({
        enabled: true,
        topKSize: 1001,
      }),
    ).toThrow(/topKSize/);
  });

  it('throws when histogramBuckets empty', () => {
    expect(() =>
      normalizeMetricsConfig({
        enabled: true,
        histogramBuckets: [],
      }),
    ).toThrow(/histogramBuckets/);
  });

  it('throws when histogramBuckets not sorted ascending positive', () => {
    expect(() =>
      normalizeMetricsConfig({
        enabled: true,
        histogramBuckets: [10, 5, 20],
      }),
    ).toThrow(/ascending/);
    expect(() =>
      normalizeMetricsConfig({
        enabled: true,
        histogramBuckets: [1, 1, 2],
      }),
    ).toThrow(/ascending/);
    expect(() =>
      normalizeMetricsConfig({
        enabled: true,
        histogramBuckets: [0, 1],
      }),
    ).toThrow(/> 0/);
  });

  it('validateMetricsConfig accepts valid explicit config', () => {
    const c: MetricsConfig = {
      enabled: true,
      intervalMs: 10_000,
      topKSize: 100,
      histogramBuckets: [0.1, 1, 10, 100],
    };
    expect(() => validateMetricsConfig(c)).not.toThrow();
  });
});
