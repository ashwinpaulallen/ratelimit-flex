import { matchingDecrementOptions } from '../strategies/rate-limit-engine.js';
import { MemoryStore } from '../stores/memory-store.js';
import { COMPOSED_STORE_BRAND, registerComposedStoreConstructor } from './composed-store-brand.js';
import type {
  RateLimitActiveKeyEntry,
  RateLimitDecrementOptions,
  RateLimitIncrementOptions,
  RateLimitResult,
  RateLimitStore,
} from '../types/index.js';
import type {
  ComposedIncrementResult,
  ComposedLayerRow,
  ComposedStoreOptions,
  CompositionLayer,
  CompositionMode,
} from './types.js';
import { isComposedIncrementResult } from './types.js';

type DecrementFrame = readonly number[];

function defaultKeyTransform(key: string): string {
  return key;
}

function mergeIncOpts(
  layer: CompositionLayer,
  base?: RateLimitIncrementOptions,
): RateLimitIncrementOptions | undefined {
  const maxRequests = layer.maxRequests ?? base?.maxRequests;
  const cost = base?.cost;
  if (maxRequests === undefined && cost === undefined && base === undefined) {
    return undefined;
  }
  return { ...base, maxRequests, cost };
}

function emptyRow(consulted: boolean, err?: string): ComposedLayerRow {
  return {
    totalHits: 0,
    remaining: 0,
    resetTime: new Date(),
    isBlocked: true,
    consulted,
    ...(err !== undefined ? { error: err } : {}),
  };
}

function notConsultedRow(resetTime: Date): ComposedLayerRow {
  return {
    totalHits: 0,
    remaining: 0,
    resetTime,
    isBlocked: false,
    consulted: false,
  };
}

function composeDecidingPath(outerLabel: string, r: RateLimitResult): string {
  if (!isComposedIncrementResult(r)) {
    return outerLabel;
  }
  const inner = r.decidingPath ?? r.decidingLayer;
  return `${outerLabel}.${inner}`;
}

function rowFromRateLimitResult(r: RateLimitResult): ComposedLayerRow {
  const base: ComposedLayerRow = {
    totalHits: r.totalHits,
    remaining: r.remaining,
    resetTime: r.resetTime,
    isBlocked: r.isBlocked,
    consulted: true,
  };
  if (isComposedIncrementResult(r)) {
    return { ...base, innerLayers: { ...r.layers } };
  }
  return base;
}

/** Compute the denominator for layer summary (total capacity or at least totalHits). */
function computeLayerCapacity(row: ComposedLayerRow): number {
  const cap = row.totalHits + row.remaining;
  return Math.max(cap, row.totalHits, 1);
}

/** Append status suffix based on layer state. */
function formatLayerStatus(row: ComposedLayerRow, result: ComposedIncrementResult): string {
  if (!row.consulted) {
    return ' (not consulted)';
  }
  if (row.error !== undefined) {
    return ' (error)';
  }
  if (row.isBlocked) {
    return ' (blocked)';
  }
  if (result.mode === 'all' && result.isBlocked) {
    return ' (rolled back)';
  }
  return '';
}

function formatLayerSummarySegment(
  label: string,
  row: ComposedLayerRow,
  result: ComposedIncrementResult,
): string {
  const denom = computeLayerCapacity(row);
  const base = `${label}: ${row.remaining}/${denom} remaining`;
  return base + formatLayerStatus(row, result);
}

/** Readable `a.b: rem/den` or `a.b: not consulted` for nested summarize (matches dotted paths). */
function formatNestedLayerLine(
  dottedPath: string,
  row: ComposedLayerRow,
  result: ComposedIncrementResult,
): string {
  if (!row.consulted) {
    return `${dottedPath}: not consulted`;
  }
  const denom = computeLayerCapacity(row);
  const base = `${dottedPath}: ${row.remaining}/${denom}`;
  return base + formatLayerStatus(row, result);
}

