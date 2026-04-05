import type { BlockReason } from './types.js';

/**
 * Persistent storage for manual block metadata — separate from rate-limit counters.
 *
 * @since 2.2.0
 */
export interface BlockStore {
  setBlock(
    key: string,
    block: { reason: BlockReason; expiresAt: Date | null; blockedAt: Date },
  ): Promise<void>;

  getBlock(key: string): Promise<{ reason: BlockReason; expiresAt: Date | null; blockedAt: Date } | null>;

  removeBlock(key: string): Promise<boolean>;

  /**
   * Lists all active blocks. Implementations may include `blockedAt` for sync consumers.
   */
  getAllBlocks(): Promise<Array<{ key: string; reason: BlockReason; expiresAt: Date | null; blockedAt?: Date }>>;

  shutdown(): Promise<void>;
}

export interface SerializedBlockPayload {
  key: string;
  reason: BlockReason;
  expiresAt: string | null;
  blockedAt: string;
}

/**
 * In-memory {@link BlockStore} for tests and single-process deployments.
 *
 * @since 2.2.0
 */
export class MemoryBlockStore implements BlockStore {
  private readonly map = new Map<
    string,
    { reason: BlockReason; expiresAt: Date | null; blockedAt: Date }
  >();

  async setBlock(
    key: string,
    block: { reason: BlockReason; expiresAt: Date | null; blockedAt: Date },
  ): Promise<void> {
    this.map.set(key, { ...block });
  }

