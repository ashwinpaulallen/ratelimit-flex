import type { NextFunction, Request, Response } from 'express';
import type { Registry } from 'prom-client';
import type { MetricsCollector } from '../collector.js';
import type { MetricsSnapshot } from '../../types/metrics.js';

const DEFAULT_PREFIX = 'ratelimit_';
const DEFAULT_BUCKETS_MS: readonly number[] = [
  0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000,
];

/** @internal */
export function escapePrometheusLabelValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function normalizePrefix(prefix: string): string {
  if (prefix.length === 0) return DEFAULT_PREFIX;
  return prefix.endsWith('_') ? prefix : `${prefix}_`;
}

/** Add samples to cumulative Prometheus histogram bucket counts (each bucket counts obs ≤ le). */
function addSamplesToHistogram(
  buckets: readonly number[],
  acc: number[],
  samples: readonly number[],
): number {
  let sumDelta = 0;
  for (let si = 0; si < samples.length; si++) {
    const v = samples[si]!;
    sumDelta += v;
    for (let bi = 0; bi < buckets.length; bi++) {
      if (v <= buckets[bi]!) acc[bi]! += 1;
    }
    acc[buckets.length]! += 1;
  }
  return sumDelta;
}

export interface PrometheusAdapterOptions {
  /** Metric name prefix (default `ratelimit_`). */
  readonly prefix?: string;
  /**
   * Optional prom-client {@link Registry}. When set, metrics are registered and updated on each
   * `metrics` event (for integration with an existing `/metrics` scrape).
   */
  readonly registry?: Registry;
  /** Upper bounds (ms) for latency histograms; defaults match {@link MetricsCollector}. */
  readonly histogramBuckets?: readonly number[];
}

type PromClientModule = typeof import('prom-client');

/**
 * Prometheus text exposition (standalone) and optional prom-client {@link Registry} integration.
 * Does **not** require `prom-client` at runtime unless `registry` is passed.
 *
 * @example
 * ```ts
 * import { Registry } from 'prom-client';
 * import { MetricsCounters, MetricsCollector, PrometheusAdapter } from 'ratelimit-flex';
 *
 * const counters = new MetricsCounters();
 * const collector = new MetricsCollector({ counters, intervalMs: 10_000 });
 * const adapter = new PrometheusAdapter(collector, {
 *   prefix: 'ratelimit_',
 *   registry: new Registry(),
 * });
 * app.get('/metrics', adapter.metricsEndpoint());
 * collector.start();
 * ```
 *
 * @since 1.3.0
 */
export class PrometheusAdapter {
  private readonly collector: MetricsCollector;

  private readonly prefix: string;

  private readonly buckets: readonly number[];

  private readonly registry?: Registry;

  private readonly onMetrics: (snap: MetricsSnapshot) => void;

  private lastSnapshot: MetricsSnapshot | null = null;

  private prom: PromClientModule | null = null;

  private promRegisterPromise: Promise<void> | null = null;

  /** Cumulative histogram state for {@link getMetricsText} (standalone exposition). */
  private readonly textMwBuckets: number[];

  private textMwSum = 0;

  private textMwCount = 0;

  private readonly textStBuckets: number[];

  private textStSum = 0;

  private textStCount = 0;

  private requestsCounter: import('prom-client').Counter<string> | null = null;

  private skippedCounter: import('prom-client').Counter<string> | null = null;

  private allowlistedCounter: import('prom-client').Counter<string> | null = null;

  private rpsGauge: import('prom-client').Gauge<string> | null = null;

  private blockRateGauge: import('prom-client').Gauge<string> | null = null;

  private hotKeyGauge: import('prom-client').Gauge<string> | null = null;

  private middlewareHist: import('prom-client').Histogram<string> | null = null;

  private storeHist: import('prom-client').Histogram<string> | null = null;

