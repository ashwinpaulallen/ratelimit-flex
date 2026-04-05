import { MemoryStore } from '../stores/memory-store.js';
import { RateLimitStrategy } from '../types/index.js';
import type { RateLimitStore } from '../types/index.js';
import { ComposedStore } from './ComposedStore.js';
import type { CompositionLayer } from './types.js';

/**
 * Fluent builder for composing rate limit stores.
 *
 * @example
 * ```ts
 * const store = compose.all(
 *   compose.layer('per-second', perSecStore),
 *   compose.layer('per-minute', perMinStore),
 * );
 *
 * const store = compose.overflow(
 *   compose.layer('steady', steadyStore),
 *   compose.layer('burst', burstStore),
 * );
 * ```
 *
 * @since 2.0.0
 */
export const compose = {
  /**
   * Create a named layer. A layer wraps a {@link RateLimitStore} with a label
   * and optional configuration.
   */
  layer(
    label: string,
    store: RateLimitStore,
    options?: {
      keyTransform?: (key: string) => string;
      maxRequests?: number;
    },
  ): CompositionLayer {
    return { label, store, ...options };
  },

  /**
   * Block if ANY layer blocks. Rollback succeeded layers when one blocks.
   * Use case: multi-window limiting (10/sec + 100/min + 1000/hour).
   */
  all(...layers: CompositionLayer[]): ComposedStore {
    return new ComposedStore({ mode: 'all', layers, rollbackOnBlock: true });
  },

  /**
   * Try primary first. If blocked, overflow into burst pool.
   * Only block if BOTH are exhausted.
   */
  overflow(primary: CompositionLayer, burst: CompositionLayer): ComposedStore {
    return new ComposedStore({ mode: 'overflow', layers: [primary, burst] });
  },

  /**
   * Try layers in order. Use the first that allows.
   * Use case: failover (local Redis → remote Redis → memory).
   */
  firstAvailable(...layers: CompositionLayer[]): ComposedStore {
    return new ComposedStore({ mode: 'first-available', layers });
  },

  /**
   * Fire all layers in parallel. Use the fastest response.
   * Use case: multi-region latency optimization.
   */
  race(...layers: CompositionLayer[]): ComposedStore {
    return new ComposedStore({ mode: 'race', layers, raceTimeoutMs: 5000 });
  },

  /**
   * Multi-window composition from simple config objects.
   * Creates {@link MemoryStore} instances (sliding window unless `strategy` is set).
   */
  windows(
    ...configs: Array<{
      windowMs: number;
      maxRequests: number;
      strategy?: RateLimitStrategy.SLIDING_WINDOW | RateLimitStrategy.FIXED_WINDOW;
    }>
  ): ComposedStore {
    const layers: CompositionLayer[] = configs.map((cfg, i) => {
      const strategy = cfg.strategy ?? RateLimitStrategy.SLIDING_WINDOW;
      const store = new MemoryStore({ strategy, windowMs: cfg.windowMs, maxRequests: cfg.maxRequests });
      /** Stable unique labels (aligns with {@link WindowRateLimitOptions.limits} indices). */
      return compose.layer(`limit-${i}`, store);
    });
    return compose.all(...layers);
  },

  /**
   * Burst allowance shorthand: primary steady cap + burst pool.
   */
  withBurst(config: {
    steady: { windowMs: number; maxRequests: number; store?: RateLimitStore };
    burst: { windowMs: number; maxRequests: number; store?: RateLimitStore };
  }): ComposedStore {
    const steadyStore =
      config.steady.store ??
      new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: config.steady.windowMs,
        maxRequests: config.steady.maxRequests,
      });
    const burstStore =
      config.burst.store ??
      new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: config.burst.windowMs,
        maxRequests: config.burst.maxRequests,
      });
    return compose.overflow(compose.layer('steady', steadyStore), compose.layer('burst', burstStore));
  },
};
