import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyManager } from '../../src/key-manager/KeyManager.js';
import { MemoryBlockStore } from '../../src/key-manager/block-store.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

function createStorePair() {
  const rateStore = new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 10,
  });
  const blockStore = new MemoryBlockStore();
  return { rateStore, blockStore };
}

describe('KeyManager + blockStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('block() persists to blockStore', async () => {
    const { rateStore, blockStore } = createStorePair();
    const km = new KeyManager({
      store: rateStore,
      maxRequests: 10,
      windowMs: 60_000,
      blockStore,
      syncIntervalMs: 0,
    });
    await km.block('ip-1', 3600_000, { type: 'manual', message: 'abuse' });
    const stored = await blockStore.getBlock('ip-1');
    expect(stored).not.toBeNull();
    expect(stored!.reason.type).toBe('manual');
    expect(stored!.reason).toMatchObject({ message: 'abuse' });
    km.destroy();
    await rateStore.shutdown();
  });

  it('syncBlocks pulls remote blocks into local map', async () => {
    const { rateStore, blockStore } = createStorePair();
    const km = new KeyManager({
      store: rateStore,
      maxRequests: 10,
      windowMs: 60_000,
      blockStore,
      syncIntervalMs: 0,
    });
    const blockedAt = new Date();
    await blockStore.setBlock('remote', {
      reason: { type: 'custom', code: 'x' },
      expiresAt: new Date('2026-04-06T12:00:00.000Z'),
      blockedAt,
    });
    expect(km.isBlocked('remote')).toBe(false);
    await km.syncBlocks();
    expect(km.isBlocked('remote')).toBe(true);
    expect(km.getBlockInfo('remote')?.reason).toEqual({ type: 'custom', code: 'x' });
    km.destroy();
    await rateStore.shutdown();
  });

  it('second KeyManager sees block after sync (simulated other process)', async () => {
    const { rateStore, blockStore } = createStorePair();
    const km1 = new KeyManager({
      store: rateStore,
      maxRequests: 10,
      windowMs: 60_000,
      blockStore,
      syncIntervalMs: 0,
    });
    const rateStore2 = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const km2 = new KeyManager({
      store: rateStore2,
      maxRequests: 10,
      windowMs: 60_000,
      blockStore,
      syncIntervalMs: 0,
    });

    await km1.block('shared-key', 60_000, { type: 'manual' });
    expect(km2.isBlocked('shared-key')).toBe(false);
    await km2.syncBlocks();
    expect(km2.isBlocked('shared-key')).toBe(true);

    km1.destroy();
    km2.destroy();
    await rateStore.shutdown();
    await rateStore2.shutdown();
  });

  it('unblock propagates removeBlock to blockStore', async () => {
    const { rateStore, blockStore } = createStorePair();
    const km = new KeyManager({
      store: rateStore,
      maxRequests: 10,
      windowMs: 60_000,
      blockStore,
      syncIntervalMs: 0,
    });
    await km.block('k', 60_000, { type: 'manual' });
    expect(await blockStore.getBlock('k')).not.toBeNull();
    await km.unblock('k');
    expect(await blockStore.getBlock('k')).toBeNull();
    km.destroy();
    await rateStore.shutdown();
  });
});