  async getBlock(key: string): Promise<{ reason: BlockReason; expiresAt: Date | null; blockedAt: Date } | null> {
    const v = this.map.get(key);
    if (!v) {
      return null;
    }
    if (v.expiresAt !== null && v.expiresAt.getTime() <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return { ...v };
  }

  async removeBlock(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async getAllBlocks(): Promise<
    Array<{ key: string; reason: BlockReason; expiresAt: Date | null; blockedAt?: Date }>
  > {
    const now = Date.now();
    const out: Array<{ key: string; reason: BlockReason; expiresAt: Date | null; blockedAt?: Date }> = [];
    for (const [key, v] of [...this.map.entries()]) {
      if (v.expiresAt !== null && v.expiresAt.getTime() <= now) {
        this.map.delete(key);
        continue;
      }
      out.push({ key, reason: v.reason, expiresAt: v.expiresAt, blockedAt: v.blockedAt });
    }
    return out;
  }

  async shutdown(): Promise<void> {
    /* no-op: instance may be shared across KeyManagers / processes */
  }
}

/**
 * Minimal Redis client surface for {@link RedisBlockStore} (ioredis / node-redis compatible).
 *
 * @since 2.2.0
 */
export interface RedisBlockStoreClient {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  /**
   * Redis `SCAN` — ioredis-style: `scan(cursor, 'MATCH', pattern, 'COUNT', n)` → `[nextCursor, keys]`.
   */
  scan?(cursor: string, ...args: string[]): Promise<[string, string[]]>;
  /** Optional `PEXPIREAT` when not folded into `SET`. */
  pexpireat?(key: string, timestamp: number | string): Promise<unknown>;
  /** Remove TTL (permanent keys). */
  persist?(key: string): Promise<unknown>;
}

const DEFAULT_BLOCK_PREFIX = 'rlf:blocks:';

function blockRedisKey(prefix: string, logicalKey: string): string {
  return `${prefix}${logicalKey}`;
}

function parseLogicalKeyFromRedisKey(prefix: string, redisKey: string): string | null {
  if (!redisKey.startsWith(prefix)) {
    return null;
  }
  return redisKey.slice(prefix.length);
}

export function serializeBlockPayload(
  key: string,
  block: { reason: BlockReason; expiresAt: Date | null; blockedAt: Date },
): string {
  const payload: SerializedBlockPayload = {
    key,
    reason: block.reason,
    expiresAt: block.expiresAt?.toISOString() ?? null,
    blockedAt: block.blockedAt.toISOString(),
  };
  return JSON.stringify(payload);
}

export function deserializeBlockPayload(json: string): {
  key: string;
  reason: BlockReason;
  expiresAt: Date | null;
  blockedAt: Date;
} {
  const raw = JSON.parse(json) as SerializedBlockPayload;
  return {
    key: raw.key,
    reason: raw.reason,
    expiresAt: raw.expiresAt === null ? null : new Date(raw.expiresAt),
    blockedAt: new Date(raw.blockedAt),
  };
}

/**
 * Redis-backed {@link BlockStore} using keys `rlf:blocks:{key}` (prefix configurable).
 *
 * @description Pass the same {@link RedisLikeClient} instance as {@link RedisStore} so blocks share the connection.
 * @since 2.2.0
 */
export class RedisBlockStore implements BlockStore {
  private readonly client: RedisBlockStoreClient;

  private readonly keyPrefix: string;

  constructor(client: RedisBlockStoreClient, options?: { keyPrefix?: string }) {
    this.client = client;
    this.keyPrefix = options?.keyPrefix ?? DEFAULT_BLOCK_PREFIX;
  }

  async setBlock(
    key: string,
    block: { reason: BlockReason; expiresAt: Date | null; blockedAt: Date },
  ): Promise<void> {
    const rk = blockRedisKey(this.keyPrefix, key);
    const value = serializeBlockPayload(key, block);
    if (block.expiresAt !== null) {
      await this.client.set(rk, value, 'PXAT', String(block.expiresAt.getTime()));
    } else {
      await this.client.set(rk, value);
      await this.client.persist?.(rk);
    }
  }

  async getBlock(key: string): Promise<{ reason: BlockReason; expiresAt: Date | null; blockedAt: Date } | null> {
    const rk = blockRedisKey(this.keyPrefix, key);
    const raw = await this.client.get(rk);
    if (raw === null || raw === undefined) {
      return null;
    }
    try {
      return deserializeBlockPayload(raw);
    } catch {
      return null;
    }
  }

  async removeBlock(key: string): Promise<boolean> {
    const rk = blockRedisKey(this.keyPrefix, key);
    const r = await this.client.del(rk);
    if (typeof r === 'number') {
      return r > 0;
    }
    return Boolean(r);
  }

  async getAllBlocks(): Promise<
    Array<{ key: string; reason: BlockReason; expiresAt: Date | null; blockedAt?: Date }>
  > {
    const keys = await this.scanKeys(`${this.keyPrefix}*`);
    const out: Array<{ key: string; reason: BlockReason; expiresAt: Date | null; blockedAt?: Date }> = [];
    for (const rk of keys) {
      const raw = await this.client.get(rk);
      if (raw === null || raw === undefined) {
        continue;
      }
      try {
        const parsed = deserializeBlockPayload(raw);
        const logical = parseLogicalKeyFromRedisKey(this.keyPrefix, rk);
        if (logical !== null && logical !== parsed.key) {
          parsed.key = logical;
        }
        if (parsed.expiresAt !== null && parsed.expiresAt.getTime() <= Date.now()) {
          await this.client.del(rk);
          continue;
        }
        out.push({
          key: parsed.key,
          reason: parsed.reason,
          expiresAt: parsed.expiresAt,
          blockedAt: parsed.blockedAt,
        });
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }

  private async scanKeys(matchPattern: string): Promise<string[]> {
    const acc: string[] = [];
    if (this.client.scan) {
      let cursor = '0';
      do {
        const reply = await this.client.scan(cursor, 'MATCH', matchPattern, 'COUNT', '128');
        cursor = reply[0];
        acc.push(...reply[1]);
      } while (cursor !== '0');
      return acc;
    }
    throw new Error(
      'ratelimit-flex RedisBlockStore: Redis client must implement scan(cursor, "MATCH", pattern, "COUNT", n)',
    );
  }

  async shutdown(): Promise<void> {
    /* Shared client: do not quit. */
  }
}