function collectNestedSummarizeLines(
  parentPath: string,
  row: ComposedLayerRow,
  result: ComposedIncrementResult,
): string[] {
  if (row.innerLayers) {
    const lines: string[] = [];
    for (const [name, inner] of Object.entries(row.innerLayers)) {
      const path = `${parentPath}.${name}`;
      if (inner.innerLayers) {
        lines.push(...collectNestedSummarizeLines(path, inner, result));
      } else {
        lines.push(formatNestedLayerLine(path, inner, result));
      }
    }
    return lines;
  }
  return [formatNestedLayerLine(parentPath, row, result)];
}

function summarizeSegmentsForResult(r: ComposedIncrementResult): string[] {
  const segments: string[] = [];
  for (const [label, row] of Object.entries(r.layers)) {
    if (row.innerLayers) {
      segments.push(...collectNestedSummarizeLines(label, row, r));
    } else {
      segments.push(formatLayerSummarySegment(label, row, r));
    }
  }
  return segments;
}

function maxLayerResetTimeMsDeep(rows: Record<string, ComposedLayerRow>): number {
  let max = 0;
  for (const row of Object.values(rows)) {
    max = Math.max(max, row.resetTime.getTime());
    if (row.innerLayers) {
      max = Math.max(max, maxLayerResetTimeMsDeep(row.innerLayers));
    }
  }
  return max;
}

function maxLayerResetTimeMs(result: ComposedIncrementResult): number {
  return maxLayerResetTimeMsDeep(result.layers);
}

function isIncrementResultStale(result: ComposedIncrementResult, now: number): boolean {
  const rows = Object.values(result.layers);
  if (rows.length === 0) {
    return true;
  }
  return now >= maxLayerResetTimeMs(result);
}

/**
 * Composed {@link RateLimitStore} — plugs into {@link expressRateLimiter}, {@link fastifyRateLimiter}, and {@link RateLimitEngine}.
 *
 * @see {@link ComposedStoreOptions}
 */
export class ComposedStore implements RateLimitStore {
  readonly [COMPOSED_STORE_BRAND] = true;

  readonly mode: CompositionMode;

  readonly layers: readonly CompositionLayer[];

  private readonly rollbackOnBlock: boolean;

  private readonly raceTimeoutMs: number;

  /** LIFO stack of layer-index frames per key (matched by {@link ComposedStore.decrement}). */
  private readonly decrementStacks = new Map<string, DecrementFrame[]>();

  /** Last successful layer index for `first-available` (per key). */
  private readonly firstAvailableWinner = new Map<string, number>();

  /** Overflow mode: last layer that consumed quota for `key` (for expiry sweep). */
  private readonly overflowRoute = new Map<string, 'primary' | 'burst'>();

  /** Overflow mode: soonest reset time (ms) among layers consulted on the last successful increment. */
  private readonly overflowRouteExpiryMs = new Map<string, number>();

  /** Last {@link ComposedIncrementResult} per logical key (for {@link ComposedStore.getLayerResults} / {@link ComposedStore.summarize}). */
  private readonly lastIncrementByKey = new Map<string, ComposedIncrementResult>();

  constructor(options: ComposedStoreOptions) {
    if (!options.layers || options.layers.length < 1) {
      throw new Error('ComposedStore requires at least one layer');
    }
    const labels = new Set<string>();
    for (const layer of options.layers) {
      if (labels.has(layer.label)) {
        throw new Error(`ComposedStore: duplicate layer label "${layer.label}"`);
      }
      labels.add(layer.label);
    }
    if (options.mode === 'overflow' && options.layers.length !== 2) {
      throw new Error("ComposedStore mode 'overflow' requires exactly two layers (primary, burst)");
    }
    this.mode = options.mode;
    this.layers = Object.freeze([...options.layers]) as readonly CompositionLayer[];
    this.rollbackOnBlock = options.rollbackOnBlock !== false;
    this.raceTimeoutMs = options.raceTimeoutMs ?? 5000;

    if (options.mode === 'overflow' && options.layers.length === 2) {
      const pStore = options.layers[0]!.store;
      const bStore = options.layers[1]!.store;
      if (pStore instanceof MemoryStore && bStore instanceof MemoryStore) {
        const pw = pStore.getWindowLengthMs();
        const bw = bStore.getWindowLengthMs();
        if (pw !== undefined && bw !== undefined && bw < pw) {
          console.warn(
            '[ComposedStore] overflow mode: burst window is shorter than primary window. Burst allowance is usually evaluated over a window at least as long as the steady-rate window.',
          );
        }
      }
    }
  }

