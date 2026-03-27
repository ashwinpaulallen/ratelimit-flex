import { MemoryStore } from '../stores/memory-store.js';
import type {
  RateLimitOptions,
  RateLimitResult,
  RateLimitStore,
  TokenBucketRateLimitOptions,
  WindowRateLimitOptions,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';

/** Result of {@link RateLimitEngine.consume} including standard rate-limit headers. */
export interface RateLimitConsumeResult extends RateLimitResult {
  headers: Record<string, string>;
}

/** Options for {@link createRateLimiter}: `store` is optional — a {@link MemoryStore} is created when omitted. */
export type RateLimiterConfigInput =
  | (Omit<WindowRateLimitOptions, 'store'> & { store?: RateLimitStore })
  | (Omit<TokenBucketRateLimitOptions, 'store'> & { store?: RateLimitStore });

/**
 * Default key extractor: uses `req.ip`, then `socket.remoteAddress`, else `"unknown"`.
 * Strings are returned as-is so you can pass a precomputed key.
 */
export function defaultKeyGenerator(req: unknown): string {
  if (typeof req === 'string') {
    return req;
  }
  if (req !== null && typeof req === 'object') {
    const r = req as Record<string, unknown>;
    if (typeof r.ip === 'string' && r.ip.length > 0) {
      return r.ip;
    }
    const socket = r.socket;
    if (socket !== null && typeof socket === 'object' && 'remoteAddress' in socket) {
      const addr = (socket as { remoteAddress?: string }).remoteAddress;
      if (typeof addr === 'string' && addr.length > 0) {
        return addr;
      }
    }
  }
  return 'unknown';
}

function createDefaultMemoryStore(options: RateLimiterConfigInput): MemoryStore {
  if (options.strategy === RateLimitStrategy.TOKEN_BUCKET) {
    return new MemoryStore({
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: options.tokensPerInterval,
      interval: options.interval,
      bucketSize: options.bucketSize,
    });
  }
  return new MemoryStore({
    strategy: options.strategy ?? RateLimitStrategy.SLIDING_WINDOW,
    windowMs: options.windowMs ?? 60_000,
    maxRequests: options.maxRequests ?? 100,
  });
}

function resolveOptions(input: RateLimiterConfigInput): RateLimitOptions {
  const store = input.store ?? createDefaultMemoryStore(input);
  return { ...input, store } as RateLimitOptions;
}

/**
 * Build a {@link RateLimitEngine} with optional in-memory store when `store` is omitted.
 */
export function createRateLimiter(options: RateLimiterConfigInput): RateLimitEngine {
  return new RateLimitEngine(resolveOptions(options));
}

/**
 * Orchestrates key extraction, store increments, header generation, and limit callbacks.
 */
export class RateLimitEngine {
  private readonly options: RateLimitOptions;

  constructor(options: RateLimitOptions) {
    this.options = options;
  }

  /**
   * Applies rate limiting for an incoming request-like value.
   * Uses {@link RateLimitOptionsBase.keyGenerator} (or {@link defaultKeyGenerator}) to derive the storage key.
   */
  async consume(req: unknown): Promise<RateLimitConsumeResult> {
    const key = (this.options.keyGenerator ?? defaultKeyGenerator)(req);
    return this.consumeWithKey(key, req);
  }

  /**
   * Rate limit using a precomputed storage key (skips `keyGenerator`).
   * Pass the same `req` for `onLimitReached` / `skip` callbacks when applicable.
   */
  async consumeWithKey(key: string, req: unknown = key): Promise<RateLimitConsumeResult> {
    if (this.options.skip?.(req) === true) {
      return this.buildPassthroughResult();
    }

    const result = await this.options.store.increment(key);
    const headers = this.buildHeaders(result);

    if (result.isBlocked && this.options.onLimitReached) {
      await Promise.resolve(this.options.onLimitReached(req, result));
    }

    return { ...result, headers };
  }

  private getLimit(): number {
    if (this.options.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      return this.options.bucketSize;
    }
    return this.options.maxRequests ?? 100;
  }

  private buildPassthroughResult(): RateLimitConsumeResult {
    const limit = this.getLimit();
    const resetTime = new Date(Date.now() + 60_000);
    const base: RateLimitResult = {
      totalHits: 0,
      remaining: limit,
      resetTime,
      isBlocked: false,
    };
    return {
      ...base,
      headers: this.composeHeaders(base),
    };
  }

  private buildHeaders(result: RateLimitResult): Record<string, string> {
    return this.composeHeaders(result);
  }

  private composeHeaders(result: RateLimitResult): Record<string, string> {
    if (this.options.headers === false) {
      return {};
    }

    const limit = this.getLimit();
    const resetSec = Math.ceil(result.resetTime.getTime() / 1000);
    const headers: Record<string, string> = {
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(Math.max(0, result.remaining)),
      'X-RateLimit-Reset': String(resetSec),
    };

    if (result.isBlocked) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((result.resetTime.getTime() - Date.now()) / 1000),
      );
      headers['Retry-After'] = String(retryAfterSec);
    }

    return headers;
  }
}
