import { MemoryStore } from '../stores/memory-store.js';
import type {
  RateLimitIncrementOptions,
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
  /** When {@link WindowRateLimitOptions.draft} is true and the request would have been blocked. */
  draftWouldBlock?: boolean;
  /** Why the request was blocked (when {@link RateLimitResult.isBlocked}). */
  blockReason?: 'rate_limit' | 'blocklist' | 'penalty';
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
    maxRequests: typeof options.maxRequests === 'number' ? options.maxRequests : 100,
  });
}

function resolveOptions(input: RateLimiterConfigInput): RateLimitOptions {
  const store = input.store ?? createDefaultMemoryStore(input);
  return { ...input, store } as RateLimitOptions;
}

function isWindowOpts(o: RateLimitOptions): o is WindowRateLimitOptions {
  return o.strategy !== RateLimitStrategy.TOKEN_BUCKET;
}

function resolveWindowMaxRequests(opts: WindowRateLimitOptions, req: unknown): number {
  const mr = opts.maxRequests ?? 100;
  if (typeof mr === 'function') {
    return mr(req);
  }
  return mr;
}

function resolveIncrementOpts(
  opts: RateLimitOptions,
  req: unknown,
): RateLimitIncrementOptions | undefined {
  if (!isWindowOpts(opts)) {
    return undefined;
  }
  const mr = opts.maxRequests;
  if (typeof mr === 'function') {
    return { maxRequests: mr(req) };
  }
  return undefined;
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

  private readonly penaltyUntil = new Map<string, number>();

  private readonly violationTimestamps = new Map<string, number[]>();

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
      return this.buildPassthroughResult(req);
    }

    const allow = this.options.allowlist;
    if (allow && allow.includes(key)) {
      return this.buildPassthroughResult(req);
    }

    const block = this.options.blocklist;
    if (block && block.includes(key)) {
      return this.buildPolicyBlockResult(req, 'blocklist');
    }

    const penaltyActive = this.isPenaltyActive(key);
    if (penaltyActive) {
      return this.buildPolicyBlockResult(req, 'penalty', key);
    }

    const grouped = isWindowOpts(this.options) ? this.options.groupedWindowStores : undefined;
    let result: RateLimitResult;
    let blockedAtIndex: number | undefined;
    const incOpts = resolveIncrementOpts(this.options, req);

    if (grouped && grouped.length > 0) {
      const g = await this.consumeGroupedWindows(key, grouped);
      result = g.result;
      blockedAtIndex = g.blockedAtIndex;
    } else {
      result = await this.options.store.increment(key, incOpts);
    }

    const draft = this.options.draft === true;

    if (result.isBlocked && draft) {
      if (grouped && grouped.length > 0 && blockedAtIndex !== undefined) {
        const slot = grouped[blockedAtIndex];
        if (slot !== undefined) {
          await slot.store.decrement(key).catch(() => {
            /* ignore */
          });
        }
      } else if (!grouped || grouped.length === 0) {
        await this.options.store.decrement(key).catch(() => {
          /* ignore */
        });
      }
      if (this.options.onDraftViolation) {
        await Promise.resolve(this.options.onDraftViolation(req, result));
      }
      const limit = this.getLimit(req);
      const headers = this.composeHeaders(
        {
          totalHits: result.totalHits,
          remaining: result.remaining,
          resetTime: result.resetTime,
          isBlocked: false,
        },
        limit,
      );
      return {
        totalHits: result.totalHits,
        remaining: result.remaining,
        resetTime: result.resetTime,
        isBlocked: false,
        headers,
        draftWouldBlock: true,
      };
    }

    if (result.isBlocked) {
      this.recordViolation(key, req);
    }

    const limit = this.getLimit(req);
    const headers = this.composeHeaders(result, limit);

    if (result.isBlocked && this.options.onLimitReached) {
      await Promise.resolve(this.options.onLimitReached(req, result));
    }

    return {
      ...result,
      headers,
      blockReason: result.isBlocked ? 'rate_limit' : undefined,
    };
  }

  private isPenaltyActive(key: string): boolean {
    const until = this.penaltyUntil.get(key);
    return until !== undefined && Date.now() < until;
  }

  private recordViolation(key: string, req: unknown): void {
    const cfg = this.options.penaltyBox;
    if (!cfg) {
      return;
    }
    const windowMs = cfg.violationWindowMs ?? 3_600_000;
    const now = Date.now();
    const prev = this.violationTimestamps.get(key) ?? [];
    const trimmed = prev.filter((t) => t > now - windowMs);
    trimmed.push(now);
    this.violationTimestamps.set(key, trimmed);

    if (trimmed.length >= cfg.violationsThreshold) {
      this.penaltyUntil.set(key, now + cfg.penaltyDurationMs);
      this.violationTimestamps.delete(key);
      if (cfg.onPenalty) {
        void Promise.resolve(cfg.onPenalty(req));
      }
    }
  }

  private async consumeGroupedWindows(
    key: string,
    grouped: NonNullable<WindowRateLimitOptions['groupedWindowStores']>,
  ): Promise<{ result: RateLimitResult; blockedAtIndex?: number }> {
    const done: RateLimitResult[] = [];
    for (let i = 0; i < grouped.length; i++) {
      const g = grouped[i]!;
      const r = await g.store.increment(key, { maxRequests: g.maxRequests });
      done.push(r);
      if (r.isBlocked) {
        for (let j = 0; j < i; j++) {
          const prev = grouped[j]!;
          await prev.store.decrement(key).catch(() => {
            /* ignore */
          });
        }
        return { result: this.mergeGroupedResults(done), blockedAtIndex: i };
      }
    }
    return { result: this.mergeGroupedResults(done) };
  }

  private mergeGroupedResults(results: RateLimitResult[]): RateLimitResult {
    if (results.length === 0) {
      return {
        totalHits: 0,
        remaining: 0,
        resetTime: new Date(),
        isBlocked: false,
      };
    }
    const blockedIdx = results.findIndex((r) => r.isBlocked);
    if (blockedIdx >= 0) {
      const r = results[blockedIdx]!;
      return {
        totalHits: r.totalHits,
        remaining: 0,
        resetTime: r.resetTime,
        isBlocked: true,
      };
    }
    const remaining = Math.min(...results.map((r) => r.remaining));
    const resetTime = new Date(Math.max(...results.map((r) => r.resetTime.getTime())));
    const totalHits = Math.max(...results.map((r) => r.totalHits));
    return {
      totalHits,
      remaining,
      resetTime,
      isBlocked: false,
    };
  }

  private buildPolicyBlockResult(
    req: unknown,
    reason: 'blocklist' | 'penalty',
    penaltyKey?: string,
  ): RateLimitConsumeResult {
    const limit = this.getLimit(req);
    let resetTime: Date;
    if (reason === 'penalty' && penaltyKey !== undefined) {
      const until = this.penaltyUntil.get(penaltyKey);
      resetTime = until !== undefined ? new Date(until) : new Date(Date.now() + 60_000);
    } else {
      resetTime = new Date(Date.now() + 60_000);
    }
    const base: RateLimitResult = {
      totalHits: limit,
      remaining: 0,
      resetTime,
      isBlocked: true,
    };
    return {
      ...base,
      headers: this.composeHeaders(base, limit),
      blockReason: reason,
    };
  }

  private getLimit(req: unknown): number {
    if (this.options.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      return this.options.bucketSize;
    }
    const w = this.options as WindowRateLimitOptions;
    if (w.groupedWindowStores && w.groupedWindowStores.length > 0) {
      return Math.min(...w.groupedWindowStores.map((g) => g.maxRequests));
    }
    return resolveWindowMaxRequests(w, req);
  }

  private buildPassthroughResult(req: unknown): RateLimitConsumeResult {
    const limit = this.getLimit(req);
    const resetTime = new Date(Date.now() + 60_000);
    const base: RateLimitResult = {
      totalHits: 0,
      remaining: limit,
      resetTime,
      isBlocked: false,
    };
    return {
      ...base,
      headers: this.composeHeaders(base, limit),
    };
  }

  private composeHeaders(result: RateLimitResult, limit: number): Record<string, string> {
    if (this.options.headers === false) {
      return {};
    }

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
