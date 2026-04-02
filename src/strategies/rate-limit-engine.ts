import { MemoryStore } from '../stores/memory-store.js';
import {
  sanitizeIncrementCost,
  sanitizePenaltyDurationMs,
  sanitizeRateLimitCap,
  sanitizeWindowMs,
} from '../utils/clamp.js';
import type {
  RateLimitDecrementOptions,
  RateLimitIncrementOptions,
  RateLimitOptions,
  RateLimitResult,
  RateLimitStore,
  TokenBucketRateLimitOptions,
  WindowRateLimitOptions,
} from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import { validateRateLimitHeaderOptions } from '../middleware/validate-header-options.js';
import type { MetricsCounters } from '../metrics/counters.js';
import { createMetricsCountersIfEnabled } from '../metrics/normalize.js';

/**
 * Result of {@link RateLimitEngine.consume} / {@link RateLimitEngine.consumeWithKey}.
 *
 * @description Extends {@link RateLimitResult} with block metadata; **`headers`** is always **`{}`** (middleware sets HTTP headers via **`formatRateLimitHeaders`**).
 * @see {@link RateLimitEngine}
 * @since 1.0.0
 */
export interface RateLimitConsumeResult extends RateLimitResult {
  /**
   * @description Always **`{}`**. `expressRateLimiter` / `fastifyRateLimiter` set response headers via **`formatRateLimitHeaders`**; the engine does not allocate header maps on consume.
   */
  headers: Record<string, string>;
  /**
   * @description When {@link WindowRateLimitOptions.draft} is true and the request would have been blocked.
   * @default undefined
   */
  draftWouldBlock?: boolean;
  /**
   * @description Why the request was blocked when {@link RateLimitResult.isBlocked} is true.
   * @default undefined when allowed
   */
  blockReason?: 'rate_limit' | 'blocklist' | 'penalty' | 'service_unavailable';
}

/**
 * Input for {@link createRateLimiter} (engine factory): `store` is optional.
 *
 * @description If `store` is omitted, a {@link MemoryStore} is synthesized from strategy fields.
 * @see {@link RateLimitEngine}
 * @since 1.0.0
 */
export type RateLimiterConfigInput =
  | (Omit<WindowRateLimitOptions, 'store'> & { store?: RateLimitStore })
  | (Omit<TokenBucketRateLimitOptions, 'store'> & { store?: RateLimitStore });

/**
 * Default HTTP key extractor: `req.ip`, then `socket.remoteAddress`, else `"unknown"`.
 *
 * @description If `req` is a string, returns it unchanged (precomputed key).
 * @param req - Framework request or string key.
 * @returns Stable string key for {@link RateLimitStore}.
 * @example
 * ```ts
 * defaultKeyGenerator({ ip: '198.51.100.1' }); // '198.51.100.1'
 * ```
 * @see {@link RateLimitOptionsBase.keyGenerator}
 * @since 1.0.0
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
    return sanitizeRateLimitCap(mr(req), 100);
  }
  return sanitizeRateLimitCap(mr, 100);
}

/**
 * Resolves per-request {@link RateLimitIncrementOptions} from engine options (dynamic `maxRequests`, `incrementCost`).
 *
 * @description Used by {@link RateLimitEngine} and framework middleware for weighted increments and matching decrements.
 * @param opts - Merged `RateLimitOptions` (including `store`).
 * @param req - Request (or arbitrary value) passed to `incrementCost` / `maxRequests` when they are functions.
 * @returns `undefined` when neither a dynamic `maxRequests` nor `incrementCost` applies; otherwise `{ maxRequests?, cost? }`.
 * @since 1.3.1
 */
export function resolveIncrementOpts(
  opts: RateLimitOptions,
  req: unknown,
): RateLimitIncrementOptions | undefined {
  const costRaw = opts.incrementCost;
  let costPart: { cost: number } | undefined;
  if (costRaw !== undefined) {
    const v = typeof costRaw === 'function' ? costRaw(req) : costRaw;
    costPart = { cost: sanitizeIncrementCost(v, 1) };
  }

  if (!isWindowOpts(opts)) {
    return costPart ? { ...costPart } : undefined;
  }

  const mr = opts.maxRequests;
  const maxPart =
    typeof mr === 'function'
      ? { maxRequests: sanitizeRateLimitCap(mr(req), 100) }
      : undefined;

  if (!maxPart && !costPart) {
    return undefined;
  }
  return { ...maxPart, ...costPart };
}

