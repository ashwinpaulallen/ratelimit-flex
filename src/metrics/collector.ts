import { EventEmitter } from 'node:events';
import type { HotKeyIntervalCounts, MetricsCollectorOptions, MetricsSnapshot } from '../types/metrics.js';
import type { MetricsCounters } from './counters.js';
import {
  minMaxMean,
  percentilesQuick,
  standardDeviation,
} from './stats.js';

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TOP_K = 20;
const DEFAULT_WINDOW_SIZE = 6;
const DEFAULT_BUCKETS: readonly number[] = [
  0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000,
];

const TREND_EPS = 0.05;

/**
 * Background aggregator for metrics: runs on a **timer** (not on the request path), drains
 * {@link MetricsCounters} each tick, computes percentiles (quickselect), request/block rates over a
 * sliding window, hot-key ranking, and heuristic trends, then emits a `metrics` event with a
 * {@link MetricsSnapshot}. Start with {@link start}; listen with {@link EventEmitter.on} `'metrics'`.
 *
 * @since 1.3.0
 */
export class MetricsCollector extends EventEmitter {
  private readonly counters: MetricsCounters;

  private readonly intervalMs: number;

  private readonly topKSize: number;

  private readonly windowSize: number;

  /** Upper bounds (ms) for optional histograms / future export. */
  readonly histogramBuckets: readonly number[];

  private readonly onMetricsCb?: (snapshot: MetricsSnapshot) => void;

  private timer: ReturnType<typeof setInterval> | undefined;

  private lastTotalRequests = 0;

  private lastBlocked = 0;

  private lastAllowed = 0;

  private readonly deltaTotals: number[] = [];

  private readonly deltaBlockeds: number[] = [];

  private readonly deltaAlloweds: number[] = [];

  private readonly intervalReqPerSec: number[] = [];

  private readonly intervalBlockRate: number[] = [];

  private readonly intervalLatencyMean: number[] = [];

  private latest: MetricsSnapshot | null = null;

  private readonly history: MetricsSnapshot[] = [];

