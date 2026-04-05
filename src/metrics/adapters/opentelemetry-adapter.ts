import type { MetricsCollector } from '../collector.js';
import type { MetricsSnapshot } from '../../types/metrics.js';

const DEFAULT_PREFIX = 'ratelimit';

type ObservableResult = { observe: (value: number, attributes?: Record<string, string>) => void };

/** Minimal OpenTelemetry `Meter` surface used by this adapter (no `@opentelemetry/api` import). */
type OtelMeterLike = {
  createCounter: (
    name: string,
    options?: { description?: string },
  ) => { add: (value: number, attributes?: Record<string, string>) => void };
  createHistogram: (
    name: string,
    options?: { description?: string; unit?: string },
  ) => { record: (value: number, attributes?: Record<string, string>) => void };
  createObservableGauge: (
    name: string,
    options?: { description?: string; unit?: string },
  ) => {
    addCallback: (callback: (observableResult: ObservableResult) => void) => void;
    removeCallback: (callback: (observableResult: ObservableResult) => void) => void;
  };
};

export interface OpenTelemetryAdapterOptions {
  readonly collector: MetricsCollector;
  /** User-provided OpenTelemetry `Meter` (e.g. from `metrics.getMeter(...)`). */
  readonly meter: unknown;
  /** Metric name prefix (default `ratelimit`). Instrument names are `{prefix}_requests_total`, etc. */
  readonly prefix?: string;
}

/**
 * Bridges {@link MetricsCollector} `metrics` events to OpenTelemetry instruments using a user-supplied
 * meter. Does **not** depend on `@opentelemetry/api` in this package — pass your own `Meter` instance.
 *
 * @example
 * ```ts
 * import { metrics } from '@opentelemetry/api';
 * import { MetricsCounters, MetricsCollector, OpenTelemetryAdapter } from 'ratelimit-flex';
 *
 * const meter = metrics.getMeter('my-service');
 * const counters = new MetricsCounters();
 * const collector = new MetricsCollector({ counters, intervalMs: 10_000 });
 * new OpenTelemetryAdapter({ collector, meter, prefix: 'ratelimit' });
 * collector.start();
 * ```
 *
 * @since 1.3.0
 */
export class OpenTelemetryAdapter {
  private readonly collector: MetricsCollector;

  private readonly meter: OtelMeterLike;

  private readonly prefix: string;

  private lastSnapshot: MetricsSnapshot | null = null;

  private readonly requestsCounter: ReturnType<OtelMeterLike['createCounter']>;

  private readonly middlewareHistogram: ReturnType<OtelMeterLike['createHistogram']>;

  private readonly storeHistogram: ReturnType<OtelMeterLike['createHistogram']>;

  private readonly rpsGauge: ReturnType<OtelMeterLike['createObservableGauge']>;

  private readonly blockRateGauge: ReturnType<OtelMeterLike['createObservableGauge']>;

  private readonly hotKeyGauge: ReturnType<OtelMeterLike['createObservableGauge']>;

  private readonly rpsCallback: (r: ObservableResult) => void;

  private readonly blockRateCallback: (r: ObservableResult) => void;

  private readonly hotKeyCallback: (r: ObservableResult) => void;

  private readonly onMetrics: (snap: MetricsSnapshot) => void;

  constructor(options: OpenTelemetryAdapterOptions) {
    this.collector = options.collector;
    this.meter = options.meter as OtelMeterLike;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    const p = this.prefix;
    const m = this.meter;

    this.requestsCounter = m.createCounter(`${p}_requests_total`, {
      description: 'Requests processed by the rate limiter',
    });
    this.middlewareHistogram = m.createHistogram(`${p}_middleware_duration_ms`, {
      description: 'Middleware / rate limiter handler duration in milliseconds',
      unit: 'ms',
    });
    this.storeHistogram = m.createHistogram(`${p}_store_duration_ms`, {
      description: 'Store increment duration in milliseconds',
      unit: 'ms',
    });

    this.rpsGauge = m.createObservableGauge(`${p}_requests_per_second`, {
      description: 'Estimated requests per second over the aggregation window',
    });
    this.blockRateGauge = m.createObservableGauge(`${p}_block_rate`, {
      description: 'Block rate (0–1) over the aggregation window',
    });
    this.hotKeyGauge = m.createObservableGauge(`${p}_hot_key_hits`, {
      description: 'Observed hits per hot key (top K)',
    });

    this.rpsCallback = (observableResult) => {
      const snap = this.lastSnapshot;
      observableResult.observe(snap !== null ? snap.window.requestsPerSecond : 0);
    };
    this.blockRateCallback = (observableResult) => {
      const snap = this.lastSnapshot;
      observableResult.observe(snap !== null ? snap.window.blockRate : 0);
    };
    this.hotKeyCallback = (observableResult) => {
      const snap = this.lastSnapshot;
      if (snap === null) return;
      for (const hk of snap.hotKeys) {
        observableResult.observe(hk.hits, { key: hk.key });
      }
    };

    this.rpsGauge.addCallback(this.rpsCallback);
    this.blockRateGauge.addCallback(this.blockRateCallback);
    this.hotKeyGauge.addCallback(this.hotKeyCallback);

    this.onMetrics = (snap: MetricsSnapshot) => {
      const prev = this.lastSnapshot;
      this.lastSnapshot = snap;
      this.applyCounterDeltas(snap, prev);
      this.recordLatencyHistograms(snap);
    };
    this.collector.on('metrics', this.onMetrics);
  }