/**
 * Builds {@link RateLimitDecrementOptions} that undo a prior {@link RateLimitStore.increment} for the same request.
 *
 * @description Pass the object returned by {@link resolveIncrementOpts} (or the same shape) so **`cost`** matches the increment being rolled back.
 * @param inc - Result of {@link resolveIncrementOpts}, or `undefined` (treated as cost `1`).
 * @returns {@link RateLimitDecrementOptions} with sanitized **`cost`**.
 * @since 1.3.1
 */
export function matchingDecrementOptions(inc?: RateLimitIncrementOptions): RateLimitDecrementOptions {
  return { cost: sanitizeIncrementCost(inc?.cost, 1) };
}

/**
 * Builds a {@link RateLimitEngine} with an optional synthesized {@link MemoryStore} when `store` is omitted.
 *
 * @description Re-exported from the package entry as `createRateLimitEngine`.
 * @param options - Window or token-bucket config; `store` optional.
 * @returns A configured {@link RateLimitEngine}.
 * @example
 * ```ts
 * const engine = createRateLimiter({ maxRequests: 50, windowMs: 60_000 });
 * const result = await engine.consume(req);
 * ```
 * @see {@link RateLimitEngine}
 * @since 1.0.0
 */
export function createRateLimiter(options: RateLimiterConfigInput): RateLimitEngine {
  validateRateLimitHeaderOptions(options as Partial<RateLimitOptions>);
  const resolved = resolveOptions(options);
  const counters = createMetricsCountersIfEnabled(resolved.metrics);
  return new RateLimitEngine(resolved, counters);
}

/**
 * Core rate limiting orchestrator (policy + store + headers).
 *
 * @description Used by Express/Fastify middleware and for non-HTTP pipelines. Applies allow/block lists, penalty box, draft mode, then {@link RateLimitStore.increment}. Honors {@link RateLimitOptionsBase.incrementCost} and dynamic **`maxRequests`** via {@link resolveIncrementOpts}.
 * @see {@link MemoryStore}
 * @see {@link RedisStore}
 * @since 1.0.0
 */
export class RateLimitEngine {
  private readonly options: RateLimitOptions;

  private readonly metrics: MetricsCounters | undefined;

  private readonly allowSet: ReadonlySet<string> | null;

  private readonly blockSet: ReadonlySet<string> | null;

  private readonly penaltyUntil = new Map<string, number>();

  private readonly violationTimestamps = new Map<string, number[]>();

  /**
   * @description Builds lookup sets for allow/block lists; does not connect to Redis.
   * @param options - Fully resolved {@link RateLimitOptions} (including `store`).
   * @example
   * ```ts
   * const engine = new RateLimitEngine({
   *   strategy: RateLimitStrategy.SLIDING_WINDOW,
   *   windowMs: 60_000,
   *   maxRequests: 100,
   *   store: myStore,
   * });
   * ```
   * @param metrics - Optional {@link MetricsCounters}; when omitted, no per-request metrics overhead.
   * @since 1.0.0
   */
  constructor(options: RateLimitOptions, metrics?: MetricsCounters | null) {
    this.options = options;
    this.metrics = metrics ?? undefined;
    const allow = options.allowlist;
    const block = options.blocklist;
    this.allowSet = allow && allow.length > 0 ? new Set(allow) : null;
    this.blockSet = block && block.length > 0 ? new Set(block) : null;
  }

  /**
   * Applies rate limiting for an incoming request-like value.
   *
   * @description Uses {@link RateLimitOptionsBase.keyGenerator} or {@link defaultKeyGenerator} to derive the storage key.
   * @param req - Framework request or arbitrary value passed to `keyGenerator`.
   * @returns {@link RateLimitConsumeResult} with **`headers: {}`** and block metadata (HTTP headers are set by middleware via **`formatRateLimitHeaders`**).
   * @since 1.0.0
   */
  async consume(req: unknown): Promise<RateLimitConsumeResult> {
    const key = (this.options.keyGenerator ?? defaultKeyGenerator)(req);
    return this.consumeWithKey(key, req);
  }

