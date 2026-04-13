/**
 * Thrown when {@link RateLimiterQueue} has been shut down or is shutting down.
 *
 * @since 4.0.0
 */
export class ShutdownError extends Error {
  public readonly code = 'E_RATELIMIT_SHUTDOWN' as const;

  constructor(reason: string) {
    super(`RateLimiterQueue rejected: ${reason}`);
    this.name = 'ShutdownError';
  }
}
