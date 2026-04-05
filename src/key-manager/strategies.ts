/**
 * Penalty escalation strategies — functions that return block duration
 * based on how many times a key has been penalized.
 *
 * @since 2.2.0
 */
export type EscalationStrategy = (violationCount: number) => number;

/** Fixed duration every time */
export function fixedEscalation(durationMs: number): EscalationStrategy {
  return () => durationMs;
}

/** Linear: duration increases by step each violation */
export function linearEscalation(baseDurationMs: number, stepMs: number): EscalationStrategy {
  return (n) => baseDurationMs + (n - 1) * stepMs;
}

/** Exponential: duration doubles each violation when factor is 2 */
export function exponentialEscalation(baseDurationMs: number, factor = 2): EscalationStrategy {
  return (n) => baseDurationMs * Math.pow(factor, n - 1);
}

/** Fibonacci: duration follows Fibonacci sequence (1, 1, 2, 3, 5, 8, …) × base */
export function fibonacciEscalation(baseDurationMs: number): EscalationStrategy {
  return (n) => {
    let a = 1;
    let b = 1;
    for (let i = 2; i < n; i++) {
      [a, b] = [b, a + b];
    }
    return baseDurationMs * (n <= 1 ? 1 : b);
  };
}

/** Capped: wraps any strategy with a maximum duration */
export function capped(strategy: EscalationStrategy, maxDurationMs: number): EscalationStrategy {
  return (n) => Math.min(strategy(n), maxDurationMs);
}