  /**
   * Rate limit using a precomputed storage key (skips `keyGenerator`).
   *
   * @description Use when the key is computed upstream (e.g. API gateway). Pass the same `req` for callbacks.
   * @param key - Storage key string.
   * @param req - Original request for `onLimitReached`, `skip`, penalty, draft hooks (defaults to `key`).
   * @returns {@link RateLimitConsumeResult}.
   * @since 1.0.0
   */
  async consumeWithKey(key: string, req: unknown = key): Promise<RateLimitConsumeResult> {
    const m = this.metrics;
    const t0 = m ? performance.now() : 0;

    if (this.options.skip?.(req) === true) {
      const out = this.buildPassthroughResult(req);
      if (m) this.recordMetricsSkip(m, key, t0);
      return out;
    }

    if (this.allowSet?.has(key)) {
      const out = this.buildPassthroughResult(req);
      if (m) this.recordMetricsAllowlist(m, key, t0);
      return out;
    }

    if (this.blockSet?.has(key)) {
      const out = this.buildPolicyBlockResult(req, 'blocklist');
      if (m) this.recordMetricsPolicyBlock(m, key, t0, 'blocklist');
      return out;
    }

    const penaltyActive = this.isPenaltyActive(key);
    if (penaltyActive) {
      const out = this.buildPolicyBlockResult(req, 'penalty', key);
      if (m) this.recordMetricsPolicyBlock(m, key, t0, 'penalty');
      return out;
    }

    const grouped = isWindowOpts(this.options) ? this.options.groupedWindowStores : undefined;
    const draft = this.options.draft === true;
    let result: RateLimitResult;
    let blockedAtIndex: number | undefined;
    const incOpts = resolveIncrementOpts(this.options, req);
    const decOpts = matchingDecrementOptions(incOpts);

    if (grouped && grouped.length > 0) {
      const g = await this.consumeGroupedWindows(key, grouped, draft, m, incOpts);
      result = g.result;
      blockedAtIndex = g.blockedAtIndex;
    } else {
      const ts = m ? performance.now() : 0;
      result = await this.options.store.increment(key, incOpts);
      if (m) m.recordStoreLatency(ts);
    }

    if (result.isBlocked && draft && !result.storeUnavailable) {
      if (grouped && grouped.length > 0 && blockedAtIndex !== undefined) {
        for (let k = 0; k <= blockedAtIndex; k++) {
          const slot = grouped[k];
          if (slot !== undefined) {
            await slot.store.decrement(key, decOpts).catch(() => {
              /* ignore */
            });
          }
        }
      } else if (!grouped || grouped.length === 0) {
        await this.options.store.decrement(key, decOpts).catch(() => {
          /* ignore */
        });
      }
      if (this.options.onDraftViolation) {
        await Promise.resolve(this.options.onDraftViolation(req, result));
      }
      const draftOut: RateLimitConsumeResult = {
        totalHits: result.totalHits,
        remaining: result.remaining,
        resetTime: result.resetTime,
        isBlocked: false,
        headers: {},
        draftWouldBlock: true,
      };
      if (m) this.recordMetricsAfterConsume(m, key, t0, draftOut);
      return draftOut;
    }

    if (result.isBlocked && !result.storeUnavailable) {
      this.recordViolation(key, req);
    }

    if (result.isBlocked && !result.storeUnavailable && this.options.onLimitReached) {
      await Promise.resolve(this.options.onLimitReached(req, result));
    }

    const consumeResult: RateLimitConsumeResult = {
      ...result,
      headers: {},
      blockReason: result.isBlocked
        ? result.storeUnavailable
          ? 'service_unavailable'
          : 'rate_limit'
        : undefined,
    };
    if (m) this.recordMetricsAfterConsume(m, key, t0, consumeResult);
    return consumeResult;
  }

  private isPenaltyActive(key: string): boolean {
    const until = this.penaltyUntil.get(key);
    if (until === undefined) {
      return false;
    }
    const now = Date.now();
    if (now >= until) {
      this.penaltyUntil.delete(key);
      return false;
    }
    return true;
  }

