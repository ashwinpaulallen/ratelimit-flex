import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyManager } from '../../src/key-manager/KeyManager.js';
import type { BlockReason, KeyManagerEvents, KeyState } from '../../src/key-manager/types.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const WINDOW_MS = 60_000;
const MAX_REQ = 100;

type BlockedEv = Parameters<KeyManagerEvents['blocked']>[0];
type PenalizedEv = Parameters<KeyManagerEvents['penalized']>[0];
type UnblockedEv = Parameters<KeyManagerEvents['unblocked']>[0];

describe('KeyManager events for real-time alerting (integration)', () => {
  let store: MemoryStore;
  let keyManager: KeyManager;
  const blockedEvents: BlockedEv[] = [];
  const penalizedEvents: PenalizedEv[] = [];
  const unblockedEvents: UnblockedEv[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));

    store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: WINDOW_MS,
      maxRequests: MAX_REQ,
    });
    keyManager = new KeyManager({
      store,
      maxRequests: MAX_REQ,
      windowMs: WINDOW_MS,
      penaltyBlockThreshold: 5,
      syncIntervalMs: 0,
      blockExpiryCheckIntervalMs: 1000,
      maxAuditLogSize: 500,
    });

    blockedEvents.length = 0;
    penalizedEvents.length = 0;
    unblockedEvents.length = 0;

    keyManager.on('blocked', (e) => {
      blockedEvents.push(e);
    });
    keyManager.on('penalized', (e) => {
      penalizedEvents.push(e);
    });
    keyManager.on('unblocked', (e) => {
      unblockedEvents.push(e);
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    keyManager.destroy();
    await store.shutdown();
  });

  function assertKeyStateShape(state: KeyState): void {
    expect(state).toMatchObject({
      key: expect.any(String),
      totalHits: expect.any(Number),
      remaining: expect.any(Number),
      resetTime: expect.any(Date),
      isBlocked: expect.any(Boolean),
      isManuallyBlocked: expect.any(Boolean),
      penaltyPoints: expect.any(Number),
      rewardPoints: expect.any(Number),
    });
  }

  it('penalized / blocked / unblocked events, per-key routing, payloads, and once()', async () => {
    // 2) Five penalties → threshold block on 5th
    for (let i = 0; i < 5; i++) {
      await keyManager.penalty('attacker-1', 1);
    }
    expect(penalizedEvents).toHaveLength(5);
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0].key).toBe('attacker-1');
    expect(blockedEvents[0].reason.type).toBe('penalty-escalation');
    if (blockedEvents[0].reason.type === 'penalty-escalation') {
      expect(blockedEvents[0].reason.threshold).toBe(5);
      expect(blockedEvents[0].reason.penaltyCount).toBeGreaterThanOrEqual(5);
    }

    // 3) Three different keys — penalized events carry the right key
    await keyManager.penalty('alpha', 1);
    await keyManager.penalty('beta', 1);
    await keyManager.penalty('gamma', 1);
    expect(penalizedEvents).toHaveLength(8);
    expect(penalizedEvents.slice(5, 8).map((e) => e.key)).toEqual(['alpha', 'beta', 'gamma']);

    // 4) Block expiry → unblocked with unblockedBy: 'expiry'
    vi.advanceTimersByTime(WINDOW_MS + 1);
    await vi.runOnlyPendingTimersAsync();
    const expiryUnblocks = unblockedEvents.filter((e) => e.unblockedBy === 'expiry');
    expect(expiryUnblocks.length).toBeGreaterThanOrEqual(1);
    expect(expiryUnblocks[0].key).toBe('attacker-1');

    // 5) Payload shape: Date timestamps, full KeyState on penalized/blocked, typed BlockReason
    expect(penalizedEvents[0].timestamp).toBeInstanceOf(Date);
    assertKeyStateShape(penalizedEvents[0].state);
    expect(blockedEvents[0].timestamp).toBeInstanceOf(Date);
    assertKeyStateShape(blockedEvents[0].state);
    expect(blockedEvents[0].expiresAt).toBeInstanceOf(Date);

    const br: BlockReason = blockedEvents[0].reason;
    expect(br.type).toBe('penalty-escalation');

    // 6) once('blocked') fires only for the first block
    const storeOnce = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: WINDOW_MS,
      maxRequests: MAX_REQ,
    });
    const kmOnce = new KeyManager({
      store: storeOnce,
      maxRequests: MAX_REQ,
      windowMs: WINDOW_MS,
      syncIntervalMs: 0,
      blockExpiryCheckIntervalMs: 60_000,
      maxAuditLogSize: 100,
    });
    const onceKeys: string[] = [];
    kmOnce.once('blocked', (e) => {
      onceKeys.push(e.key);
    });
    await kmOnce.block('first-key', 30_000, { type: 'manual', message: 'test' });
    await kmOnce.block('second-key', 30_000, { type: 'manual', message: 'test' });
    expect(onceKeys).toEqual(['first-key']);

    kmOnce.destroy();
    await storeOnce.shutdown();
  });
});