  /**
   * Burst layer storage key in `overflow` mode: default `burst:${key}` so burst does not collide with
   * primary when both use the same {@link RateLimitStore} instance. Set `keyTransform` on the burst
   * layer to override; use `keyTransform: (k) => k` to disable namespacing.
   */
  private overflowBurstKey(burst: CompositionLayer, key: string): string {
    if (burst.keyTransform !== undefined) {
      return burst.keyTransform(key);
    }
    return `burst:${key}`;
  }

  private overflowStorageKey(layerIndex: 0 | 1, key: string): string {
    const layer = this.layers[layerIndex]!;
    if (layerIndex === 1) {
      return this.overflowBurstKey(layer, key);
    }
    return this.layerKey(layer, key);
  }

  private sweepOverflowRouteIfExpired(key: string): void {
    const exp = this.overflowRouteExpiryMs.get(key);
    if (exp !== undefined && Date.now() >= exp) {
      this.overflowRouteExpiryMs.delete(key);
      this.overflowRoute.delete(key);
    }
  }

  private clearOverflowRouteState(key: string): void {
    this.overflowRoute.delete(key);
    this.overflowRouteExpiryMs.delete(key);
  }

  private layerKey(layer: CompositionLayer, key: string): string {
    const t = layer.keyTransform ?? defaultKeyTransform;
    return t(key);
  }

  private pushFrame(key: string, indices: readonly number[]): void {
    let s = this.decrementStacks.get(key);
    if (!s) {
      s = [];
      this.decrementStacks.set(key, s);
    }
    s.push([...indices]);
  }

  private popFrame(key: string): DecrementFrame | undefined {
    const s = this.decrementStacks.get(key);
    if (!s || s.length === 0) {
      return undefined;
    }
    const frame = s.pop();
    if (s.length === 0) {
      this.decrementStacks.delete(key);
    }
    return frame;
  }

  private async rollbackSuccess(
    layerIndex: number,
    storageKey: string,
    incOpts: RateLimitIncrementOptions | undefined,
    result: RateLimitResult,
  ): Promise<void> {
    if (result.isBlocked) {
      return;
    }
    const dec = matchingDecrementOptions(incOpts);
    await this.layers[layerIndex]!.store.decrement(storageKey, {
      ...dec,
      removeNewest: true,
    });
  }

  /** @inheritdoc */
  async increment(key: string, options?: RateLimitIncrementOptions): Promise<ComposedIncrementResult> {
    let result: ComposedIncrementResult;
    switch (this.mode) {
      case 'all':
        result = await this.incrementAll(key, options);
        break;
      case 'overflow':
        result = await this.incrementOverflow(key, options);
        break;
      case 'first-available':
        result = await this.incrementFirstAvailable(key, options);
        break;
      case 'race':
        result = await this.incrementRace(key, options);
        break;
      default: {
        const _e: never = this.mode;
        return Promise.reject(new Error(`Unsupported mode: ${String(_e)}`));
      }
    }
    this.recordLastIncrementResult(key, result);
    return result;
  }

  /**
   * Returns the per-layer results from the last increment for a given key.
   * Useful for debugging and metrics.
   *
   * @description Cached entries are removed lazily when all layer {@link ComposedLayerRow.resetTime} values are in the past.
   */
  getLayerResults(key: string): ComposedIncrementResult['layers'] | undefined {
    this.evictStaleLastIncrementEntries();
    const r = this.lastIncrementByKey.get(key);
    if (!r) {
      return undefined;
    }
    if (isIncrementResultStale(r, Date.now())) {
      this.lastIncrementByKey.delete(key);
      return undefined;
    }
    return r.layers;
  }