  private recordViolation(key: string, req: unknown): void {
    const cfg = this.options.penaltyBox;
    if (!cfg) {
      return;
    }
    const windowMs = sanitizeWindowMs(cfg.violationWindowMs ?? 3_600_000, 3_600_000);
    const threshold = sanitizeRateLimitCap(cfg.violationsThreshold, 1);
    const now = Date.now();
    const prev = this.violationTimestamps.get(key) ?? [];
    const trimmed = prev.filter((t) => t > now - windowMs);
    trimmed.push(now);
    this.violationTimestamps.set(key, trimmed);

    if (trimmed.length >= threshold) {
      const duration = sanitizePenaltyDurationMs(cfg.penaltyDurationMs, 60_000);
      this.penaltyUntil.set(key, now + duration);
      this.violationTimestamps.delete(key);
      if (cfg.onPenalty) {
        void Promise.resolve(cfg.onPenalty(req)).catch(() => {
          /* ignore */
        });
      }
    }
  }

  /** Only called when {@link RateLimitEngine.metrics} is set — avoids redundant `this.metrics` reads. */
  private recordMetricsSkip(m: MetricsCounters, key: string, tStart: number): void {
    m.totalRequests++;
    m.skippedRequests++;
    m.recordLatency(tStart);
    m.recordKey(key);
  }

  private recordMetricsAllowlist(m: MetricsCounters, key: string, tStart: number): void {
    m.totalRequests++;
    m.allowlistedRequests++;
    m.recordLatency(tStart);
    m.recordKey(key);
  }

  private recordMetricsPolicyBlock(
    m: MetricsCounters,
    key: string,
    tStart: number,
    reason: 'blocklist' | 'penalty',
  ): void {
    m.totalRequests++;
    m.blockedRequests++;
    if (reason === 'blocklist') {
      m.blockedByBlocklist++;
    } else {
      m.blockedByPenalty++;
    }
    m.recordLatency(tStart);
    m.recordKey(key);
    m.recordKeyBlocked(key);
  }

  private recordMetricsAfterConsume(
    m: MetricsCounters,
    key: string,
    tStart: number,
    out: RateLimitConsumeResult,
  ): void {
    m.totalRequests++;
    m.recordLatency(tStart);
    m.recordKey(key);
    if (out.isBlocked) {
      m.blockedRequests++;
      m.recordKeyBlocked(key);
      const br = out.blockReason;
      if (br === 'rate_limit') {
        m.blockedByRateLimit++;
      } else if (br === 'blocklist') {
        m.blockedByBlocklist++;
      } else if (br === 'penalty') {
        m.blockedByPenalty++;
      } else if (br === 'service_unavailable') {
        m.blockedByServiceUnavailable++;
      } else if (out.storeUnavailable) {
        m.blockedByServiceUnavailable++;
      }
    } else {
      m.allowedRequests++;
    }
  }

  /**
   * @param draft - When true and the blocking increment is not `storeUnavailable`, rollback of
   *   prior windows is deferred to {@link RateLimitEngine.consumeWithKey} so draft mode can roll
   *   back **all** windows `0..blockedAtIndex` in one place (avoids leaving earlier windows incremented).
   */
  private async consumeGroupedWindows(
    key: string,
    grouped: NonNullable<WindowRateLimitOptions['groupedWindowStores']>,
    draft: boolean,
    metrics: MetricsCounters | undefined,
    incOpts: RateLimitIncrementOptions | undefined,
  ): Promise<{ result: RateLimitResult; blockedAtIndex?: number }> {
    const decOpts = matchingDecrementOptions(incOpts);
    const done: RateLimitResult[] = [];
    for (let i = 0; i < grouped.length; i++) {
      const g = grouped[i]!;
      const ts = metrics ? performance.now() : 0;
      const r = await g.store.increment(key, {
        maxRequests: g.maxRequests,
        ...(incOpts?.cost !== undefined ? { cost: incOpts.cost } : {}),
      });
      if (metrics) metrics.recordStoreLatency(ts);
      done.push(r);
      if (r.isBlocked) {
        const deferRollbackToDraft = draft && !r.storeUnavailable;
        if (!deferRollbackToDraft) {
          for (let j = 0; j < i; j++) {
            const prev = grouped[j]!;
            await prev.store.decrement(key, decOpts).catch(() => {
              /* ignore */
            });
          }
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
    const unavailable = results.find((r) => r.storeUnavailable);
    if (unavailable) {
      return { ...unavailable };
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
      headers: {},
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
      headers: {},
    };
  }
}