  constructor(collector: MetricsCollector, options?: PrometheusAdapterOptions) {
    this.collector = collector;
    this.prefix = normalizePrefix(options?.prefix ?? DEFAULT_PREFIX);
    this.buckets = options?.histogramBuckets ?? DEFAULT_BUCKETS_MS;
    this.registry = options?.registry;
    const nb = this.buckets.length + 1;
    this.textMwBuckets = new Array(nb).fill(0) as number[];
    this.textStBuckets = new Array(nb).fill(0) as number[];

    this.onMetrics = (snap: MetricsSnapshot) => {
      const prev = this.lastSnapshot;
      this.lastSnapshot = snap;
      const lat = snap.latencySamplesMs ?? [];
      const st = snap.storeLatencySamplesMs ?? [];
      this.textMwSum += addSamplesToHistogram(this.buckets, this.textMwBuckets, lat);
      this.textMwCount += lat.length;
      this.textStSum += addSamplesToHistogram(this.buckets, this.textStBuckets, st);
      this.textStCount += st.length;
      if (this.registry !== undefined && this.registry !== null) {
        void this.ensurePromClientAndRegister().then(() => {
          this.updateRegistry(snap, prev);
        });
      }
    };
    collector.on('metrics', this.onMetrics);
  }

  /**
   * Stops listening to the collector (for tests / shutdown).
   */
  destroy(): void {
    this.collector.off('metrics', this.onMetrics);
  }

