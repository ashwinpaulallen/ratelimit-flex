import type { HotKeyIntervalCounts, MetricsCounters } from '../metrics/counters.js';

export type { HotKeyIntervalCounts };

/**
 * User-facing metrics configuration (no Prometheus/OpenTelemetry required).
 *
 * @since 1.3.0
 */
export interface MetricsConfig {
  /**
   * @description Master switch for {@link MetricsCounters} + {@link MetricsCollector} + callbacks.
   * @default false
   */
  enabled: boolean;
  /**
   * @description Aggregation interval (milliseconds). Must be at least **1000**; values under **5000** trigger a runtime `console.warn` (CPU / noisy snapshots).
   * @default 10000
   */
  intervalMs?: number;
  /**
   * @description How many entries appear in {@link MetricsSnapshot.hotKeys}. Must be an integer **1–1000** (validated when metrics are enabled).
   * @default 20
   */
  topKSize?: number;
  /**
   * @description Upper bounds (ms) for latency histograms (Prometheus / collector). When set, must be **non-empty**, **strictly ascending**, and every element **positive**.
   */
  histogramBuckets?: number[];
  /**
   * @description Called on each interval with a {@link MetricsSnapshot}.
   */
  onMetrics?: (snapshot: MetricsSnapshot) => void;
  /**
   * @description Prometheus text exposition (`/metrics`) and optional prom-client registry integration.
   */
  prometheus?: { enabled: boolean; prefix?: string; registry?: unknown };
  /**
   * @description Optional OpenTelemetry metrics via user-supplied {@link OpenTelemetryAdapter} (no `@opentelemetry/api` dependency in this package).
   */
  openTelemetry?: { enabled: boolean; meter?: unknown; prefix?: string };
}

/**
 * Rich aggregated metrics emitted by {@link MetricsCollector}.
 *
 * @since 1.3.0
 */
export interface MetricsSnapshot {
  /** When this snapshot was closed (end of the aggregation window). */
  readonly timestamp: Date;
  /** Rates and ratios for the last completed interval and sliding window. */
  readonly window: {
    /** Length of the aggregation tick in ms (matches {@link MetricsConfig.intervalMs}). */
    readonly durationMs: number;
    /** Estimated requests per second over the interval (from counter deltas). */
    readonly requestsPerSecond: number;
    /** Estimated blocks per second over the interval. */
    readonly blocksPerSecond: number;
    /** Blocked / (allowed + blocked) in this interval (0–1). */
    readonly blockRate: number;
    /** Allowed / (allowed + blocked) in this interval (0–1). */
    readonly allowRate: number;
  };
  /** Cumulative counters since process start (or last {@link MetricsCounters.reset}), not interval-only. */
  readonly totals: {
    /** Total requests seen by the limiter (includes skipped / allowlisted). */
    readonly requests: number;
    /** Requests that passed the limiter and were not blocked. */
    readonly allowed: number;
    /** All blocked responses (sum of {@link blockReasons}). */
    readonly blocked: number;
    /** Requests skipped via `skip()`. */
    readonly skipped: number;
    /** Requests matched by allowlist. */
    readonly allowlisted: number;
  };
  /** Breakdown of {@link totals.blocked} by reason. */
  readonly blockReasons: {
    /** Blocked due to quota / rate limit. */
    readonly rateLimit: number;
    /** Blocked by blocklist. */
    readonly blocklist: number;
    /** Blocked by penalty box. */
    readonly penalty: number;
    /** Blocked by {@link RateLimitOptionsBase.keyManager} before store increment. */
    readonly keyManager: number;
    /** Blocked because the store was unavailable (fail-closed). */
    readonly serviceUnavailable: number;
  };
  /** Statistics over middleware / handler latency samples (ms) drained for this interval. */
  readonly latency: {
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly stdDev: number;
  };
  /** Statistics over backing-store (e.g. Redis) operation latency samples (ms) for this interval. */
  readonly storeLatency: {
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
  };
  /** Top keys by {@link HotKeyIntervalCounts.hits} this interval (size ≤ {@link MetricsConfig.topKSize}). */
  readonly hotKeys: ReadonlyArray<{ readonly key: string } & HotKeyIntervalCounts>;
  /** Heuristic trends comparing the latest window to recent history. */
  readonly trends: {
    readonly requestRateTrend: 'increasing' | 'decreasing' | 'stable';
    readonly blockRateTrend: 'increasing' | 'decreasing' | 'stable';
    readonly latencyTrend: 'increasing' | 'decreasing' | 'stable';
  };
  /**
   * Drained middleware latency samples (ms) for this interval — used by Prometheus / OTel histograms.
   * @since 1.3.0
   */
  readonly latencySamplesMs?: readonly number[];
  /**
   * Drained store latency samples (ms) for this interval.
   * @since 1.3.0
   */
  readonly storeLatencySamplesMs?: readonly number[];
}

/**
 * Options for {@link MetricsCollector}.
 *
 * @since 1.3.0
 */
export interface MetricsCollectorOptions {
  readonly counters: MetricsCounters;
  readonly intervalMs?: number;
  readonly histogramBuckets?: number[];
  readonly topKSize?: number;
  readonly windowSize?: number;
  readonly onMetrics?: (snapshot: MetricsSnapshot) => void;
}
