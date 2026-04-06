import { isComposedStoreBrand } from '../composition/composed-store-brand.js';
import type { ComposedIncrementResult } from '../composition/types.js';
import { MemoryStore } from '../stores/memory-store.js';
import {
  sanitizeIncrementCost,
  sanitizePenaltyDurationMs,
  sanitizeRateLimitCap,
  sanitizeWindowMs,
} from '../utils/clamp.js';
import type {
  LayerResult,
  RateLimitConsumeResult,
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
import { getLimit } from '../middleware/merge-options.js';
import type { MetricsCounters } from '../metrics/counters.js';
import { createMetricsCountersIfEnabled } from '../metrics/normalize.js';

/** Fallback reset horizon when block metadata omits expiry (Key Manager / policy / passthrough paths). */
const DEFAULT_BLOCK_RESET_FALLBACK_MS = 60_000;

export type { RateLimitConsumeResult };

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
 * @remarks
 * Without **trust proxy** configuration (Express) or **trustProxy** (Fastify), `req.ip` may not reflect the real client behind a load balancer; see {@link RateLimitOptionsBase.keyGenerator}.
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

/**
 * Resolves per-request {@link RateLimitIncrementOptions} from engine options (dynamic `maxRequests`, `incrementCost`).
 *
 * @description Used by {@link RateLimitEngine} and framework middleware for weighted increments and matching decrements.
 * @param opts - Merged `RateLimitOptions` (including `store`).
 * @param req - Request (or arbitrary value) passed to `incrementCost` / `maxRequests` when they are functions.
 * @returns `undefined` when neither `maxRequests` nor `incrementCost` applies; otherwise `{ maxRequests?, cost? }`.
 * Static numeric {@link WindowRateLimitOptions.maxRequests} is forwarded for **single-window** configs so it overrides the store’s configured cap per increment (e.g. injected store vs merged options). Skipped for multi-slot configs and for composed stores (per-layer caps), detected via {@link isComposedStoreBrand} (not `constructor.name`).
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

  const w = opts as WindowRateLimitOptions;
  const hasMultiWindow =
    (w.limits !== undefined && w.limits.length > 0) ||
    (w.groupedWindowStores !== undefined && w.groupedWindowStores.length > 0);
  const isComposed = isComposedStoreBrand(opts.store);

  const mr = opts.maxRequests;
  const maxPart =
    typeof mr === 'function'
      ? { maxRequests: sanitizeRateLimitCap(mr(req), 100) }
      : typeof mr === 'number' && !hasMultiWindow && !isComposed
        ? { maxRequests: sanitizeRateLimitCap(mr, 100) }
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

/** When {@link RateLimitEngine} penalty map is at least this size, sweep expired entries on every consume. */
const PENALTY_EXPIRED_SWEEP_ALWAYS_SIZE = 1024;
/** Below that size, sweep expired penalty entries every N consumes (amortized cleanup for dead keys). */
const PENALTY_EXPIRED_SWEEP_INTERVAL = 256;

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

  private penaltyExpiredSweepSeq = 0;

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
   * @description When {@link RateLimitOptionsBase.keyManager} is set, same reference as options (for `engine.keyManager.block(...)` etc.).
   * @since 2.2.0
   */
  get keyManager(): import('../key-manager/KeyManager.js').KeyManager | undefined {
    return this.options.keyManager;
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

    this.maybeSweepExpiredPenaltyEntries();

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

    const keyManager = this.options.keyManager;
    if (keyManager !== undefined && keyManager.isBlocked(key)) {
      const out = this.buildKeyManagerBlockResult(key, req);
      if (m) this.recordMetricsPolicyBlock(m, key, t0, 'key_manager');
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
    let bindingSlotIndex: number | undefined;
    const incOpts = resolveIncrementOpts(this.options, req);
    const decOpts = matchingDecrementOptions(incOpts);

    if (grouped && grouped.length > 0) {
      const g = await this.consumeGroupedWindows(key, grouped, draft, m, incOpts);
      result = g.result;
      blockedAtIndex = g.blockedAtIndex;
      bindingSlotIndex = g.bindingSlotIndex;
    } else {
      const ts = m ? performance.now() : 0;
      result = await this.options.store.increment(key, incOpts);
      if (m) m.recordStoreLatency(ts);
      bindingSlotIndex = this.bindingSlotIndexForComposedResult(result);
    }

    if (result.isBlocked && draft && !result.storeUnavailable) {
      await this.maybeOnLayerBlocks(req, result);
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
        const cs = this.options.store as RateLimitStore & {
          rollbackDraftForBlockedIncrement?: (
            key: string,
            res: Pick<ComposedIncrementResult, 'layers'>,
            dec?: RateLimitDecrementOptions,
          ) => Promise<void>;
        };
        if (typeof cs.rollbackDraftForBlockedIncrement === 'function') {
          await cs.rollbackDraftForBlockedIncrement(key, result as ComposedIncrementResult, decOpts);
        } else {
          await cs.decrement(key, decOpts).catch(() => {
            /* ignore */
          });
        }
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
        ...(result.layers !== undefined
          ? {
              layers: result.layers,
              ...(result.mode !== undefined ? { mode: result.mode } : {}),
              ...(result.decidingLayer !== undefined ? { decidingLayer: result.decidingLayer } : {}),
            }
          : {}),
        ...(bindingSlotIndex !== undefined ? { bindingSlotIndex } : {}),
      };
      if (m) this.recordMetricsAfterConsume(m, key, t0, draftOut);
      return draftOut;
    }

    if (result.isBlocked && !result.storeUnavailable) {
      this.recordViolation(key, req);
    }

    if (result.isBlocked && !result.storeUnavailable) {
      await this.maybeOnLayerBlocks(req, result);
      if (this.options.onLimitReached) {
        await Promise.resolve(this.options.onLimitReached(req, result));
      }
    }

    const consumeResult: RateLimitConsumeResult = {
      ...result,
      headers: {},
      blockReason: result.isBlocked
        ? result.storeUnavailable
          ? 'service_unavailable'
          : 'rate_limit'
        : undefined,
      ...(bindingSlotIndex !== undefined ? { bindingSlotIndex } : {}),
    };
    if (m) this.recordMetricsAfterConsume(m, key, t0, consumeResult);
    return consumeResult;
  }

  private async maybeOnLayerBlocks(req: unknown, result: RateLimitResult): Promise<void> {
    const cb = this.options.onLayerBlock;
    if (!cb || !result.layers) {
      return;
    }
    for (const [label, row] of Object.entries(result.layers)) {
      if (row.isBlocked && row.consulted && !row.error) {
        await Promise.resolve(cb(req, label, row as LayerResult));
      }
    }
  }

  /**
   * When {@link WindowRateLimitOptions.limits} drives a {@link ComposedStore} built via {@link compose.windows},
   * layer labels are `limit-0`, `limit-1`, … — map {@link RateLimitResult.decidingLayer} to a slot index for headers.
   */
  private bindingSlotIndexForComposedResult(result: RateLimitResult): number | undefined {
    if (!isWindowOpts(this.options)) {
      return undefined;
    }
    const limits = this.options.limits;
    if (!limits || limits.length === 0) {
      return undefined;
    }
    const deciding = result.decidingLayer;
    if (typeof deciding !== 'string') {
      return undefined;
    }
    const matched = /^limit-(\d+)$/.exec(deciding);
    if (!matched) {
      return undefined;
    }
    const idx = Number(matched[1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= limits.length) {
      return undefined;
    }
    return idx;
  }

  /**
   * Removes penalty entries whose window has ended. Without this, keys that never hit the app again
   * would never pass through {@link isPenaltyActive}, so {@link penaltyUntil} could grow without bound
   * under high-cardinality traffic.
   */
  private maybeSweepExpiredPenaltyEntries(): void {
    if (this.penaltyUntil.size === 0) {
      return;
    }
    const size = this.penaltyUntil.size;
    const seq = ++this.penaltyExpiredSweepSeq;
    const sweepEveryConsume = size >= PENALTY_EXPIRED_SWEEP_ALWAYS_SIZE;
    const sweepOnInterval = (seq & (PENALTY_EXPIRED_SWEEP_INTERVAL - 1)) === 0;
    if (!sweepEveryConsume && !sweepOnInterval) {
      return;
    }
    const now = Date.now();
    for (const [k, until] of this.penaltyUntil) {
      if (until <= now) {
        this.penaltyUntil.delete(k);
      }
    }
  }

  /**
   * Removes violation timestamp entries that have expired. Without this, keys that never hit the app again
   * after many violations would never pass through {@link recordViolation}, so {@link violationTimestamps}
   * could grow without bound under high-cardinality traffic.
   */
  private maybeSweepExpiredViolationEntries(): void {
    if (this.violationTimestamps.size === 0) {
      return;
    }
    const cfg = this.options.penaltyBox;
    if (!cfg) {
      return;
    }
    const windowMs = sanitizeWindowMs(cfg.violationWindowMs ?? 3_600_000, 3_600_000);
    const now = Date.now();
    for (const [k, timestamps] of this.violationTimestamps) {
      const trimmed = timestamps.filter((t) => t > now - windowMs);
      if (trimmed.length === 0) {
        this.violationTimestamps.delete(k);
      } else if (trimmed.length < timestamps.length) {
        this.violationTimestamps.set(k, trimmed);
      }
    }
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
    } else if (this.violationTimestamps.size > 10_000) {
      this.maybeSweepExpiredViolationEntries();
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
    reason: 'blocklist' | 'penalty' | 'key_manager',
  ): void {
    m.totalRequests++;
    m.blockedRequests++;
    if (reason === 'blocklist') {
      m.blockedByBlocklist++;
    } else if (reason === 'key_manager') {
      m.blockedByKeyManager++;
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
      } else if (br === 'key_manager') {
        m.blockedByKeyManager++;
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
  ): Promise<{ result: RateLimitResult; blockedAtIndex?: number; bindingSlotIndex?: number }> {
    const decOpts = matchingDecrementOptions(incOpts);
    const done: RateLimitResult[] = [];
    try {
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
          return {
            result: this.mergeGroupedResults(done),
            blockedAtIndex: i,
            bindingSlotIndex: this.computeBindingSlotIndex(done),
          };
        }
      }
    } catch (err) {
      for (let j = 0; j < done.length; j++) {
        const prev = grouped[j]!;
        await prev.store.decrement(key, decOpts).catch(() => {
          /* ignore */
        });
      }
      throw err;
    }
    return {
      result: this.mergeGroupedResults(done),
      bindingSlotIndex: this.computeBindingSlotIndex(done),
    };
  }

  /**
   * Which {@link WindowRateLimitOptions.groupedWindowStores} slot is the binding constraint for this consume:
   * a blocking slot (if several, the one with the latest {@link RateLimitResult.resetTime}), else the slot with the lowest remaining quota.
   *
   * @remarks
   * When not blocked, “lowest remaining” is **absolute** remaining count, not remaining as a fraction of each slot’s limit. That matches common setups (e.g. tight minute + loose hour); pathological mixes where a larger limit has fewer absolute tokens left could pick a different “most constrained” slot under a percentage-based rule.
   */
  private computeBindingSlotIndex(done: RateLimitResult[]): number | undefined {
    if (done.length === 0) {
      return undefined;
    }
    const blocked: number[] = [];
    for (let i = 0; i < done.length; i++) {
      if (done[i]!.isBlocked) {
        blocked.push(i);
      }
    }
    if (blocked.length > 0) {
      let best = blocked[0]!;
      let bestT = done[best]!.resetTime.getTime();
      for (let k = 1; k < blocked.length; k++) {
        const idx = blocked[k]!;
        const t = done[idx]!.resetTime.getTime();
        if (t > bestT || (t === bestT && idx < best)) {
          best = idx;
          bestT = t;
        }
      }
      return best;
    }
    let minRem = done[0]!.remaining;
    let minIdx = 0;
    for (let i = 1; i < done.length; i++) {
      const rem = done[i]!.remaining;
      if (rem < minRem || (rem === minRem && i < minIdx)) {
        minRem = rem;
        minIdx = i;
      }
    }
    return minIdx;
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
    let minRemaining = Number.POSITIVE_INFINITY;
    let maxResetTime = 0;
    let maxTotalHits = 0;
    for (const r of results) {
      if (r.remaining < minRemaining) {
        minRemaining = r.remaining;
      }
      const rt = r.resetTime.getTime();
      if (rt > maxResetTime) {
        maxResetTime = rt;
      }
      if (r.totalHits > maxTotalHits) {
        maxTotalHits = r.totalHits;
      }
    }
    return {
      totalHits: maxTotalHits,
      remaining: minRemaining,
      resetTime: new Date(maxResetTime),
      isBlocked: false,
    };
  }

  private buildKeyManagerBlockResult(key: string, req: unknown): RateLimitConsumeResult {
    const info = this.options.keyManager?.getBlockInfo(key);
    const limit = this.getLimit(req);
    const resetTime =
      info?.expiresAt !== undefined && info.expiresAt !== null
        ? info.expiresAt
        : new Date(Date.now() + DEFAULT_BLOCK_RESET_FALLBACK_MS);
    const base: RateLimitResult = {
      totalHits: limit,
      remaining: 0,
      resetTime,
      isBlocked: true,
    };
    return {
      ...base,
      headers: {},
      blockReason: 'key_manager',
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
      resetTime =
        until !== undefined ? new Date(until) : new Date(Date.now() + DEFAULT_BLOCK_RESET_FALLBACK_MS);
    } else {
      resetTime = new Date(Date.now() + DEFAULT_BLOCK_RESET_FALLBACK_MS);
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
    return getLimit(this.options, req);
  }

  private buildPassthroughResult(req: unknown): RateLimitConsumeResult {
    const limit = this.getLimit(req);
    const resetTime = new Date(Date.now() + DEFAULT_BLOCK_RESET_FALLBACK_MS);
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
