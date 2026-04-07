import { MetricsCounters } from './counters.js';
import { assertHistogramBucketBounds } from './histogram.js';
import type { MetricsConfig } from '../types/metrics.js';

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TOP_K = 20;

/**
 * Validates merged {@link MetricsConfig} after defaults are applied.
 *
 * @throws Error with a descriptive message when configuration is invalid.
 */
export function validateMetricsConfig(config: MetricsConfig): void {
  const { intervalMs, topKSize, histogramBuckets } = config;

  if (intervalMs !== undefined) {
    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs)) {
      throw new Error(
        `ratelimit-flex: metrics.intervalMs must be a finite number (got ${String(intervalMs)}).`,
      );
    }
    if (intervalMs < 1000) {
      throw new Error(
        `ratelimit-flex: metrics.intervalMs must be >= 1000 (got ${intervalMs}). Shorter windows are not supported.`,
      );
    }
    if (intervalMs < 5000) {
      console.warn(
        `[ratelimit-flex] metrics.intervalMs is ${intervalMs}ms; values under 5000ms increase CPU overhead and may produce noisy snapshots. Consider >= 5000ms in production.`,
      );
    }
  }

  if (topKSize !== undefined) {
    if (!Number.isInteger(topKSize) || topKSize < 1 || topKSize > 1000) {
      throw new Error(
        `ratelimit-flex: metrics.topKSize must be an integer from 1 to 1000 (got ${String(topKSize)}).`,
      );
    }
  }

  if (histogramBuckets !== undefined) {
    assertHistogramBucketBounds(histogramBuckets, 'metrics.histogramBuckets');
  }

  if (config.shutdownOnProcessExit !== undefined && typeof config.shutdownOnProcessExit !== 'boolean') {
    throw new Error(
      `ratelimit-flex: metrics.shutdownOnProcessExit must be a boolean (got ${String(config.shutdownOnProcessExit)}).`,
    );
  }
}

/**
 * Resolves `metrics: true` or partial {@link MetricsConfig} to a full config, or `undefined` when disabled.
 */
export function normalizeMetricsConfig(metrics: MetricsConfig | boolean | undefined): MetricsConfig | undefined {
  if (metrics === undefined || metrics === false) {
    return undefined;
  }
  if (metrics === true) {
    const out: MetricsConfig = {
      enabled: true,
      intervalMs: DEFAULT_INTERVAL_MS,
      topKSize: DEFAULT_TOP_K,
    };
    validateMetricsConfig(out);
    return out;
  }
  if (!metrics.enabled) {
    return undefined;
  }
  const out: MetricsConfig = {
    intervalMs: DEFAULT_INTERVAL_MS,
    topKSize: DEFAULT_TOP_K,
    ...metrics,
    enabled: true,
  };
  validateMetricsConfig(out);
  return out;
}

/**
 * Instantiates {@link MetricsCounters} when metrics are enabled.
 */
export function createMetricsCountersIfEnabled(metrics: MetricsConfig | boolean | undefined): MetricsCounters | undefined {
  return normalizeMetricsConfig(metrics) !== undefined ? new MetricsCounters() : undefined;
}
