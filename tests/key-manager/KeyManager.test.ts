import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyManager } from '../../src/key-manager/KeyManager.js';
import { exponentialEscalation, fixedEscalation, linearEscalation } from '../../src/key-manager/strategies.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

function createManager(overrides?: {
  maxAuditLogSize?: number;
  penaltyBlockThreshold?: number;
  penaltyBlockDurationMs?: number;
  blockExpiryCheckIntervalMs?: number;
  penaltyEscalation?: import('../../src/key-manager/strategies.js').EscalationStrategy;
}) {
  const store = new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 10,
  });
  const km = new KeyManager({
    store,
    maxRequests: 10,
    windowMs: 60_000,
    maxAuditLogSize: overrides?.maxAuditLogSize ?? 1000,
    penaltyBlockThreshold: overrides?.penaltyBlockThreshold,
    penaltyBlockDurationMs: overrides?.penaltyBlockDurationMs,
    penaltyEscalation: overrides?.penaltyEscalation,
    blockExpiryCheckIntervalMs: overrides?.blockExpiryCheckIntervalMs ?? 100,
  });
  return { km, store };
}

describe('KeyManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('get', () => {
    it('returns null for unknown key', async () => {
      const { km } = createManager();
      await expect(km.get('unknown')).resolves.toBeNull();
      km.destroy();
    });

    it('returns correct state after increments', async () => {
      const { km, store } = createManager();
      await store.increment('u');
      await store.increment('u');
      const g = await km.get('u');
      expect(g!.totalHits).toBe(2);
      expect(g!.remaining).toBe(8);
      expect(g!.penaltyPoints).toBe(0);
      expect(g!.rewardPoints).toBe(0);
      km.destroy();
    });

    it('includes penalty/reward point tracking from KeyManager actions', async () => {
      const { km } = createManager();
      await km.penalty('u', 2);
      await km.reward('u', 1);
      const g = await km.get('u');
      expect(g!.penaltyPoints).toBe(2);
      expect(g!.rewardPoints).toBe(1);
      km.destroy();
    });

    it('shows isManuallyBlocked when blocked with manual reason', async () => {
      const { km } = createManager();
      await km.block('k', 5000, { type: 'manual', message: 'nope' });
      const g = await km.get('k');
      expect(g!.isManuallyBlocked).toBe(true);
      expect(g!.isBlocked).toBe(true);
      expect(g!.blockReason?.type).toBe('manual');
      km.destroy();
    });

    it('shows isManuallyBlocked true for abuse-pattern blocks', async () => {
      const { km } = createManager();
      await km.block('k', 5000, { type: 'abuse-pattern', pattern: 'credential-stuffing' });
      const g = await km.get('k');
      expect(g!.isManuallyBlocked).toBe(true);
      expect(g!.isBlocked).toBe(true);
      expect(g!.blockReason?.type).toBe('abuse-pattern');
      km.destroy();
    });

    it('shows isManuallyBlocked true for custom blocks', async () => {
      const { km } = createManager();
      await km.block('k', 5000, { type: 'custom', code: 'SUSPICIOUS_PATTERN' });
      const g = await km.get('k');
      expect(g!.isManuallyBlocked).toBe(true);
      expect(g!.isBlocked).toBe(true);
      expect(g!.blockReason?.type).toBe('custom');
      km.destroy();
    });

    it('does not increment the counter (two gets match)', async () => {
      const { km, store } = createManager();
      await store.increment('x');
      await store.increment('x');
      const a = await km.get('x');
      const b = await km.get('x');
      expect(a!.totalHits).toBe(b!.totalHits);
      expect((await store.get?.('x'))!.totalHits).toBe(2);
      km.destroy();
    });
  });

  describe('set', () => {
    it('sets counter to exact value', async () => {
      const { km } = createManager();
      await km.set('s', 7);
      const g = await km.get('s');
      expect(g!.totalHits).toBe(7);
      km.destroy();
    });

    it("emits 'set' event with previous and new state", async () => {
      const { km } = createManager();
      const fn = vi.fn();
      km.on('set', fn);
      await km.set('e', 3);
      expect(fn).toHaveBeenCalledTimes(1);
      const arg = fn.mock.calls[0]![0];
      expect(arg.previousHits).toBe(0);
      expect(arg.newHits).toBe(3);
      expect(arg.state.totalHits).toBe(3);
      km.destroy();
    });

    it('works with expiresAt on MemoryStore sliding set', async () => {
      const { km } = createManager();
      const exp = new Date(Date.now() + 5000);
      await km.set('s', 2, exp);
      const g = await km.get('s');
      expect(g!.totalHits).toBe(2);
      km.destroy();
    });
  });

  describe('block', () => {
    it('blocks a key with a reason', async () => {
      const { km } = createManager();
      await km.block('b', 5000, { type: 'abuse-pattern', pattern: 'foo' });
      expect(km.isBlocked('b')).toBe(true);
      const info = km.getBlockInfo('b');
      expect(info?.reason.type).toBe('abuse-pattern');
      km.destroy();
    });

    it('isBlocked returns true after block', async () => {
      const { km } = createManager();
      await km.block('b', 10_000);
      expect(km.isBlocked('b')).toBe(true);
      km.destroy();
    });

    it('block auto-expires after durationMs', async () => {
      const { km } = createManager({ blockExpiryCheckIntervalMs: 50 });
      const onUnblock = vi.fn();
      km.on('unblocked', onUnblock);
      await km.block('b', 1000);
      expect(km.isBlocked('b')).toBe(true);
      vi.advanceTimersByTime(1001);
      vi.runOnlyPendingTimers();
      expect(km.isBlocked('b')).toBe(false);
      expect(onUnblock).toHaveBeenCalled();
      const call = onUnblock.mock.calls.find((c) => c[0].unblockedBy === 'expiry');
      expect(call).toBeDefined();
      km.destroy();
    });

    it('permanent block never expires via timer', async () => {
      const { km } = createManager({ blockExpiryCheckIntervalMs: 50 });
      await km.block('p', 0);
      vi.advanceTimersByTime(60_000);
      vi.runOnlyPendingTimers();
      expect(km.isBlocked('p')).toBe(true);
      km.destroy();
    });

    it("emits 'blocked' event", async () => {
      const { km } = createManager();
      const fn = vi.fn();
      km.on('blocked', fn);
      await km.block('b', 5000, { type: 'manual' });
      expect(fn).toHaveBeenCalled();
      km.destroy();
    });

    it("emits 'unblocked' on expiry", async () => {
      const { km } = createManager({ blockExpiryCheckIntervalMs: 50 });
      const fn = vi.fn();
      km.on('unblocked', fn);
      await km.block('b', 200);
      vi.advanceTimersByTime(500);
      vi.runOnlyPendingTimers();
      expect(fn.mock.calls.some((c) => c[0].unblockedBy === 'expiry')).toBe(true);
      km.destroy();
    });

    it('getBlockedKeys returns all blocked keys', async () => {
      const { km } = createManager();
      await km.block('a', 10_000);
      await km.block('b', 10_000);
      const keys = km.getBlockedKeys().map((k) => k.key).sort();
      expect(keys).toEqual(['a', 'b']);
      km.destroy();
    });
  });

  describe('unblock', () => {
    it('removes a block and emits unblocked manual', async () => {
      const { km } = createManager();
      const fn = vi.fn();
      km.on('unblocked', fn);
      await km.block('u', 10_000);
      await km.unblock('u');
      expect(km.isBlocked('u')).toBe(false);
      expect(fn.mock.calls.some((c) => c[0].unblockedBy === 'manual')).toBe(true);
      km.destroy();
    });

    it('returns null if key was not blocked', async () => {
      const { km } = createManager();
      await expect(km.unblock('nope')).resolves.toBeNull();
      km.destroy();
    });
  });

  describe('penalty', () => {
    it('increments the counter by points', async () => {
      const { km, store } = createManager();
      await km.penalty('p', 3);
      expect((await store.get?.('p'))!.totalHits).toBe(3);
      km.destroy();
    });

    it('tracks penaltyPoints separately', async () => {
      const { km } = createManager();
      await km.penalty('p', 2);
      await km.penalty('p', 2);
      const g = await km.get('p');
      expect(g!.penaltyPoints).toBe(4);
      km.destroy();
    });

    it('auto-blocks when penaltyBlockThreshold is exceeded', async () => {
      const { km } = createManager({ penaltyBlockThreshold: 5, penaltyBlockDurationMs: 30_000 });
      await km.penalty('p', 5);
      expect(km.isBlocked('p')).toBe(true);
      const info = km.getBlockInfo('p');
      expect(info?.reason.type).toBe('penalty-escalation');
      km.destroy();
    });

    it('penalty-escalation blocks set isManuallyBlocked to false', async () => {
      const { km } = createManager({ penaltyBlockThreshold: 3, penaltyBlockDurationMs: 10_000 });
      await km.penalty('p', 3);
      const state = await km.get('p');
      expect(state!.isBlocked).toBe(true);
      expect(state!.isManuallyBlocked).toBe(false);
      expect(state!.blockReason?.type).toBe('penalty-escalation');
      km.destroy();
    });

    it("emits 'penalized' event", async () => {
      const { km } = createManager();
      const fn = vi.fn();
      km.on('penalized', fn);
      await km.penalty('p', 2);
      expect(fn).toHaveBeenCalled();
      km.destroy();
    });

    it("auto-block emits both 'penalized' and 'blocked'", async () => {
      const { km } = createManager({ penaltyBlockThreshold: 2, penaltyBlockDurationMs: 10_000 });
      const penalized = vi.fn();
      const blocked = vi.fn();
      km.on('penalized', penalized);
      km.on('blocked', blocked);
      await km.penalty('p', 2);
      expect(penalized).toHaveBeenCalled();
      expect(blocked).toHaveBeenCalled();
      km.destroy();
    });

    it('uses penaltyEscalation for auto-block duration (linear)', async () => {
      const { km } = createManager({
        penaltyBlockThreshold: 2,
        penaltyEscalation: linearEscalation(1000, 500),
      });
      await km.penalty('p', 2);
      const info = km.getBlockInfo('p');
      expect(info?.expiresAt!.getTime() - Date.now()).toBe(1000);
      expect((info?.reason as { violationNumber?: number }).violationNumber).toBe(1);
      km.destroy();
    });

    it('second threshold exceed after expiry uses longer duration (exponential)', async () => {
      const { km } = createManager({
        penaltyBlockThreshold: 2,
        penaltyEscalation: exponentialEscalation(1000, 2),
        blockExpiryCheckIntervalMs: 50,
      });
      await km.penalty('p', 2);
      expect(km.getBlockInfo('p')!.expiresAt!.getTime() - Date.now()).toBe(1000);
      vi.advanceTimersByTime(1001);
      vi.runOnlyPendingTimers();
      expect(km.isBlocked('p')).toBe(false);
      await km.penalty('p', 2);
      expect(km.getBlockInfo('p')!.expiresAt!.getTime() - Date.now()).toBe(2000);
      expect((km.getBlockInfo('p')?.reason as { violationNumber?: number }).violationNumber).toBe(2);
      km.destroy();
    });

    it('resets violation count on unblock so escalation restarts', async () => {
      const { km } = createManager({
        penaltyBlockThreshold: 2,
        penaltyEscalation: exponentialEscalation(1000, 2),
      });
      await km.penalty('p', 2);
      expect((km.getBlockInfo('p')?.reason as { violationNumber?: number }).violationNumber).toBe(1);
      await km.unblock('p');
      await km.penalty('p', 2);
      expect((km.getBlockInfo('p')?.reason as { violationNumber?: number }).violationNumber).toBe(1);
      expect(km.getBlockInfo('p')!.expiresAt!.getTime() - Date.now()).toBe(1000);
      km.destroy();
    });

    it('resets violation count on delete', async () => {
      const { km } = createManager({
        penaltyBlockThreshold: 2,
        penaltyEscalation: exponentialEscalation(1000, 2),
      });
      await km.penalty('p', 2);
      expect((km.getBlockInfo('p')?.reason as { violationNumber?: number }).violationNumber).toBe(1);
      await km.delete('p');
      await km.penalty('p', 2);
      expect((km.getBlockInfo('p')?.reason as { violationNumber?: number }).violationNumber).toBe(1);
      expect(km.getBlockInfo('p')!.expiresAt!.getTime() - Date.now()).toBe(1000);
      km.destroy();
    });

    it('defaults to fixedEscalation(windowMs) when penaltyEscalation and penaltyBlockDurationMs omitted', async () => {
      const { km } = createManager({ penaltyBlockThreshold: 2 });
      await km.penalty('p', 2);
      expect(km.getBlockInfo('p')!.expiresAt!.getTime() - Date.now()).toBe(60_000);
      km.destroy();
    });

    it('uses penaltyBlockDurationMs as default fixed escalation when set', async () => {
      const { km } = createManager({
        penaltyBlockThreshold: 2,
        penaltyBlockDurationMs: 30_000,
      });
      await km.penalty('p', 2);
      expect(km.getBlockInfo('p')!.expiresAt!.getTime() - Date.now()).toBe(30_000);
      km.destroy();
    });

    it('penaltyEscalation overrides penaltyBlockDurationMs default', async () => {
      const { km } = createManager({
        penaltyBlockThreshold: 2,
        penaltyBlockDurationMs: 30_000,
        penaltyEscalation: fixedEscalation(5000),
      });
      await km.penalty('p', 2);
      expect(km.getBlockInfo('p')!.expiresAt!.getTime() - Date.now()).toBe(5000);
      km.destroy();
    });
  });

  describe('reward', () => {
    it('decrements the counter by points', async () => {
      const { km, store } = createManager();
      await store.increment('r', { cost: 5 });
      await km.reward('r', 2);
      expect((await store.get?.('r'))!.totalHits).toBe(3);
      km.destroy();
    });

    it('tracks rewardPoints separately', async () => {
      const { km } = createManager();
      await km.penalty('r', 5);
      await km.reward('r', 2);
      const g = await km.get('r');
      expect(g!.rewardPoints).toBe(2);
      km.destroy();
    });

    it('cannot drive totalHits below 0', async () => {
      const { km, store } = createManager();
      await store.increment('r', { cost: 1 });
      const state = await km.reward('r', 10);
      expect(state.totalHits).toBe(0);
      expect(await store.get?.('r')).toBeNull();
      km.destroy();
    });

    it("emits 'rewarded' event", async () => {
      const { km } = createManager();
      await km.penalty('r', 2);
      const fn = vi.fn();
      km.on('rewarded', fn);
      await km.reward('r', 1);
      expect(fn).toHaveBeenCalled();
      km.destroy();
    });
  });

  describe('delete', () => {
    it('removes store data and adjustments', async () => {
      const { km, store } = createManager();
      await km.penalty('d', 2);
      await km.delete('d');
      expect(await store.get?.('d')).toBeNull();
      expect(await km.get('d')).toBeNull();
      km.destroy();
    });

    it('removes blocks', async () => {
      const { km } = createManager();
      await km.block('d', 10_000);
      await km.delete('d');
      expect(km.isBlocked('d')).toBe(false);
      km.destroy();
    });

    it("emits 'deleted' with previous state", async () => {
      const { km } = createManager();
      const fn = vi.fn();
      km.on('deleted', fn);
      await km.set('d', 4);
      await km.delete('d');
      expect(fn).toHaveBeenCalled();
      expect(fn.mock.calls[0]![0].previousState?.totalHits).toBe(4);
      km.destroy();
    });

    it('returns false for unknown key', async () => {
      const { km } = createManager();
      await expect(km.delete('ghost')).resolves.toBe(false);
      km.destroy();
    });
  });

  describe('audit', () => {
    it('records actions', async () => {
      const { km } = createManager();
      await km.get('a');
      await km.set('a', 1);
      const log = km.getAuditLog({ key: 'a' });
      expect(log.some((e) => e.action === 'get')).toBe(true);
      expect(log.some((e) => e.action === 'set')).toBe(true);
      km.destroy();
    });

    it('filter by key', async () => {
      const { km } = createManager();
      await km.set('a', 1);
      await km.set('b', 2);
      expect(km.getAuditLog({ key: 'b' }).every((e) => e.key === 'b')).toBe(true);
      km.destroy();
    });

    it('filter by action', async () => {
      const { km } = createManager();
      await km.get('x');
      await km.set('x', 1);
      const sets = km.getAuditLog({ action: 'set' });
      expect(sets.every((e) => e.action === 'set')).toBe(true);
      km.destroy();
    });

    it('filter by since', async () => {
      const { km } = createManager();
      const t0 = new Date('2026-04-05T12:01:00.000Z');
      vi.setSystemTime(t0);
      await km.set('since', 1);
      const log = km.getAuditLog({ since: new Date('2026-04-05T12:00:30.000Z') });
      expect(log.some((e) => e.key === 'since')).toBe(true);
      km.destroy();
    });

    it('limit works', async () => {
      const { km } = createManager();
      await km.set('l', 1);
      await km.set('l', 2);
      await km.set('l', 3);
      expect(km.getAuditLog({ limit: 2 }).length).toBe(2);
      km.destroy();
    });

    it('maxAuditLogSize evicts oldest entries', async () => {
      const { km } = createManager({ maxAuditLogSize: 3 });
      await km.set('e', 1);
      await km.set('e', 2);
      await km.set('e', 3);
      await km.set('e', 4);
      const all = km.getAuditLog();
      expect(all.length).toBeLessThanOrEqual(3);
      km.destroy();
    });

    it('clearAuditLog empties the log', async () => {
      const { km } = createManager();
      await km.set('c', 1);
      km.clearAuditLog();
      expect(km.getAuditLog().length).toBe(0);
      km.destroy();
    });

    it('maxAuditLogSize 0 disables audit', async () => {
      const { km } = createManager({ maxAuditLogSize: 0 });
      await km.set('z', 1);
      expect(km.getAuditLog().length).toBe(0);
      km.destroy();
    });
  });

  describe('bulk', () => {
    it('unblockAll clears blocks and emits for each', async () => {
      const { km } = createManager();
      const fn = vi.fn();
      km.on('unblocked', fn);
      await km.block('a', 10_000);
      await km.block('b', 10_000);
      km.unblockAll();
      expect(km.getBlockedKeys().length).toBe(0);
      expect(fn.mock.calls.filter((c) => c[0].unblockedBy === 'manual').length).toBeGreaterThanOrEqual(2);
      km.destroy();
    });
  });

  describe('lifecycle', () => {
    it('destroy clears timers and allows subsequent safe noop', async () => {
      const { km } = createManager({ blockExpiryCheckIntervalMs: 100 });
      km.destroy();
      // Should not throw
      await expect(km.get('x')).resolves.toBeNull();
    });
  });
});