  /**
   * Stops listening to the collector and removes observable gauge callbacks (for tests / shutdown).
   */
  shutdown(): void {
    this.collector.off('metrics', this.onMetrics);
    this.rpsGauge.removeCallback(this.rpsCallback);
    this.blockRateGauge.removeCallback(this.blockRateCallback);
    this.hotKeyGauge.removeCallback(this.hotKeyCallback);
  }

  private applyCounterDeltas(s: MetricsSnapshot, prev: MetricsSnapshot | null): void {
    const inc = (cur: number, old: number) => Math.max(0, cur - old);
    const c = this.requestsCounter;

    if (prev) {
      const dAllowed = inc(s.totals.allowed, prev.totals.allowed);
      if (dAllowed > 0) c.add(dAllowed, { status: 'allowed', reason: 'none' });
      const dRl = inc(s.blockReasons.rateLimit, prev.blockReasons.rateLimit);
      if (dRl > 0) c.add(dRl, { status: 'blocked', reason: 'rate_limit' });
      const dBl = inc(s.blockReasons.blocklist, prev.blockReasons.blocklist);
      if (dBl > 0) c.add(dBl, { status: 'blocked', reason: 'blocklist' });
      const dPn = inc(s.blockReasons.penalty, prev.blockReasons.penalty);
      if (dPn > 0) c.add(dPn, { status: 'blocked', reason: 'penalty' });
      const dKm = inc(s.blockReasons.keyManager, prev.blockReasons.keyManager);
      if (dKm > 0) c.add(dKm, { status: 'blocked', reason: 'key_manager' });
      const dSu = inc(s.blockReasons.serviceUnavailable, prev.blockReasons.serviceUnavailable);
      if (dSu > 0) c.add(dSu, { status: 'blocked', reason: 'service_unavailable' });
      const dSk = inc(s.totals.skipped, prev.totals.skipped);
      if (dSk > 0) c.add(dSk, { status: 'skipped', reason: 'none' });
      const dAl = inc(s.totals.allowlisted, prev.totals.allowlisted);
      if (dAl > 0) c.add(dAl, { status: 'allowlisted', reason: 'none' });
    } else {
      if (s.totals.allowed > 0) c.add(s.totals.allowed, { status: 'allowed', reason: 'none' });
      if (s.blockReasons.rateLimit > 0) {
        c.add(s.blockReasons.rateLimit, { status: 'blocked', reason: 'rate_limit' });
      }
      if (s.blockReasons.blocklist > 0) {
        c.add(s.blockReasons.blocklist, { status: 'blocked', reason: 'blocklist' });
      }
      if (s.blockReasons.penalty > 0) {
        c.add(s.blockReasons.penalty, { status: 'blocked', reason: 'penalty' });
      }
      if (s.blockReasons.keyManager > 0) {
        c.add(s.blockReasons.keyManager, { status: 'blocked', reason: 'key_manager' });
      }
      if (s.blockReasons.serviceUnavailable > 0) {
        c.add(s.blockReasons.serviceUnavailable, { status: 'blocked', reason: 'service_unavailable' });
      }
      if (s.totals.skipped > 0) c.add(s.totals.skipped, { status: 'skipped', reason: 'none' });
      if (s.totals.allowlisted > 0) c.add(s.totals.allowlisted, { status: 'allowlisted', reason: 'none' });
    }
  }

  private recordLatencyHistograms(s: MetricsSnapshot): void {
    const lat = s.latencySamplesMs ?? [];
    const st = s.storeLatencySamplesMs ?? [];
    for (let i = 0; i < lat.length; i++) {
      this.middlewareHistogram.record(lat[i]!);
    }
    for (let i = 0; i < st.length; i++) {
      this.storeHistogram.record(st[i]!);
    }
  }
}
