export { CallbackAdapter } from './adapters/callback-adapter.js';
export {
  OpenTelemetryAdapter,
  type OpenTelemetryAdapterOptions,
} from './adapters/opentelemetry-adapter.js';
export {
  PrometheusAdapter,
  type PrometheusAdapterOptions,
} from './adapters/prometheus-adapter.js';
export { MetricsCollector } from './collector.js';
export { MetricsCounters } from './counters.js';
export { Histogram, assertHistogramBucketBounds } from './histogram.js';
export { MetricsManager } from './manager.js';
export { createMetricsCountersIfEnabled, normalizeMetricsConfig } from './normalize.js';
