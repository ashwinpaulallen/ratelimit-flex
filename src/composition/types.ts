import type { RateLimitIncrementOptions, RateLimitResult, RateLimitStore } from '../types/index.js';

export type { RateLimitIncrementOptions };

/**
 * How multiple layers interact when evaluating a request.
 *
 * - 'all': Increment ALL layers. Block if ANY layer blocks.
 *    Use case: "10/sec AND 100/min AND 1000/hour" — multiple windows.
 *    Same idea as the `limits` array option: several windows that must all allow.
 *
 * - 'overflow': Try primary layer first. If primary blocks, try the overflow layer
 *    (burst pool). Primary counts are kept when blocked; only block if BOTH are exhausted.
 *    Use case: "5/sec steady + 20 extra burst tokens over 60s."
 *
 * - 'first-available': Try layers in order. Return the first layer that ALLOWS.
 *    Only block if ALL layers block.
 *    Use case: "Try local Redis, fall back to remote Redis, fall back to memory."
 *    Replaces: manual failover chains.
 *
 * - 'race': Fire all layers in parallel, resolve with the first response.
 *    Block if the first response blocks.
 *    Use case: latency-sensitive multi-region setups.
 */
export type CompositionMode = 'all' | 'overflow' | 'first-available' | 'race';

/**
 * A named layer in a composition. The label is used for per-layer result reporting.
 */
export interface CompositionLayer {
  /** Human-readable label for this layer (used in results and debugging) */
  label: string;
  /** The backing store for this layer */
  store: RateLimitStore;
  /**
   * Optional key transform — lets different layers use different key namespaces.
   * Default: passes the key through unchanged.
   * In {@link ComposedStore} **`overflow`** mode, the burst layer defaults to `burst:${key}` unless you set
   * `keyTransform` (use `(k) => k` to store burst under the same key as primary when stores are separate).
   */
  keyTransform?: (key: string) => string;
  /**
   * Optional per-layer maxRequests override.
   * If set, this value is passed as options.maxRequests to the layer's increment() call.
   */
  maxRequests?: number;
}

/**
 * Per-layer row in {@link ComposedIncrementResult.layers}.
 */
export type ComposedLayerRow = {
  totalHits: number;
  remaining: number;
  resetTime: Date;
  isBlocked: boolean;
  /** Was this layer actually consulted? (false if short-circuited) */
  consulted: boolean;
  /** Did this layer error? If so, the error message */
  error?: string;
  /**
   * When this layer’s {@link CompositionLayer.store} is a nested {@link ComposedStore},
   * per-layer rows from that inner composition (recursive).
   */
  innerLayers?: Record<string, ComposedLayerRow>;
};

/**
 * Result from a composed increment — assignable to {@link RateLimitResult} (implements {@link RateLimitStore}).
 */
export type ComposedIncrementResult = RateLimitResult & {
  /** Which composition mode was used */
  mode: CompositionMode;

  /** Which layer determined the final outcome (label) */
  decidingLayer: string;

  /**
   * Dot-separated path to the deciding layer when using nested {@link ComposedStore} (e.g. `rate.steady`).
   * Prefer this for display; {@link decidingLayer} stays the top-level label where needed for compatibility.
   */
  decidingPath?: string;

  /** Per-layer results for observability / debugging */
  layers: Record<string, ComposedLayerRow>;
};

/**
 * True when {@link RateLimitStore.increment} returned a nested {@link ComposedIncrementResult}
 * (composed store) rather than a plain {@link RateLimitResult}.
 */
export function isComposedIncrementResult(r: RateLimitResult): r is ComposedIncrementResult {
  return (
    typeof r === 'object' &&
    r !== null &&
    'layers' in r &&
    r.layers !== undefined &&
    typeof (r as ComposedIncrementResult).mode === 'string' &&
    typeof (r as ComposedIncrementResult).decidingLayer === 'string'
  );
}

/**
 * Options for ComposedStore constructor.
 */
export interface ComposedStoreOptions {
  mode: CompositionMode;
  layers: CompositionLayer[];
  /**
   * For 'all' mode: whether to rollback (decrement) layers that succeeded
   * when a later layer blocks. Default: true.
   * This prevents "leaking" counts on the lenient layers when a strict layer blocks.
   */
  rollbackOnBlock?: boolean;
  /**
   * For 'race' mode: timeout in ms before giving up on slow layers.
   * Default: 5000.
   */
  raceTimeoutMs?: number;
}
