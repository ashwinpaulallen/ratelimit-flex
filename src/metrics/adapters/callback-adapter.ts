import { EventEmitter } from 'node:events';
import type { MetricsSnapshot } from '../../types/metrics.js';
import type { MetricsCollector } from '../collector.js';

/**
 * Subscribes to {@link MetricsCollector} `metrics` events and forwards each {@link MetricsSnapshot} to
 * `onMetrics` (and to this adapter’s own `'metrics'` listeners). Usually constructed by {@link MetricsManager}
 * when `metrics.onMetrics` is set.
 *
 * @example
 * ```ts
 * import { MetricsCounters, MetricsCollector, CallbackAdapter } from 'ratelimit-flex';
 *
 * const counters = new MetricsCounters();
 * const collector = new MetricsCollector({
 *   counters,
 *   intervalMs: 10_000,
 * });
 * const cb = new CallbackAdapter(collector, (snap) => {
 *   console.log('rps', snap.window.requestsPerSecond);
 * });
 * cb.on('metrics', (snap) => {
 *   void snap.window.requestsPerSecond;
 * });
 * collector.start();
 * ```
 *
 * @since 1.3.0
 */
export class CallbackAdapter extends EventEmitter {
  private readonly collector: MetricsCollector;

  constructor(collector: MetricsCollector, onMetrics?: (snapshot: MetricsSnapshot) => void) {
    super();
    this.collector = collector;
    const handler = (snapshot: MetricsSnapshot) => {
      onMetrics?.(snapshot);
      this.emit('metrics', snapshot);
    };
    collector.on('metrics', handler);
  }

  /** Latest snapshot from the collector (`null` before the first tick). */
  getSnapshot(): MetricsSnapshot | null {
    return this.collector.getSnapshot();
  }

  /** Sliding window of recent snapshots from the collector. */
  getHistory(): MetricsSnapshot[] {
    return this.collector.getHistory();
  }
}
