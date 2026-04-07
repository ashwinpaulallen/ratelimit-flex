import { EventEmitter } from 'node:events';
import { InMemoryShield } from '../shield/InMemoryShield.js';
import type { RateLimitResult, RateLimitStore } from '../types/index.js';
import { sanitizeRateLimitCap } from '../utils/clamp.js';
import type { BlockStore } from './block-store.js';
import { fixedEscalation, type EscalationStrategy } from './strategies.js';
import type { AuditEntry, BlockReason, KeyManagerEvents, KeyManagerOptions, KeyState } from './types.js';

type EventPayload<K extends keyof KeyManagerEvents> = Parameters<KeyManagerEvents[K]>[0];

export class KeyManager {
  private readonly store: RateLimitStore;

  private readonly maxRequests: number;

  private readonly windowMs: number;

  private readonly emitter: EventEmitter;

  private readonly auditLog: AuditEntry[];

  private readonly maxAuditLogSize: number;

  private readonly penaltyBlockThreshold: number | null;

  private readonly blockExpiryCheckIntervalMs: number;

  /**
   * Manual blocks tracked in memory. These override store-level state.
   * When increment() happens through middleware, the engine should check
   * this map BEFORE checking the store.
   */
  private readonly blocks: Map<
    string,
    {
      reason: BlockReason;
      expiresAt: Date | null;
      blockedAt: Date;
    }
  >;

  /** Tracks cumulative penalty/reward points per key in the current window */
  private readonly adjustments: Map<
    string,
    {
      penaltyPoints: number;
      rewardPoints: number;
      windowStart: Date;
      /** How many times the penalty threshold has been exceeded (auto-block applied). Resets on manual unblock/delete. */
      penaltyViolationCount: number;
    }
  >;

  private blockExpiryTimer: ReturnType<typeof setInterval> | null;

  private readonly blockStore: BlockStore | undefined;

  private readonly syncIntervalMs: number;

  private syncTimer: ReturnType<typeof setInterval> | null;

  private readonly penaltyEscalation: EscalationStrategy;

  /**
   * When {@link KeyManagerOptions.store} is the raw backing store, optional reference to the
   * {@link InMemoryShield} wrapping it so manual operations can clear stale shield cache.
   */
  private readonly explicitShield: InMemoryShield | undefined;