  /**
   * Synchronous Prometheus text exposition from the last `metrics` event (or empty HELP stubs if none yet).
   */
  getMetricsText(): string {
    const snap = this.lastSnapshot;
    const p = this.prefix;
    const lines: string[] = [];

    const nameReq = `${p}requests_total`;
    const nameSkip = `${p}requests_skipped_total`;
    const nameAllow = `${p}requests_allowlisted_total`;
    const nameMw = `${p}middleware_duration_milliseconds`;
    const nameSt = `${p}store_duration_milliseconds`;
    const nameRps = `${p}requests_per_second`;
    const nameBr = `${p}block_rate`;
    const nameHot = `${p}hot_key_hits`;

    lines.push(`# HELP ${nameReq} Total requests processed by the rate limiter`);
    lines.push(`# TYPE ${nameReq} counter`);
    if (snap) {
      lines.push(
        `${nameReq}{status="allowed",reason="none"} ${snap.totals.allowed}`,
      );
      lines.push(
        `${nameReq}{status="blocked",reason="rate_limit"} ${snap.blockReasons.rateLimit}`,
      );
      lines.push(
        `${nameReq}{status="blocked",reason="blocklist"} ${snap.blockReasons.blocklist}`,
      );
      lines.push(
        `${nameReq}{status="blocked",reason="penalty"} ${snap.blockReasons.penalty}`,
      );
      lines.push(
        `${nameReq}{status="blocked",reason="key_manager"} ${snap.blockReasons.keyManager}`,
      );
      lines.push(
        `${nameReq}{status="blocked",reason="service_unavailable"} ${snap.blockReasons.serviceUnavailable}`,
      );
    } else {
      lines.push(`${nameReq}{status="allowed",reason="none"} 0`);
      lines.push(`${nameReq}{status="blocked",reason="rate_limit"} 0`);
      lines.push(`${nameReq}{status="blocked",reason="blocklist"} 0`);
      lines.push(`${nameReq}{status="blocked",reason="penalty"} 0`);
      lines.push(`${nameReq}{status="blocked",reason="key_manager"} 0`);
      lines.push(`${nameReq}{status="blocked",reason="service_unavailable"} 0`);
    }

    lines.push(`# HELP ${nameSkip} Requests skipped via skip()`);
    lines.push(`# TYPE ${nameSkip} counter`);
    lines.push(`${nameSkip} ${snap ? snap.totals.skipped : 0}`);

    lines.push(`# HELP ${nameAllow} Requests matched allowlist`);
    lines.push(`# TYPE ${nameAllow} counter`);
    lines.push(`${nameAllow} ${snap ? snap.totals.allowlisted : 0}`);

    lines.push(`# HELP ${nameMw} Middleware / rate limiter handler duration in milliseconds`);
    lines.push(`# TYPE ${nameMw} histogram`);
    for (let i = 0; i < this.buckets.length; i++) {
      lines.push(`${nameMw}_bucket{le="${this.buckets[i]}"} ${this.textMwBuckets[i]}`);
    }
    lines.push(`${nameMw}_bucket{le="+Inf"} ${this.textMwBuckets[this.buckets.length]}`);
    lines.push(`${nameMw}_sum ${this.textMwSum}`);
    lines.push(`${nameMw}_count ${this.textMwCount}`);

    lines.push(`# HELP ${nameSt} Store increment (e.g. Redis) duration in milliseconds`);
    lines.push(`# TYPE ${nameSt} histogram`);
    for (let i = 0; i < this.buckets.length; i++) {
      lines.push(`${nameSt}_bucket{le="${this.buckets[i]}"} ${this.textStBuckets[i]}`);
    }
    lines.push(`${nameSt}_bucket{le="+Inf"} ${this.textStBuckets[this.buckets.length]}`);
    lines.push(`${nameSt}_sum ${this.textStSum}`);
    lines.push(`${nameSt}_count ${this.textStCount}`);

    lines.push(`# HELP ${nameRps} Estimated requests per second over the aggregation window`);
    lines.push(`# TYPE ${nameRps} gauge`);
    lines.push(`${nameRps} ${snap ? snap.window.requestsPerSecond : 0}`);

    lines.push(`# HELP ${nameBr} Block rate (0–1) over the aggregation window`);
    lines.push(`# TYPE ${nameBr} gauge`);
    lines.push(`${nameBr} ${snap ? snap.window.blockRate : 0}`);

    lines.push(`# HELP ${nameHot} Observed hits per hot key (top K)`);
    lines.push(`# TYPE ${nameHot} gauge`);
    if (snap) {
      for (const hk of snap.hotKeys) {
        const k = escapePrometheusLabelValue(hk.key);
        lines.push(`${nameHot}{key="${k}"} ${hk.hits}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }

  /**
   * Express middleware: respond to **GET** with `text/plain` Prometheus exposition.
   * Mount with `app.get('/metrics', adapter.metricsEndpoint())`.
   */
  metricsEndpoint(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET') {
        next();
        return;
      }
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.end(this.getMetricsText());
    };
  }

  private async ensurePromClientAndRegister(): Promise<void> {
    if (this.prom !== null) return;
    if (this.promRegisterPromise !== null) {
      await this.promRegisterPromise;
      return;
    }
    this.promRegisterPromise = (async () => {
      this.prom = await import('prom-client');
    const prom = this.prom;
    const reg = this.registry!;
    const p = this.prefix;

    this.requestsCounter = new prom.Counter({
      name: `${p}requests_total`,
      help: 'Total requests processed by the rate limiter',
      labelNames: ['status', 'reason'],
      registers: [reg],
    });
    this.skippedCounter = new prom.Counter({
      name: `${p}requests_skipped_total`,
      help: 'Requests skipped via skip()',
      registers: [reg],
    });
    this.allowlistedCounter = new prom.Counter({
      name: `${p}requests_allowlisted_total`,
      help: 'Requests matched allowlist',
      registers: [reg],
    });
    this.rpsGauge = new prom.Gauge({
      name: `${p}requests_per_second`,
      help: 'Estimated requests per second over the aggregation window',
      registers: [reg],
    });
    this.blockRateGauge = new prom.Gauge({
      name: `${p}block_rate`,
      help: 'Block rate (0–1) over the aggregation window',
      registers: [reg],
    });
    this.hotKeyGauge = new prom.Gauge({
      name: `${p}hot_key_hits`,
      help: 'Observed hits per hot key (top K)',
      labelNames: ['key'],
      registers: [reg],
    });
    this.middlewareHist = new prom.Histogram({
      name: `${p}middleware_duration_milliseconds`,
      help: 'Middleware / rate limiter handler duration in milliseconds',
      buckets: [...this.buckets],
      registers: [reg],
    });
    this.storeHist = new prom.Histogram({
      name: `${p}store_duration_milliseconds`,
      help: 'Store increment duration in milliseconds',
      buckets: [...this.buckets],
      registers: [reg],
    });
    })();
    await this.promRegisterPromise;
  }

  private updateRegistry(s: MetricsSnapshot, prev: MetricsSnapshot | null): void {
    const prom = this.prom;
    if (!prom || !this.requestsCounter || !this.skippedCounter || !this.allowlistedCounter) return;

    const inc = (cur: number, old: number) => Math.max(0, cur - old);

    if (prev) {
      const dAllowed = inc(s.totals.allowed, prev.totals.allowed);
      if (dAllowed > 0) this.requestsCounter.inc({ status: 'allowed', reason: 'none' }, dAllowed);
      const dRl = inc(s.blockReasons.rateLimit, prev.blockReasons.rateLimit);
      if (dRl > 0) this.requestsCounter.inc({ status: 'blocked', reason: 'rate_limit' }, dRl);
      const dBl = inc(s.blockReasons.blocklist, prev.blockReasons.blocklist);
      if (dBl > 0) this.requestsCounter.inc({ status: 'blocked', reason: 'blocklist' }, dBl);
      const dPn = inc(s.blockReasons.penalty, prev.blockReasons.penalty);
      if (dPn > 0) this.requestsCounter.inc({ status: 'blocked', reason: 'penalty' }, dPn);
      const dKm = inc(s.blockReasons.keyManager, prev.blockReasons.keyManager);
      if (dKm > 0) this.requestsCounter.inc({ status: 'blocked', reason: 'key_manager' }, dKm);
      const dSu = inc(s.blockReasons.serviceUnavailable, prev.blockReasons.serviceUnavailable);
      if (dSu > 0) this.requestsCounter.inc({ status: 'blocked', reason: 'service_unavailable' }, dSu);
      const dSk = inc(s.totals.skipped, prev.totals.skipped);
      if (dSk > 0) this.skippedCounter.inc(dSk);
      const dAl = inc(s.totals.allowlisted, prev.totals.allowlisted);
      if (dAl > 0) this.allowlistedCounter.inc(dAl);
    } else {
      if (s.totals.allowed > 0) this.requestsCounter.inc({ status: 'allowed', reason: 'none' }, s.totals.allowed);
      if (s.blockReasons.rateLimit > 0) {
        this.requestsCounter.inc({ status: 'blocked', reason: 'rate_limit' }, s.blockReasons.rateLimit);
      }
      if (s.blockReasons.blocklist > 0) {
        this.requestsCounter.inc({ status: 'blocked', reason: 'blocklist' }, s.blockReasons.blocklist);
      }
      if (s.blockReasons.penalty > 0) {
        this.requestsCounter.inc({ status: 'blocked', reason: 'penalty' }, s.blockReasons.penalty);
      }
      if (s.blockReasons.keyManager > 0) {
        this.requestsCounter.inc({ status: 'blocked', reason: 'key_manager' }, s.blockReasons.keyManager);
      }
      if (s.blockReasons.serviceUnavailable > 0) {
        this.requestsCounter.inc({ status: 'blocked', reason: 'service_unavailable' }, s.blockReasons.serviceUnavailable);
      }
      if (s.totals.skipped > 0) this.skippedCounter.inc(s.totals.skipped);
      if (s.totals.allowlisted > 0) this.allowlistedCounter.inc(s.totals.allowlisted);
    }

    this.rpsGauge?.set(s.window.requestsPerSecond);
    this.blockRateGauge?.set(s.window.blockRate);

    if (this.hotKeyGauge) {
      for (const hk of s.hotKeys) {
        this.hotKeyGauge.set({ key: hk.key }, hk.hits);
      }
    }

    const lat = s.latencySamplesMs ?? [];
    const st = s.storeLatencySamplesMs ?? [];
    if (this.middlewareHist) {
      for (let i = 0; i < lat.length; i++) {
        this.middlewareHist.observe(lat[i]!);
      }
    }
    if (this.storeHist) {
      for (let i = 0; i < st.length; i++) {
        this.storeHist.observe(st[i]!);
      }
    }
  }
}