  /**
   * Returns a human-readable summary of the last increment for a key.
   *
   * @description Same cache and eviction rules as {@link ComposedStore.getLayerResults}. When nothing is cached, returns `"(no cached increment for key)"`.
   */
  summarize(key: string): string {
    this.evictStaleLastIncrementEntries();
    const r = this.lastIncrementByKey.get(key);
    if (!r) {
      return '(no cached increment for key)';
    }
    if (isIncrementResultStale(r, Date.now())) {
      this.lastIncrementByKey.delete(key);
      return '(no cached increment for key)';
    }
    const decider = r.decidingPath ?? r.decidingLayer;
    const head = r.isBlocked ? `BLOCKED by '${decider}'` : `ALLOWED by '${decider}'`;
    const segments = summarizeSegmentsForResult(r);
    return [head, ...segments].join(' | ');
  }

  private recordLastIncrementResult(key: string, result: ComposedIncrementResult): void {
    this.evictStaleLastIncrementEntries();
    this.lastIncrementByKey.set(key, result);
  }

  private evictStaleLastIncrementEntries(): void {
    const now = Date.now();
    for (const [k, r] of this.lastIncrementByKey) {
      if (isIncrementResultStale(r, now)) {
        this.lastIncrementByKey.delete(k);
      }
    }
  }

  private async incrementAll(key: string, options?: RateLimitIncrementOptions): Promise<ComposedIncrementResult> {
    const settled = await Promise.allSettled(
      this.layers.map((layer, i) => {
        const inc = mergeIncOpts(layer, options);
        return this.layers[i]!.store.increment(this.layerKey(layer, key), inc);
      }),
    );

    const layers: Record<string, ComposedLayerRow> = {};
    const results: (RateLimitResult | null)[] = this.layers.map(() => null);
    let anyRejected = false;

    for (let i = 0; i < settled.length; i++) {
      const label = this.layers[i]!.label;
      const st = settled[i]!;
      if (st.status === 'rejected') {
        anyRejected = true;
        layers[label] = emptyRow(true, st.reason instanceof Error ? st.reason.message : String(st.reason));
        continue;
      }
      const r = st.value;
      results[i] = r;
      layers[label] = rowFromRateLimitResult(r);
    }

    const fulfilled = results.filter((x): x is RateLimitResult => x !== null);
    const anyBlocked =
      anyRejected || fulfilled.some((r) => r.isBlocked) || fulfilled.length < this.layers.length;

    if (anyBlocked) {
      const blockedResults = fulfilled.filter((r) => r.isBlocked);
      let decidingLayer = this.layers[0]!.label;
      for (let i = 0; i < settled.length; i++) {
        if (settled[i]!.status === 'rejected') {
          decidingLayer = this.layers[i]!.label;
          break;
        }
      }
      if (!anyRejected) {
        for (let i = 0; i < results.length; i++) {
          if (results[i]?.isBlocked === true) {
            decidingLayer = this.layers[i]!.label;
            break;
          }
        }
      }

      if (this.rollbackOnBlock) {
        for (let i = 0; i < this.layers.length; i++) {
          const r = results[i];
          if (r != null && !r.isBlocked) {
            await this.rollbackSuccess(i, this.layerKey(this.layers[i]!, key), mergeIncOpts(this.layers[i]!, options), r).catch(
              () => {
                /* best-effort */
              },
            );
          }
        }
      }

      const resetAmongBlocked =
        blockedResults.length > 0
          ? new Date(Math.min(...blockedResults.map((r) => r.resetTime.getTime())))
          : fulfilled.length > 0
            ? new Date(Math.min(...fulfilled.map((r) => r.resetTime.getTime())))
            : new Date();

      const minRem =
        fulfilled.length > 0 ? Math.min(...fulfilled.map((r) => r.remaining)) : 0;
      const maxHits = fulfilled.length > 0 ? Math.max(...fulfilled.map((r) => r.totalHits)) : 0;

      let decidingPath: string | undefined;
      if (!anyRejected) {
        const idx = this.layers.findIndex((l) => l.label === decidingLayer);
        if (idx >= 0 && results[idx]) {
          decidingPath = composeDecidingPath(this.layers[idx]!.label, results[idx]!);
        }
      } else {
        decidingPath = decidingLayer;
      }

      return {
        totalHits: maxHits,
        remaining: minRem,
        resetTime: resetAmongBlocked,
        isBlocked: true,
        storeUnavailable: fulfilled.some((r) => r.storeUnavailable === true),
        mode: 'all',
        decidingLayer,
        decidingPath,
        layers,
      };
    }

    const minRem = Math.min(...fulfilled.map((r) => r.remaining));
    const minReset = new Date(Math.min(...fulfilled.map((r) => r.resetTime.getTime())));
    const maxHits = Math.max(...fulfilled.map((r) => r.totalHits));
    let tightIdx = 0;
    for (let i = 1; i < fulfilled.length; i++) {
      if (fulfilled[i]!.remaining < fulfilled[tightIdx]!.remaining) {
        tightIdx = i;
      }
    }

    this.pushFrame(
      key,
      this.layers.map((_, i) => i),
    );

    return {
      totalHits: maxHits,
      remaining: minRem,
      resetTime: minReset,
      isBlocked: false,
      storeUnavailable: fulfilled.some((r) => r.storeUnavailable === true),
      mode: 'all',
      decidingLayer: this.layers[tightIdx]!.label,
      decidingPath: composeDecidingPath(this.layers[tightIdx]!.label, fulfilled[tightIdx]!),
      layers,
    };
  }

