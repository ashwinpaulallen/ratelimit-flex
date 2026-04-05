import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryBlockStore,
  RedisBlockStore,
  deserializeBlockPayload,
  serializeBlockPayload,
} from '../../src/key-manager/block-store.js';
import type { RedisBlockStoreClient } from '../../src/key-manager/block-store.js';

/**
 * In-memory mock with TTL semantics for GET (Redis-like).
 */
function createMockRedis(): RedisBlockStoreClient {
  const data = new Map<string, { value: string; expiresAtMs: number | null }>();

  const client: RedisBlockStoreClient = {
    async get(key: string) {
      const e = data.get(key);
      if (!e) {
        return null;
      }
      if (e.expiresAtMs !== null && Date.now() >= e.expiresAtMs) {
        data.delete(key);
        return null;
      }
      return e.value;
    },
    async set(key: string, value: string, ...args: unknown[]) {
      let expiresAtMs: number | null = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === 'PXAT' && typeof args[i + 1] === 'string') {
          expiresAtMs = Number(args[i + 1]);
        }
      }
      if (args.length === 0) {
        expiresAtMs = null;
      }
      data.set(key, { value, expiresAtMs });
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) {
        if (data.delete(k)) {
          n += 1;
        }
      }
      return n;
    },
    async scan(cursor: string, ...args: string[]) {
      const matchIdx = args.indexOf('MATCH');
      const pattern = matchIdx >= 0 ? args[matchIdx + 1] : '*';
      const prefix = pattern.replace(/\*$/, '');
      const keys: string[] = [];
      for (const k of data.keys()) {
        if (k.startsWith(prefix)) {
          keys.push(k);
        }
      }
      return ['0', keys] as [string, string[]];
    },
    async persist(key: string) {
      const e = data.get(key);
      if (e) {
        e.expiresAtMs = null;
      }
    },
  };

  return client;
}

describe('RedisBlockStore (mock Redis)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves blocks', async () => {
    const client = createMockRedis();
    const store = new RedisBlockStore(client);
    const blockedAt = new Date('2026-04-05T12:00:00.000Z');
    await store.setBlock('user-1', {
      reason: { type: 'manual', message: 'x' },
      expiresAt: new Date('2026-04-05T13:00:00.000Z'),
      blockedAt,
    });
    const g = await store.getBlock('user-1');
    expect(g).not.toBeNull();
    expect(g!.reason).toEqual({ type: 'manual', message: 'x' });
    expect(g!.blockedAt.toISOString()).toBe(blockedAt.toISOString());
    expect(g!.expiresAt?.toISOString()).toBe('2026-04-05T13:00:00.000Z');
  });

  it('removeBlock deletes the key', async () => {
    const client = createMockRedis();
    const store = new RedisBlockStore(client);
    const t = new Date();
    await store.setBlock('k', { reason: { type: 'manual' }, expiresAt: null, blockedAt: t });
    expect(await store.removeBlock('k')).toBe(true);
    expect(await store.getBlock('k')).toBeNull();
  });

  it('getAllBlocks lists entries via SCAN', async () => {
    const client = createMockRedis();
    const store = new RedisBlockStore(client);
    const t = new Date();
    await store.setBlock('a', { reason: { type: 'manual' }, expiresAt: null, blockedAt: t });
    await store.setBlock('b', { reason: { type: 'abuse-pattern', pattern: 'x' }, expiresAt: null, blockedAt: t });
    const all = await store.getAllBlocks();
    expect(all.map((e) => e.key).sort()).toEqual(['a', 'b']);
  });

  it('respects TTL — block disappears after expiry', async () => {
    const client = createMockRedis();
    const store = new RedisBlockStore(client);
    await store.setBlock('k', {
      reason: { type: 'manual' },
      expiresAt: new Date('2026-04-05T12:00:05.000Z'),
      blockedAt: new Date(),
    });
    expect(await store.getBlock('k')).not.toBeNull();
    vi.setSystemTime(new Date('2026-04-05T12:00:06.000Z'));
    expect(await store.getBlock('k')).toBeNull();
  });

  it('serializeBlockPayload round-trips', () => {
    const blockedAt = new Date('2026-01-02T03:04:05.000Z');
    const json = serializeBlockPayload('key1', {
      reason: { type: 'penalty-escalation', penaltyCount: 3, threshold: 2 },
      expiresAt: null,
      blockedAt,
    });
    const back = deserializeBlockPayload(json);
    expect(back.key).toBe('key1');
    expect(back.reason).toEqual({ type: 'penalty-escalation', penaltyCount: 3, threshold: 2 });
    expect(back.expiresAt).toBeNull();
    expect(back.blockedAt.toISOString()).toBe(blockedAt.toISOString());
  });
});

describe('MemoryBlockStore', () => {
  it('implements BlockStore', async () => {
    const m = new MemoryBlockStore();
    const t = new Date();
    await m.setBlock('x', { reason: { type: 'manual' }, expiresAt: null, blockedAt: t });
    const list = await m.getAllBlocks();
    expect(list).toHaveLength(1);
    expect(list[0]!.key).toBe('x');
    await m.shutdown();
  });
});
