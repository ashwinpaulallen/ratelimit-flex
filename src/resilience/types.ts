import type { MemoryStore } from '../stores/memory-store.js';
import type { CircuitBreakerOptions } from './CircuitBreaker.js';

/**
 * Optional callbacks for Redis resilience / insurance limiter observability.
 *
 * @since 1.3.2
 */
export interface ResilienceHooks {
  /**
   * @description Fires once when the circuit first opens from **CLOSED** (Redis failures crossed the threshold). Not called again when a **HALF_OPEN** probe fails and re-opens the circuit — callers already know failover is active.
   */
  onFailover?: (error: Error) => void;

  /** @description Redis recovered; circuit closed. `downtimeMs` is how long Redis was unavailable. */
  onRecovery?: (downtimeMs: number) => void;

  /** @description Circuit breaker opened. */
  onCircuitOpen?: () => void;

  /** @description Circuit breaker closed. */
  onCircuitClose?: () => void;

  /** @description A request was served from the insurance fallback instead of Redis. */
  onInsuranceHit?: (key: string) => void;

  /** @description Post-recovery sync of in-memory counters back to Redis finished. */
  onCounterSync?: (keysSynced: number, errors: number) => void;
}

/**
 * Configuration for the insurance (in-memory) limiter used when Redis is unavailable.
 *
 * @since 1.3.2
 */
export interface InsuranceLimiterOptions {
  /** @description In-memory store used as the fallback quota while Redis is down. */
  store: MemoryStore;

  /** @description When `true`, sync {@link MemoryStore.getActiveKeys} back to Redis after recovery (default `true`). */
  syncOnRecovery?: boolean;
}

/**
 * Optional resilience layer around Redis-backed rate limiting (insurance + circuit breaker + hooks).
 *
 * @since 1.3.2
 */
export interface RedisResilienceOptions {
  /** @description In-memory fallback when Redis fails. */
  insuranceLimiter?: InsuranceLimiterOptions;

  /** @description Circuit breaker around Redis calls (defaults: `failureThreshold` 3, `recoveryTimeMs` 5000). */
  circuitBreaker?: Partial<CircuitBreakerOptions>;

  /** @description Observability hooks. */
  hooks?: ResilienceHooks;
}