  constructor(options: MetricsCollectorOptions) {
    super();
    this.counters = options.counters;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.topKSize = options.topKSize ?? DEFAULT_TOP_K;
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.histogramBuckets = options.histogramBuckets ?? [...DEFAULT_BUCKETS];
    this.onMetricsCb = options.onMetrics;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Stops the interval and removes listeners. Safe to call multiple times.
   */
  async shutdown(): Promise<void> {
    this.stop();
    this.removeAllListeners();
    await Promise.resolve();
  }

  getSnapshot(): MetricsSnapshot | null {
    return this.latest;
  }

  getHistory(): MetricsSnapshot[] {
    return this.history.slice();
  }

  private tick(): void {
    const raw = this.counters.snapshot();
    const lat = raw.latencySamplesMs;
    const st = raw.storeLatencySamplesMs;

    const dt = raw.totalRequests - this.lastTotalRequests;
    const db = raw.blockedRequests - this.lastBlocked;
    const da = raw.allowedRequests - this.lastAllowed;
    this.lastTotalRequests = raw.totalRequests;
    this.lastBlocked = raw.blockedRequests;
    this.lastAllowed = raw.allowedRequests;

    this.pushDelta(dt, db, da);

    const intervalSec = this.intervalMs / 1000;
    const instRps = intervalSec > 0 ? dt / intervalSec : 0;
    this.pushSeries(this.intervalReqPerSec, instRps);
    const instBr = dt > 0 ? db / dt : 0;
    this.pushSeries(this.intervalBlockRate, instBr);

    const latMm = minMaxMean(lat);
    const [p50, p95, p99] = percentilesQuick(lat, [50, 95, 99]);
    const stdDev = standardDeviation(lat, latMm.mean);
    this.pushSeries(this.intervalLatencyMean, latMm.mean);

    const stMm = minMaxMean(st);
    const [stP50, stP95, stP99] = percentilesQuick(st, [50, 95, 99]);

    const durationMs = Math.max(1, this.deltaTotals.length) * this.intervalMs;
    const sumT = sumArray(this.deltaTotals);
    const sumB = sumArray(this.deltaBlockeds);
    const sumA = sumArray(this.deltaAlloweds);
    const durSec = durationMs / 1000;

    const requestsPerSecond = durSec > 0 ? sumT / durSec : 0;
    const blocksPerSecond = durSec > 0 ? sumB / durSec : 0;
    const blockRate = sumT > 0 ? sumB / sumT : 0;
    const allowRate = sumT > 0 ? sumA / sumT : 0;

    const snap: MetricsSnapshot = {
      timestamp: new Date(),
      window: {
        durationMs,
        requestsPerSecond,
        blocksPerSecond,
        blockRate,
        allowRate,
      },
      totals: {
        requests: raw.totalRequests,
        allowed: raw.allowedRequests,
        blocked: raw.blockedRequests,
        skipped: raw.skippedRequests,
        allowlisted: raw.allowlistedRequests,
      },
      blockReasons: {
        rateLimit: raw.blockedByRateLimit,
        blocklist: raw.blockedByBlocklist,
        penalty: raw.blockedByPenalty,
        serviceUnavailable: raw.blockedByServiceUnavailable,
      },
      latency: {
        min: latMm.min,
        max: latMm.max,
        mean: latMm.mean,
        p50,
        p95,
        p99,
        stdDev,
      },
      storeLatency: {
        min: stMm.min,
        max: stMm.max,
        mean: stMm.mean,
        p50: stP50,
        p95: stP95,
        p99: stP99,
      },
      hotKeys: hotKeysTopK(raw.hotKeys, this.topKSize),
      trends: {
        requestRateTrend: trendFromSeries(this.intervalReqPerSec),
        blockRateTrend: trendFromSeries(this.intervalBlockRate),
        latencyTrend: trendFromSeries(this.intervalLatencyMean),
      },
      latencySamplesMs: Object.freeze(lat),
      storeLatencySamplesMs: Object.freeze(st),
    };

    Object.freeze(snap.window);
    Object.freeze(snap.totals);
    Object.freeze(snap.blockReasons);
    Object.freeze(snap.latency);
    Object.freeze(snap.storeLatency);
    Object.freeze(snap.trends);
    this.latest = Object.freeze(snap);

    this.history.push(this.latest);
    if (this.history.length > this.windowSize) {
      this.history.splice(0, this.history.length - this.windowSize);
    }

    this.onMetricsCb?.(this.latest);
    this.emit('metrics', this.latest);
  }

  private pushDelta(dt: number, db: number, da: number): void {
    this.deltaTotals.push(dt);
    this.deltaBlockeds.push(db);
    this.deltaAlloweds.push(da);
    if (this.deltaTotals.length > this.windowSize) {
      this.deltaTotals.shift();
      this.deltaBlockeds.shift();
      this.deltaAlloweds.shift();
    }
  }

  private pushSeries(arr: number[], v: number): void {
    arr.push(v);
    if (arr.length > this.windowSize) {
      arr.shift();
    }
  }
}

function sumArray(a: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s;
}

function trendFromSeries(values: readonly number[]): 'increasing' | 'decreasing' | 'stable' {
  if (values.length < 2) return 'stable';
  const mid = Math.floor(values.length / 2);
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < mid; i++) sumA += values[i]!;
  for (let i = mid; i < values.length; i++) sumB += values[i]!;
  const first = sumA / mid;
  const second = sumB / (values.length - mid);
  if (second > first * (1 + TREND_EPS)) return 'increasing';
  if (second < first * (1 - TREND_EPS)) return 'decreasing';
  return 'stable';
}

function hotKeysTopK(
  map: ReadonlyMap<string, HotKeyIntervalCounts>,
  k: number,
): ReadonlyArray<{ readonly key: string } & HotKeyIntervalCounts> {
  if (k <= 0 || map.size === 0) return [];
  const arr: { key: string; hits: number; blocked: number }[] = [];
  for (const [key, v] of map) {
    arr.push({ key, hits: v.hits, blocked: v.blocked });
  }
  arr.sort((a, b) => b.hits - a.hits);
  return Object.freeze(arr.slice(0, k));
}
