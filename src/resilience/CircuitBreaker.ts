/**
 * Options for {@link CircuitBreaker}.
 *
 * @description Recovery uses **timestamp comparison** in {@link CircuitBreaker.canAttempt} — no `setInterval` / `setTimeout`.
 * @since 1.3.2
 */
export interface CircuitBreakerOptions {
  /** @description Consecutive failures required before opening (default `3`). */
  failureThreshold?: number;
  /** @description How long OPEN blocks attempts before {@link CircuitBreaker.canAttempt} may move to HALF_OPEN (default `5000`). */
  recoveryTimeMs?: number;
  /** @description Max concurrent probes allowed while HALF_OPEN (default `1`). */
  halfOpenMaxProbes?: number;
  /** @description Fires when the circuit opens (from CLOSED at threshold, or from HALF_OPEN on probe failure). */
  onOpen?: () => void;
  /** @description Fires when the circuit becomes CLOSED (from HALF_OPEN on probe success, or {@link CircuitBreaker.reset}). */
  onClose?: () => void;
  /** @description Fires when the circuit enters HALF_OPEN (recovery elapsed, first probe allowed). */
  onHalfOpen?: () => void;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const DEFAULTS = {
  failureThreshold: 3,
  recoveryTimeMs: 5000,
  halfOpenMaxProbes: 1,
} as const;

/**
 * Standalone three-state circuit breaker (CLOSED → OPEN → HALF_OPEN → CLOSED).
 *
 * @description Uses **Date.now()** comparisons for recovery — no background timers ({@link CircuitBreaker.destroy} has nothing to clear).
 * @since 1.3.2
 */
export class CircuitBreaker {
  private _state: CircuitState = 'CLOSED';

  private consecutiveFailures = 0;

  /** Wall-clock time when OPEN was entered (recovery window anchor). */
  private openedAtMs: number | null = null;

  /** Probes granted by {@link CircuitBreaker.canAttempt} while HALF_OPEN and not yet completed. */
  private halfOpenInFlight = 0;

  private readonly failureThreshold: number;

  private readonly recoveryTimeMs: number;

  private readonly halfOpenMaxProbes: number;

  private readonly onOpen?: () => void;

  private readonly onClose?: () => void;

  private readonly onHalfOpen?: () => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULTS.failureThreshold;
    this.recoveryTimeMs = options.recoveryTimeMs ?? DEFAULTS.recoveryTimeMs;
    this.halfOpenMaxProbes = options.halfOpenMaxProbes ?? DEFAULTS.halfOpenMaxProbes;
    this.onOpen = options.onOpen;
    this.onClose = options.onClose;
    this.onHalfOpen = options.onHalfOpen;
  }

  /** Current circuit state. */
  get state(): CircuitState {
    return this._state;
  }

  /**
   * @description Returns whether a caller may attempt the protected operation (e.g. call Redis).
   * - **CLOSED:** always `true`.
   * - **OPEN:** `false` until `recoveryTimeMs` has passed since open; then transitions to **HALF_OPEN**, fires {@link CircuitBreakerOptions.onHalfOpen}, and grants probes up to `halfOpenMaxProbes`.
   * - **HALF_OPEN:** `true` while in-flight probes are below the half-open cap.
   */
  canAttempt(): boolean {
    const now = Date.now();

    if (this._state === 'CLOSED') {
      return true;
    }

    if (this._state === 'OPEN') {
      if (this.openedAtMs === null) {
        return false;
      }
      if (now < this.openedAtMs + this.recoveryTimeMs) {
        return false;
      }
      this._state = 'HALF_OPEN';
      this.halfOpenInFlight = 0;
      this.onHalfOpen?.();
      return this.grantHalfOpenProbe();
    }

    if (this._state === 'HALF_OPEN') {
      return this.grantHalfOpenProbe();
    }

    return false;
  }

  private grantHalfOpenProbe(): boolean {
    if (this.halfOpenInFlight >= this.halfOpenMaxProbes) {
      return false;
    }
    this.halfOpenInFlight++;
    return true;
  }

  /**
   * @description Call when an attempt succeeds. Resets consecutive failure count; from **HALF_OPEN** closes the circuit and fires {@link CircuitBreakerOptions.onClose}.
   */
  recordSuccess(): void {
    if (this._state === 'CLOSED') {
      this.consecutiveFailures = 0;
      return;
    }

    if (this._state === 'HALF_OPEN') {
      this.halfOpenInFlight = 0;
      this.consecutiveFailures = 0;
      this.openedAtMs = null;
      this._state = 'CLOSED';
      this.onClose?.();
    }
  }

  /**
   * @description Call when an attempt fails. In **CLOSED**, increments consecutive failures and may open the circuit. In **HALF_OPEN**, re-opens and starts a new recovery window.
   */
  recordFailure(): void {
    if (this._state === 'CLOSED') {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this._state = 'OPEN';
        this.openedAtMs = Date.now();
        this.onOpen?.();
      }
      return;
    }

    if (this._state === 'HALF_OPEN') {
      this.halfOpenInFlight = 0;
      this._state = 'OPEN';
      this.openedAtMs = Date.now();
      this.consecutiveFailures = this.failureThreshold;
      this.onOpen?.();
      return;
    }
  }

  /**
   * @description Force **CLOSED** and clear all counters (does not fire callbacks).
   */
  reset(): void {
    this._state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
    this.halfOpenInFlight = 0;
  }

  /**
   * @description Clears internal state like {@link CircuitBreaker.reset}. No timers are used; safe to call when disposing.
   */
  destroy(): void {
    this.reset();
  }
}
