import type { FastifyReply, FastifyRequest } from 'fastify';
import type { NextFunction, Request, Response } from 'express';
import type { Registry } from 'prom-client';
import { CallbackAdapter } from './adapters/callback-adapter.js';
import { OpenTelemetryAdapter } from './adapters/opentelemetry-adapter.js';
import { PrometheusAdapter } from './adapters/prometheus-adapter.js';
import { MetricsCollector } from './collector.js';
import { MetricsCounters } from './counters.js';
import type { InMemoryShield } from '../shield/InMemoryShield.js';
import type { MetricsConfig, MetricsSnapshot } from '../types/metrics.js';
import { normalizeMetricsConfig } from './normalize.js';

/**
 * Wires {@link MetricsCounters}, {@link MetricsCollector}, and optional {@link PrometheusAdapter} /
 * {@link OpenTelemetryAdapter} / {@link CallbackAdapter} from normalized {@link MetricsConfig}.
 * Use {@link start} after construction (middleware does this lazily), {@link getSnapshot} /
 * {@link getHistory} for dashboards, and {@link shutdown} on process exit.
 *
 * @since 1.3.0
 */
export class MetricsManager {
  private readonly normalized: MetricsConfig | undefined;

  private readonly counters: MetricsCounters | null;

  private readonly collector: MetricsCollector | null;

  private readonly prometheusAdapter: PrometheusAdapter | null;

  private readonly openTelemetryAdapter: OpenTelemetryAdapter | null;

  /**
   * @param shield — Same {@link InMemoryShield} reference the engine uses as `store` after
   *   {@link resolveStoreWithInMemoryShield} (or `null` / omitted). {@link MetricsCollector} fills
   *   `snapshot.shield` from `shield.getMetrics()`; request counters still reflect the path through
   *   the engine. If multiple shields are stacked, only this instance is observed (usually the outer layer).
   */
  constructor(
    config: MetricsConfig | boolean | undefined,
    shield?: InMemoryShield | null,
  ) {
    const normalized = normalizeMetricsConfig(config);
    this.normalized = normalized;
    if (normalized === undefined) {
      this.counters = null;
      this.collector = null;
      this.prometheusAdapter = null;
      this.openTelemetryAdapter = null;
      return;
    }

    this.counters = new MetricsCounters();
    this.collector = new MetricsCollector({
      counters: this.counters,
      intervalMs: normalized.intervalMs,
      topKSize: normalized.topKSize,
      histogramBuckets: normalized.histogramBuckets,
      shield,
    });

    if (normalized.onMetrics) {
      new CallbackAdapter(this.collector, normalized.onMetrics);
    }

    const prom = normalized.prometheus;
    if (prom?.enabled === true) {
      this.prometheusAdapter = new PrometheusAdapter(this.collector, {
        prefix: prom.prefix,
        registry: prom.registry as Registry | undefined,
        histogramBuckets: normalized.histogramBuckets,
      });
    } else {
      this.prometheusAdapter = null;
    }

    const otel = normalized.openTelemetry;
    if (otel?.enabled === true && otel.meter !== undefined && otel.meter !== null) {
      this.openTelemetryAdapter = new OpenTelemetryAdapter({
        collector: this.collector,
        meter: otel.meter,
        prefix: otel.prefix,
      });
    } else {
      this.openTelemetryAdapter = null;
    }
  }

  /** `true` when metrics were enabled in config (counters/collector exist). */
  isEnabled(): boolean {
    return this.normalized !== undefined;
  }

  getCounters(): MetricsCounters | null {
    return this.counters;
  }

  start(): void {
    this.collector?.start();
  }

  stop(): void {
    this.collector?.stop();
  }

  getSnapshot(): MetricsSnapshot | null {
    return this.collector?.getSnapshot() ?? null;
  }

  getHistory(): MetricsSnapshot[] {
    return this.collector?.getHistory() ?? [];
  }

  getPrometheusMetrics(): string | null {
    return this.prometheusAdapter?.getMetricsText() ?? null;
  }

  getPrometheusMiddleware(): ((req: Request, res: Response, next: NextFunction) => void) | null {
    return this.prometheusAdapter?.metricsEndpoint() ?? null;
  }

  /**
   * Native Fastify handler for `GET /metrics` (Prometheus text exposition). Use with
   * `app.get('/metrics', app.fastifyMetricsRoute)` when the Fastify plugin decorates it.
   * `null` when `metrics.prometheus.enabled` is not set — use {@link getPrometheusMiddleware} for Express instead.
   */
  getPrometheusFastifyHandler(): ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) | null {
    const adapter = this.prometheusAdapter;
    if (adapter === null) return null;
    return async (_request: FastifyRequest, reply: FastifyReply) => {
      await reply.type('text/plain; version=0.0.4; charset=utf-8').send(adapter.getMetricsText());
    };
  }

  on(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): void {
    if (!this.collector) return;
    this.collector.on(event, listener);
  }

  off(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): void {
    if (!this.collector) return;
    this.collector.off(event, listener);
  }

  once(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): void {
    if (!this.collector) return;
    this.collector.once(event, listener);
  }

  removeListener(event: 'metrics', listener: (snapshot: MetricsSnapshot) => void): void {
    if (!this.collector) return;
    this.collector.removeListener(event, listener);
  }

  getOpenTelemetryAdapter(): OpenTelemetryAdapter | null {
    return this.openTelemetryAdapter;
  }

  async shutdown(): Promise<void> {
    this.stop();
    this.prometheusAdapter?.destroy();
    this.openTelemetryAdapter?.shutdown();
    await this.collector?.shutdown();
  }
}