  constructor(options: KeyManagerOptions) {
    this.store = options.store;
    this.explicitShield = options.shield;
    this.maxRequests = sanitizeRateLimitCap(options.maxRequests, 100);
    this.windowMs = Math.max(1, Math.floor(options.windowMs));
    this.maxAuditLogSize = options.maxAuditLogSize ?? 1000;
    this.penaltyBlockThreshold =
      options.penaltyBlockThreshold !== undefined && options.penaltyBlockThreshold > 0
        ? Math.floor(options.penaltyBlockThreshold)
        : null;
    this.blockExpiryCheckIntervalMs = options.blockExpiryCheckIntervalMs ?? 1000;

    this.blockStore = options.blockStore;
    this.syncIntervalMs = options.syncIntervalMs ?? 5000;
    this.syncTimer = null;
    const defaultFixedDurationMs =
      options.penaltyBlockDurationMs !== undefined
        ? Math.max(0, Math.floor(options.penaltyBlockDurationMs))
        : this.windowMs;
    this.penaltyEscalation = options.penaltyEscalation ?? fixedEscalation(defaultFixedDurationMs);

    this.blocks = new Map();
    this.adjustments = new Map();
    this.auditLog = [];
    this.emitter = new EventEmitter();
    this.blockExpiryTimer = null;

    this.blockExpiryTimer = setInterval(() => {
      this.expireDueBlocks();
    }, this.blockExpiryCheckIntervalMs);
    if (
      typeof this.blockExpiryTimer === 'object' &&
      this.blockExpiryTimer !== null &&
      'unref' in this.blockExpiryTimer
    ) {
      this.blockExpiryTimer.unref();
    }

    if (this.blockStore !== undefined && this.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => {
        void this.syncBlocks().catch(() => {
          /* ignore sync errors */
        });
      }, this.syncIntervalMs);
      if (typeof this.syncTimer === 'object' && this.syncTimer !== null && 'unref' in this.syncTimer) {
        this.syncTimer.unref();
      }
    }
  }

  /**
   * Pulls all blocks from {@link KeyManagerOptions.blockStore} into the local cache.
   * Use for immediate cross-process consistency; background sync also runs on `syncIntervalMs`.
   *
   * @remarks
   * **Performance:** O(N) where N is the number of blocked keys. For {@link RedisBlockStore},
   * this performs a SCAN operation followed by N individual GET calls. Background sync runs
   * on `syncIntervalMs` (default 5000ms), so this method is typically only called manually
   * when immediate consistency is required.
   */
  async syncBlocks(): Promise<void> {
    if (this.blockStore === undefined) {
      return;
    }
    this.expireDueBlocks();
    const remote = await this.blockStore.getAllBlocks();
    const remoteKeys = new Set(remote.map((r) => r.key));
    for (const key of [...this.blocks.keys()]) {
      if (!remoteKeys.has(key)) {
        this.blocks.delete(key);
      }
    }
    const now = Date.now();
    for (const r of remote) {
      if (r.expiresAt !== null && r.expiresAt.getTime() <= now) {
        continue;
      }
      this.blocks.set(r.key, {
        reason: r.reason,
        expiresAt: r.expiresAt,
        blockedAt: r.blockedAt ?? new Date(),
      });
    }
  }

  /**
   * Read the current state of a key WITHOUT incrementing.
   * Returns null if the key has never been seen.
   */
  async get(key: string, options?: { actor?: string }): Promise<KeyState | null> {
    const state = await this.loadKeyState(key);
    this.pushAudit('get', key, { state: state ? summarizeState(state) : null }, options?.actor);
    return state;
  }

  /**
   * Set the hit count for a key to a specific value.
   * Useful for seeding state from an external source.
   */
  async set(key: string, totalHits: number, expiresAt?: Date, options?: { actor?: string }): Promise<KeyState> {
    const prevSnap = await this.readStoreSnapshot(key);
    const previousHits = prevSnap?.totalHits ?? 0;

    if (typeof this.store.set === 'function') {
      await this.store.set!(key, totalHits, expiresAt);
    } else {
      await this.setWithoutStoreSet(key, totalHits);
    }

    const snap = await this.readStoreSnapshot(key);
    const state = this.composeKeyStateInternal(key, snap);
    const ts = new Date();
    this.emitTyped('set', {
      key,
      previousHits,
      newHits: totalHits,
      state,
      timestamp: ts,
    });
    this.pushAudit('set', key, { previousHits, newHits: totalHits, expiresAt: expiresAt?.toISOString() }, options?.actor);
    this.invalidateRateLimitShield(key);
    return state;
  }

  /**
   * Block a key for a duration. All requests from this key will be rejected
   * during the block period. The block is tracked in memory (fast, no store call)
   * and optionally persisted to the store for cross-process visibility.
   */
  async block(
    key: string,
    durationMs: number,
    reason: BlockReason = { type: 'manual' },
    options?: { actor?: string; persistToStore?: boolean },
  ): Promise<KeyState> {
    this.expireDueBlocks();
    const expiresAt = durationMs === 0 ? null : new Date(Date.now() + durationMs);
    const blockedAt = new Date();
    this.blocks.set(key, { reason, expiresAt, blockedAt });

    if (this.blockStore !== undefined) {
      await this.blockStore.setBlock(key, { reason, expiresAt, blockedAt });
    } else if (options?.persistToStore === true && typeof this.store.set === 'function') {
      await this.store.set!(key, this.maxRequests + 1, expiresAt ?? undefined);
    }

    const snap = await this.readStoreSnapshot(key);
    const state = this.composeBlocked(key, snap, reason, expiresAt);
    const ts = new Date();
    this.emitTyped('blocked', {
      key,
      reason,
      expiresAt,
      state,
      timestamp: ts,
    });
    this.pushAudit('block', key, { reason, expiresAt: expiresAt?.toISOString() ?? null, persistToStore: options?.persistToStore }, options?.actor);
    this.invalidateRateLimitShield(key);
    return state;
  }

  /**
   * Unblock a key, lifting any manual block.
   */
  async unblock(key: string, options?: { actor?: string }): Promise<KeyState | null> {
    this.expireDueBlocks();
    const entry = this.blocks.get(key);
    if (!entry) {
      return null;
    }
    if (this.blockStore !== undefined) {
      await this.blockStore.removeBlock(key);
    }
    const wasReason = entry.reason;
    this.blocks.delete(key);
    const adjUnblock = this.adjustments.get(key);
    if (adjUnblock) {
      adjUnblock.penaltyViolationCount = 0;
      this.adjustments.set(key, adjUnblock);
    }
    const ts = new Date();
    this.emitTyped('unblocked', {
      key,
      wasReason,
      unblockedBy: 'manual',
      timestamp: ts,
    });
    this.pushAudit('unblock', key, { wasReason: cloneReason(wasReason) }, options?.actor);
    this.invalidateRateLimitShield(key);
    return (await this.loadKeyState(key)) ?? this.composeZero(key);
  }

  /**
   * Add penalty points to a key. This increments the key's hit count by `points`,
   * pushing it closer to (or past) the limit.
   */
  async penalty(key: string, points = 1, options?: { actor?: string }): Promise<KeyState> {
    this.expireDueBlocks();
    const p = Math.max(1, Math.floor(points));
    this.touchAdjustmentWindow(key);

    await this.store.increment(key, { maxRequests: this.maxRequests, cost: p });

    const adj = this.adjustments.get(key)!;
    adj.penaltyPoints += p;
    this.adjustments.set(key, adj);

    const snap = await this.readStoreSnapshot(key);
    let state = this.composeKeyStateInternal(key, snap);

    const tsPen = new Date();
    this.emitTyped('penalized', {
      key,
      points: p,
      totalPenaltyPoints: adj.penaltyPoints,
      state,
      timestamp: tsPen,
    });
    this.pushAudit('penalty', key, { points: p, totalPenaltyPoints: adj.penaltyPoints }, options?.actor);

    if (
      this.penaltyBlockThreshold !== null &&
      adj.penaltyPoints >= this.penaltyBlockThreshold &&
      !this.isManualBlockActive(key)
    ) {
      adj.penaltyViolationCount = (adj.penaltyViolationCount ?? 0) + 1;
      this.adjustments.set(key, adj);
      const durationMs = Math.max(0, Math.floor(this.penaltyEscalation(adj.penaltyViolationCount)));
      const reason: BlockReason = {
        type: 'penalty-escalation',
        penaltyCount: adj.penaltyPoints,
        threshold: this.penaltyBlockThreshold,
        violationNumber: adj.penaltyViolationCount,
      };
      const exp = new Date(Date.now() + durationMs);
      const blockedAtPen = new Date();
      this.blocks.set(key, {
        reason,
        expiresAt: exp,
        blockedAt: blockedAtPen,
      });
      if (this.blockStore !== undefined) {
        await this.blockStore.setBlock(key, { reason, expiresAt: exp, blockedAt: blockedAtPen });
      }
      state = this.composeBlocked(key, snap, reason, exp);
      const ts = new Date();
      this.emitTyped('blocked', {
        key,
        reason,
        expiresAt: exp,
        state,
        timestamp: ts,
      });
      this.pushAudit('block', key, { reason, auto: true }, options?.actor);
    }

    return state;
  }

  /**
   * Reward a key by decrementing its hit count by `points`,
   * giving it more headroom. Cannot go below 0 hits.
   */
  async reward(key: string, points = 1, options?: { actor?: string }): Promise<KeyState> {
    this.expireDueBlocks();
    const p = Math.max(1, Math.floor(points));
    this.touchAdjustmentWindow(key);

    await this.decrementWithCost(key, p);

    const adj = this.adjustments.get(key)!;
    adj.rewardPoints += p;
    this.adjustments.set(key, adj);

    const snap = await this.readStoreSnapshot(key);
    const state = this.composeKeyStateInternal(key, snap);

    const ts = new Date();
    this.emitTyped('rewarded', {
      key,
      points: p,
      totalRewardPoints: adj.rewardPoints,
      state,
      timestamp: ts,
    });
    this.pushAudit('reward', key, { points: p, totalRewardPoints: adj.rewardPoints }, options?.actor);
    this.invalidateRateLimitShield(key);
    return state;
  }

  /**
   * Delete all data for a key — hits, blocks, penalties, rewards, audit entries.
   * The key becomes completely unknown, as if it never existed.
   */
  async delete(key: string, options?: { actor?: string }): Promise<boolean> {
    this.expireDueBlocks();
    const previousState = await this.loadKeyState(key);

    const hadBlock = this.blocks.has(key);
    const hadAdj = this.adjustments.has(key);
    if (this.blockStore !== undefined) {
      await this.blockStore.removeBlock(key);
    }
    this.blocks.delete(key);
    this.adjustments.delete(key);

    let storeExisted: boolean;
    if (typeof this.store.delete === 'function') {
      storeExisted = await this.store.delete!(key);
    } else {
      await this.store.reset(key);
      storeExisted = previousState !== null;
    }

    const existed = hadBlock || hadAdj || storeExisted || previousState !== null;

    const ts = new Date();
    this.emitTyped('deleted', {
      key,
      previousState,
      timestamp: ts,
    });
    this.pushAudit('delete', key, { hadBlock, hadAdj, storeExisted }, options?.actor);
    this.invalidateRateLimitShield(key);
    return existed;
  }

  /** Fast O(1) check against the in-memory blocks map (also respects expiry). */
  isBlocked(key: string): boolean {
    this.expireDueBlocks();
    return this.isManualBlockActive(key);
  }

  /** Block metadata, or null if not manually blocked. */
  getBlockInfo(key: string): { reason: BlockReason; expiresAt: Date | null; blockedAt: Date } | null {
    this.expireDueBlocks();
    const b = this.blocks.get(key);
    if (!b) {
      return null;
    }
    if (b.expiresAt !== null && b.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    return { reason: b.reason, expiresAt: b.expiresAt, blockedAt: b.blockedAt };
  }

  on<K extends keyof KeyManagerEvents>(event: K, listener: KeyManagerEvents[K]): this {
    this.emitter.on(event, listener as never);
    return this;
  }

  off<K extends keyof KeyManagerEvents>(event: K, listener: KeyManagerEvents[K]): this {
    this.emitter.off(event, listener as never);
    return this;
  }

  once<K extends keyof KeyManagerEvents>(event: K, listener: KeyManagerEvents[K]): this {
    this.emitter.once(event, listener as never);
    return this;
  }

  /** Get audit log entries, optionally filtered (newest first). */
  getAuditLog(filter?: {
    key?: string;
    action?: AuditEntry['action'];
    since?: Date;
    limit?: number;
  }): AuditEntry[] {
    let rows = [...this.auditLog];
    if (filter?.key !== undefined) {
      rows = rows.filter((e) => e.key === filter.key);
    }
    if (filter?.action !== undefined) {
      rows = rows.filter((e) => e.action === filter.action);
    }
    if (filter?.since !== undefined) {
      rows = rows.filter((e) => e.timestamp >= filter.since!);
    }
    rows.reverse();
    if (filter?.limit !== undefined) {
      rows = rows.slice(0, filter.limit);
    }
    return rows;
  }

  clearAuditLog(): void {
    this.auditLog.length = 0;
  }

  getBlockedKeys(): Array<{ key: string; reason: BlockReason; expiresAt: Date | null }> {
    this.expireDueBlocks();
    const out: Array<{ key: string; reason: BlockReason; expiresAt: Date | null }> = [];
    const now = Date.now();
    for (const [k, v] of this.blocks.entries()) {
      if (v.expiresAt === null || v.expiresAt.getTime() > now) {
        out.push({ key: k, reason: v.reason, expiresAt: v.expiresAt });
      }
    }
    return out;
  }

  unblockAll(options?: { actor?: string }): void {
    this.expireDueBlocks();
    const keys = Array.from(this.blocks.keys());
    for (const key of keys) {
      const entry = this.blocks.get(key)!;
      const wasReason = entry.reason;
      this.blocks.delete(key);
      const adjBulk = this.adjustments.get(key);
      if (adjBulk) {
        adjBulk.penaltyViolationCount = 0;
        this.adjustments.set(key, adjBulk);
      }
      const ts = new Date();
      this.emitTyped('unblocked', {
        key,
        wasReason,
        unblockedBy: 'manual',
        timestamp: ts,
      });
      this.pushAudit('unblock', key, { wasReason: cloneReason(wasReason), bulk: true }, options?.actor);
      this.invalidateRateLimitShield(key);
    }
    if (this.blockStore !== undefined) {
      void Promise.all(keys.map((k) => this.blockStore!.removeBlock(k))).catch(() => {
        /* ignore */
      });
    }
  }

  /**
   * Clean up timers and resources.
   *
   * @remarks Call when shutting down the process or disposing a long-lived app (e.g. Nest `onModuleDestroy`,
   * tests, hot reload). Nest `RateLimitModule` calls this automatically for a KeyManager created from
   * `penaltyBox` only; if you pass your own `keyManager` to `forRoot`, you must call `destroy()` yourself.
   */
  destroy(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.blockExpiryTimer !== null) {
      clearInterval(this.blockExpiryTimer);
      this.blockExpiryTimer = null;
    }
    this.blocks.clear();
    this.adjustments.clear();
    this.auditLog.length = 0;
    this.emitter.removeAllListeners();
  }

  /** Alias of {@link destroy} for explicit teardown naming. */
  dispose(): void {
    this.destroy();
  }

  // --- internals -----------------------------------------------------------

  /**
   * Clears {@link InMemoryShield} cache for `key` when the shield wraps the store or when
   * {@link KeyManagerOptions.shield} is set (raw store + explicit shield reference).
   */
  private invalidateRateLimitShield(key: string): void {
    if (this.store instanceof InMemoryShield) {
      this.store.unshield(key);
    }
    this.explicitShield?.unshield(key);
  }

  private emitTyped<K extends keyof KeyManagerEvents>(event: K, payload: EventPayload<K>): boolean {
    return (this.emitter as EventEmitter).emit(event, payload);
  }

  private expireDueBlocks(): void {
    const now = Date.now();
    for (const [key, v] of [...this.blocks.entries()]) {
      if (v.expiresAt !== null && v.expiresAt.getTime() <= now) {
        const wasReason = v.reason;
        this.blocks.delete(key);
        this.invalidateRateLimitShield(key);
        const ts = new Date();
        this.emitTyped('unblocked', {
          key,
          wasReason,
          unblockedBy: 'expiry',
          timestamp: ts,
        });
        this.pushAudit('unblock', key, { wasReason: cloneReason(wasReason), unblockedBy: 'expiry' }, undefined);
      }
    }
  }

  private isManualBlockActive(key: string): boolean {
    const b = this.blocks.get(key);
    if (!b) {
      return false;
    }
    if (b.expiresAt === null) {
      return true;
    }
    return b.expiresAt.getTime() > Date.now();
  }

  private async loadKeyState(key: string): Promise<KeyState | null> {
    this.expireDueBlocks();
    const snap = await this.readStoreSnapshot(key);
    if (this.isManualBlockActive(key)) {
      const b = this.blocks.get(key)!;
      return this.composeBlocked(key, snap, b.reason, b.expiresAt);
    }
    if (snap === null) {
      return null;
    }
    return this.composeOpen(key, snap);
  }

  /**
   * Reads store quota without relying on optional {@link RateLimitStore.get}.
   *
   * @remarks Performs `increment` then `decrement` with the same cost — a peek with a minor race if concurrent writers touch the same key.
   */
  private async readStoreSnapshot(key: string): Promise<RateLimitResult | null> {
    if (typeof this.store.get === 'function') {
      const g = await this.store.get!(key);
      if (g === null) {
        return null;
      }
      return {
        totalHits: g.totalHits,
        remaining: g.remaining,
        resetTime: g.resetTime,
        isBlocked: g.isBlocked,
      };
    }
    const r = await this.store.increment(key, { maxRequests: this.maxRequests, cost: 1 });
    await this.store.decrement(key, { cost: 1 });
    const rawHits = Math.max(0, r.totalHits - 1);
    const remaining = Math.max(0, this.maxRequests - rawHits);
    const isBlocked = rawHits > this.maxRequests;
    return {
      totalHits: rawHits,
      remaining,
      resetTime: r.resetTime,
      isBlocked,
    };
  }

  private async setWithoutStoreSet(key: string, totalHits: number): Promise<void> {
    await this.store.reset(key);
    const n = Math.max(0, Math.floor(totalHits));
    if (n <= 0) {
      return;
    }
    await this.store.increment(key, { maxRequests: this.maxRequests, cost: n });
  }

  private async decrementWithCost(key: string, cost: number): Promise<void> {
    await this.store.decrement(key, { cost });
  }

  private touchAdjustmentWindow(key: string): void {
    const now = Date.now();
    let adj = this.adjustments.get(key);
    if (!adj) {
      this.adjustments.set(key, {
        penaltyPoints: 0,
        rewardPoints: 0,
        windowStart: new Date(now),
        penaltyViolationCount: 0,
      });
      return;
    }
    if (now - adj.windowStart.getTime() >= this.windowMs) {
      const preservedViolations = adj.penaltyViolationCount ?? 0;
      adj = {
        penaltyPoints: 0,
        rewardPoints: 0,
        windowStart: new Date(now),
        penaltyViolationCount: preservedViolations,
      };
      this.adjustments.set(key, adj);
    }
  }

  private getAdjustment(key: string): { penaltyPoints: number; rewardPoints: number } {
    const adj = this.adjustments.get(key);
    return {
      penaltyPoints: adj?.penaltyPoints ?? 0,
      rewardPoints: adj?.rewardPoints ?? 0,
    };
  }

  private emptySnapshot(): RateLimitResult {
    const now = Date.now();
    return {
      totalHits: 0,
      remaining: this.maxRequests,
      resetTime: new Date(now + this.windowMs),
      isBlocked: false,
    };
  }

  private composeKeyStateInternal(key: string, snap: RateLimitResult | null): KeyState {
    if (this.isManualBlockActive(key)) {
      const b = this.blocks.get(key)!;
      return this.composeBlocked(key, snap, b.reason, b.expiresAt);
    }
    if (snap === null) {
      return this.composeZero(key);
    }
    return this.composeOpen(key, snap);
  }

  private composeBlocked(
    key: string,
    snap: RateLimitResult | null,
    reason: BlockReason,
    expiresAt: Date | null | undefined,
  ): KeyState {
    const base = snap ?? this.emptySnapshot();
    const adj = this.getAdjustment(key);
    return {
      key,
      totalHits: base.totalHits,
      remaining: 0,
      resetTime: base.resetTime,
      isBlocked: true,
      isManuallyBlocked: reason.type === 'manual' || reason.type === 'abuse-pattern' || reason.type === 'custom',
      blockReason: reason,
      blockExpiresAt: expiresAt === undefined ? this.blocks.get(key)?.expiresAt ?? null : expiresAt,
      penaltyPoints: adj.penaltyPoints,
      rewardPoints: adj.rewardPoints,
    };
  }

  private composeOpen(key: string, snap: RateLimitResult): KeyState {
    const adj = this.getAdjustment(key);
    return {
      key,
      totalHits: snap.totalHits,
      remaining: snap.remaining,
      resetTime: snap.resetTime,
      isBlocked: snap.isBlocked,
      isManuallyBlocked: false,
      penaltyPoints: adj.penaltyPoints,
      rewardPoints: adj.rewardPoints,
    };
  }

  private composeZero(key: string): KeyState {
    const adj = this.getAdjustment(key);
    return {
      key,
      totalHits: 0,
      remaining: this.maxRequests,
      resetTime: new Date(Date.now() + this.windowMs),
      isBlocked: false,
      isManuallyBlocked: false,
      penaltyPoints: adj.penaltyPoints,
      rewardPoints: adj.rewardPoints,
    };
  }

  private pushAudit(
    action: AuditEntry['action'],
    key: string,
    details: Record<string, unknown>,
    actor: string | undefined,
  ): void {
    if (this.maxAuditLogSize === 0) {
      return;
    }
    this.auditLog.push({
      timestamp: new Date(),
      key,
      action,
      details,
      actor,
    });
    while (this.auditLog.length > this.maxAuditLogSize) {
      this.auditLog.shift();
    }
  }
}

function summarizeState(s: KeyState): Record<string, unknown> {
  return {
    totalHits: s.totalHits,
    isBlocked: s.isBlocked,
    isManuallyBlocked: s.isManuallyBlocked,
  };
}

function cloneReason(r: BlockReason): BlockReason {
  return { ...r };
}