  private async incrementOverflow(key: string, options?: RateLimitIncrementOptions): Promise<ComposedIncrementResult> {
    this.sweepOverflowRouteIfExpired(key);

    const primary = this.layers[0]!;
    const burst = this.layers[1]!;
    const pk = this.layerKey(primary, key);
    const bk = this.overflowBurstKey(burst, key);
    const pOpts = mergeIncOpts(primary, options);
    const bOpts = mergeIncOpts(burst, options);

    const pr = await primary.store.increment(pk, pOpts);
    const layers: Record<string, ComposedLayerRow> = {
      [primary.label]: rowFromRateLimitResult(pr),
      [burst.label]: {
        totalHits: 0,
        remaining: 0,
        resetTime: pr.resetTime,
        isBlocked: true,
        consulted: false,
      },
    };

    if (!pr.isBlocked) {
      this.pushFrame(key, [0]);
      const expireAt = pr.resetTime.getTime();
      this.overflowRoute.set(key, 'primary');
      this.overflowRouteExpiryMs.set(key, expireAt);
      return {
        ...pr,
        mode: 'overflow',
        decidingLayer: primary.label,
        decidingPath: composeDecidingPath(primary.label, pr),
        layers,
      };
    }

    // Primary counted this hit even when blocked — do not roll back (steady track reflects reality).
    const br = await burst.store.increment(bk, bOpts);
    layers[burst.label] = rowFromRateLimitResult(br);

    const soonestResetMs = Math.min(pr.resetTime.getTime(), br.resetTime.getTime());
    const combinedReset = new Date(soonestResetMs);

    if (!br.isBlocked) {
      this.pushFrame(key, [1]);
      this.overflowRoute.set(key, 'burst');
      this.overflowRouteExpiryMs.set(key, soonestResetMs);
      return {
        totalHits: pr.totalHits,
        remaining: br.remaining,
        resetTime: combinedReset,
        isBlocked: false,
        storeUnavailable: pr.storeUnavailable === true || br.storeUnavailable === true,
        mode: 'overflow',
        decidingLayer: burst.label,
        decidingPath: composeDecidingPath(burst.label, br),
        layers,
      };
    }

    const soonest = new Date(soonestResetMs);
    this.overflowRoute.set(key, 'burst');
    this.overflowRouteExpiryMs.set(key, soonestResetMs);
    return {
      totalHits: Math.max(pr.totalHits, br.totalHits),
      remaining: 0,
      resetTime: soonest,
      isBlocked: true,
      storeUnavailable: pr.storeUnavailable === true || br.storeUnavailable === true,
      mode: 'overflow',
      decidingLayer: burst.label,
      decidingPath: composeDecidingPath(burst.label, br),
      layers,
    };
  }

  private async incrementFirstAvailable(key: string, options?: RateLimitIncrementOptions): Promise<ComposedIncrementResult> {
    const layers: Record<string, ComposedLayerRow> = {};

    let lastBlocked: RateLimitResult | undefined;
    let lastLabel = this.layers[0]!.label;

    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i]!;
      const lk = this.layerKey(layer, key);
      const inc = mergeIncOpts(layer, options);
      let r: RateLimitResult;
      try {
        r = await layer.store.increment(lk, inc);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        layers[layer.label] = emptyRow(true, msg);
        lastLabel = layer.label;
        continue;
      }

      layers[layer.label] = rowFromRateLimitResult(r);
      lastLabel = layer.label;
      lastBlocked = r;

      if (!r.isBlocked) {
        for (let j = i + 1; j < this.layers.length; j++) {
          const lj = this.layers[j]!.label;
          layers[lj] = notConsultedRow(r.resetTime);
        }
        this.firstAvailableWinner.set(key, i);
        this.pushFrame(key, [i]);
        return {
          ...r,
          mode: 'first-available',
          decidingLayer: layer.label,
          decidingPath: composeDecidingPath(layer.label, r),
          layers,
        };
      }

    }

    const results = this.layers
      .map((l) => layers[l.label])
      .filter((row): row is ComposedLayerRow => row !== undefined && row.consulted && row.error === undefined);
    const resetTimes = results.map((row) => row.resetTime.getTime());
    const soonest = resetTimes.length > 0 ? new Date(Math.min(...resetTimes)) : lastBlocked?.resetTime ?? new Date();

    return {
      totalHits: lastBlocked?.totalHits ?? 0,
      remaining: 0,
      resetTime: soonest,
      isBlocked: true,
      storeUnavailable: lastBlocked?.storeUnavailable,
      mode: 'first-available',
      decidingLayer: lastLabel,
      decidingPath:
        lastBlocked !== undefined ? composeDecidingPath(lastLabel, lastBlocked) : lastLabel,
      layers,
    };
  }

  private async incrementRace(key: string, options?: RateLimitIncrementOptions): Promise<ComposedIncrementResult> {
    const layerKeys = this.layers.map((l) => this.layerKey(l, key));
    const incs = this.layers.map((layer, i) => {
      const inc = mergeIncOpts(layer, options);
      return layer.store.increment(layerKeys[i]!, inc);
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<'timeout'>((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), this.raceTimeoutMs);
    });

    const wrapped = incs.map((p, i) => p.then((r) => ({ kind: 'ok' as const, i, r })));
    type RaceOutcome =
      | { kind: 'ok'; i: number; r: RateLimitResult }
      | { kind: 'timeout'; i: -1; r: null };
    const first: RaceOutcome = await Promise.race([
      ...wrapped,
      timeoutP.then((): RaceOutcome => ({ kind: 'timeout', i: -1, r: null })),
    ]);

    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    if (first.kind === 'timeout') {
      void Promise.allSettled(incs).catch(() => {
        /* avoid unhandled rejection if increments never settle */
      });
      const layersTimeout: Record<string, ComposedLayerRow> = {};
      for (const layer of this.layers) {
        layersTimeout[layer.label] = {
          totalHits: 0,
          remaining: 0,
          resetTime: new Date(),
          isBlocked: true,
          consulted: true,
          error: 'pending',
        };
      }
      return {
        totalHits: 0,
        remaining: 0,
        resetTime: new Date(),
        isBlocked: true,
        mode: 'race',
        decidingLayer: 'timeout',
        layers: layersTimeout,
      };
    }

    const settled = await Promise.allSettled(incs);

    const layers: Record<string, ComposedLayerRow> = {};
    for (let i = 0; i < this.layers.length; i++) {
      const label = this.layers[i]!.label;
      const st = settled[i]!;
      if (st.status === 'fulfilled') {
        const r = st.value;
        layers[label] = rowFromRateLimitResult(r);
      } else {
        layers[label] = emptyRow(
          true,
          st.reason instanceof Error ? st.reason.message : String(st.reason),
        );
      }
    }

    for (let j = 0; j < this.layers.length; j++) {
      if (j === first.i) {
        continue;
      }
      const st = settled[j]!;
      if (st.status === 'fulfilled') {
        await this.rollbackSuccess(j, layerKeys[j]!, mergeIncOpts(this.layers[j]!, options), st.value).catch(() => {
          /* ignore */
        });
      }
    }

    this.pushFrame(key, [first.i]);

    return {
      ...first.r,
      mode: 'race',
      decidingLayer: this.layers[first.i]!.label,
      decidingPath: composeDecidingPath(this.layers[first.i]!.label, first.r),
      layers,
    };
  }

  /**
   * Draft-mode rollback for mode **`all`**: decrement each layer that still holds a blocking increment
   * (per {@link ComposedIncrementResult.layers}). Invoked by {@link RateLimitEngine.consumeWithKey} when
   * **`draft`** is true; generic {@link RateLimitStore.decrement} is insufficient when no success frame was pushed.
   */
  async rollbackDraftForBlockedIncrement(
    key: string,
    result: Pick<ComposedIncrementResult, 'layers'>,
    options?: RateLimitDecrementOptions,
  ): Promise<void> {
    if (this.mode !== 'all') {
      return;
    }
    const dec = matchingDecrementOptions(options);
    for (const layer of this.layers) {
      const row = result.layers[layer.label];
      if (row?.consulted && row.isBlocked && !row.error) {
        await layer.store.decrement(this.layerKey(layer, key), dec).catch(() => {
          /* ignore */
        });
      }
    }
  }

  /** @inheritdoc */
  async decrement(key: string, options?: RateLimitDecrementOptions): Promise<void> {
    if (this.mode === 'first-available') {
      const idx = this.firstAvailableWinner.get(key);
      this.firstAvailableWinner.delete(key);
      if (idx !== undefined) {
        const layer = this.layers[idx];
        if (layer !== undefined) {
          await layer.store.decrement(this.layerKey(layer, key), options).catch(() => {
            /* ignore */
          });
        }
        return;
      }
      const fallback = this.layers[0];
      if (fallback !== undefined) {
        await fallback.store.decrement(this.layerKey(fallback, key), options).catch(() => {
          /* ignore */
        });
      }
      return;
    }

    if (this.mode === 'overflow') {
      const frame = this.popFrame(key);
      if (frame && frame.length > 0) {
        const idx = frame[0]!;
        const layer = this.layers[idx];
        if (layer !== undefined) {
          const sk = this.overflowStorageKey(idx as 0 | 1, key);
          await layer.store.decrement(sk, options).catch(() => {
            /* ignore */
          });
        }
      }
      if (!this.decrementStacks.has(key)) {
        this.clearOverflowRouteState(key);
      }
      return;
    }

    const frame = this.popFrame(key);
    if (!frame) {
      return;
    }
    for (const idx of frame) {
      const layer = this.layers[idx];
      if (layer !== undefined) {
        await layer.store.decrement(this.layerKey(layer, key), options).catch(() => {
          /* ignore */
        });
      }
    }
  }

  /** @inheritdoc */
  async reset(key: string): Promise<void> {
    this.decrementStacks.delete(key);
    this.firstAvailableWinner.delete(key);
    this.clearOverflowRouteState(key);
    this.lastIncrementByKey.delete(key);
    if (this.mode === 'overflow') {
      const primary = this.layers[0]!;
      const burst = this.layers[1]!;
      await primary.store.reset(this.layerKey(primary, key));
      await burst.store.reset(this.overflowBurstKey(burst, key));
      return;
    }
    await Promise.all(this.layers.map((layer) => layer.store.reset(this.layerKey(layer, key))));
  }

  /** @inheritdoc */
  async shutdown(): Promise<void> {
    this.decrementStacks.clear();
    this.firstAvailableWinner.clear();
    this.overflowRoute.clear();
    this.overflowRouteExpiryMs.clear();
    this.lastIncrementByKey.clear();
    await Promise.all(this.layers.map((l) => l.store.shutdown()));
  }

  /** @inheritdoc */
  getActiveKeys(): Map<string, RateLimitActiveKeyEntry> {
    const out = new Map<string, RateLimitActiveKeyEntry>();
    for (const layer of this.layers) {
      const st = layer.store;
      if (typeof st.getActiveKeys !== 'function') {
        continue;
      }
      const m = st.getActiveKeys();
      for (const [k, v] of m) {
        out.set(`${layer.label}:${k}`, v);
      }
    }
    return out;
  }

  /** @inheritdoc */
  resetAll(): void {
    for (const layer of this.layers) {
      layer.store.resetAll?.();
    }
  }
}

registerComposedStoreConstructor(ComposedStore);
