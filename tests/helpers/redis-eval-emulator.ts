/**
 * In-memory Redis subset for {@link RedisStore} tests (no real Redis / Lua runtime).
 */

import type { RedisLikeClient } from '../../src/stores/redis-store.js';

type ZMember = { member: string; score: number };

export function createRedisEvalEmulator(): RedisLikeClient {
  const zsets = new Map<string, ZMember[]>();
  const strings = new Map<string, { value: string; pxatMs: number }>();
  const hashes = new Map<string, Record<string, string>>();

  const nowMs = () => Date.now();

  function getStringKey(k: string): { value: string; pxatMs: number } | undefined {
    const e = strings.get(k);
    if (!e) {
      return undefined;
    }
    if (nowMs() >= e.pxatMs) {
      strings.delete(k);
      return undefined;
    }
    return e;
  }

  return {
    get: async (key: string) => {
      const e = getStringKey(key);
      return e?.value ?? null;
    },

    set: async (key: string, value: string, ...args: unknown[]) => {
      let pxatMs: number | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === 'PXAT' && typeof args[i + 1] === 'string') {
          pxatMs = Number(args[i + 1]);
          i++;
        } else if (args[i] === 'PX' && typeof args[i + 1] === 'string') {
          pxatMs = nowMs() + Number(args[i + 1]);
          i++;
        }
      }
      if (pxatMs === undefined) {
        throw new Error('emulator set requires PX or PXAT');
      }
      strings.set(key, { value, pxatMs });
      return 'OK';
    },

    del: async (...delKeys: string[]) => {
      let n = 0;
      for (const k of delKeys) {
        if (zsets.delete(k)) {
          n++;
        }
        if (strings.delete(k)) {
          n++;
        }
        if (hashes.delete(k)) {
          n++;
        }
      }
      return n;
    },

    eval: async (script: string, numKeys: number, ...rest: string[]) => {
      const keys = rest.slice(0, numKeys);
      const argv = rest.slice(numKeys);

      // --- Sliding window increment ---
      if (script.includes('--rlf:si')) {
        const zkey = keys[0]!;
        const now = Number(argv[0]);
        const windowMs = Number(argv[1]);
        const maxReq = Number(argv[2]);
        const cost = Math.max(1, Number(argv[3]) || 1);
        let members = zsets.get(zkey) ?? [];
        members = members.filter((m) => m.score > now - windowMs);
        for (let i = 0; i < cost; i++) {
          const m = argv[4 + i];
          if (m === undefined) {
            throw new Error('missing member');
          }
          members.push({ member: m, score: now });
        }
        zsets.set(zkey, members);
        const count = members.length;
        const blocked = count > maxReq ? 1 : 0;
        let oldestScore = now;
        if (count > 0) {
          oldestScore = [...members].sort((a, b) => a.score - b.score)[0]!.score;
        }
        const resetAt = oldestScore + windowMs;
        return [count, blocked, resetAt];
      }

      // --- Sliding window get (read-only) ---
      if (script.includes('--rlf:sg')) {
        const zkey = keys[0]!;
        const now = Number(argv[0]);
        const windowMs = Number(argv[1]);
        const maxReq = Number(argv[2]);
        const members = zsets.get(zkey) ?? [];
        const inWindow = members.filter((m) => m.score > now - windowMs);
        const count = inWindow.length;
        if (count === 0) {
          return null;
        }
        const blocked = count > maxReq ? 1 : 0;
        const oldestScore = [...inWindow].sort((a, b) => a.score - b.score)[0]!.score;
        const resetAt = oldestScore + windowMs;
        return [count, blocked, resetAt];
      }

      // --- Sliding window set ---
      if (script.includes('--rlf:ss')) {
        const zkey = keys[0]!;
        const now = Number(argv[0]);
        const windowMs = Number(argv[1]);
        const maxReq = Number(argv[2]);
        const totalHits = Math.max(0, Number(argv[3]) || 0);
        const expireArg = Number(argv[4]);
        zsets.delete(zkey);
        const members: ZMember[] = [];
        for (let i = 0; i < totalHits; i++) {
          const m = argv[5 + i];
          if (m === undefined) {
            throw new Error('sliding set missing member');
          }
          members.push({ member: m, score: now });
        }
        zsets.set(zkey, members);
        const count = members.length;
        if (count === 0) {
          return [0, 0, now + windowMs];
        }
        const blocked = count > maxReq ? 1 : 0;
        const oldestScore = [...members].sort((a, b) => a.score - b.score)[0]!.score;
        const resetAt = oldestScore + windowMs;
        void expireArg;
        return [count, blocked, resetAt];
      }

      // --- Sliding window decrement (ZPOPMIN / ZPOPMAX) ---
      if (script.includes('--rlf:sd')) {
        const zkey = keys[0]!;
        const cost = Math.max(1, Number(argv[0]) || 1);
        const newest = argv[1] === '1';
        const members = zsets.get(zkey) ?? [];
        members.sort((a, b) => a.score - b.score);
        for (let i = 0; i < cost && members.length > 0; i++) {
          if (newest) {
            members.pop();
          } else {
            members.shift();
          }
        }
        if (members.length === 0) {
          zsets.delete(zkey);
        } else {
          zsets.set(zkey, members);
        }
        return 1;
      }

      // --- Fixed window increment ---
      if (script.includes('--rlf:fi')) {
        const k = keys[0]!;
        const windowMs = Number(argv[0]);
        const maxReq = Number(argv[1]);
        const now = Number(argv[2]);
        const cost = Math.max(1, Number(argv[3]) || 1);
        const prev = getStringKey(k);
        const base = prev ? Number(prev.value) : 0;
        const current = base + cost;
        const first = prev === undefined;
        strings.set(k, {
          value: String(current),
          pxatMs: first ? now + windowMs : prev!.pxatMs,
        });
        const pttl = strings.get(k)!.pxatMs - now;
        const resetAt = now + Math.max(0, pttl);
        const blocked = current > maxReq ? 1 : 0;
        return [current, blocked, resetAt];
      }

      // --- Fixed window decrement ---
      if (script.includes('--rlf:fd')) {
        const k = keys[0]!;
        const dec = Math.max(1, Number(argv[0]) || 1);
        const prev = getStringKey(k);
        if (!prev) {
          return 0;
        }
        const v = Number(prev.value);
        if (v <= 0) {
          return v;
        }
        const take = Math.min(v, dec);
        const next = v - take;
        if (next <= 0) {
          strings.delete(k);
        } else {
          strings.set(k, { value: String(next), pxatMs: prev.pxatMs });
        }
        return v;
      }

      // --- Fixed window get ---
      if (script.includes('--rlf:fg')) {
        const k = keys[0]!;
        const maxReq = Number(argv[1]);
        const now = Number(argv[2]);
        const prev = getStringKey(k);
        if (!prev) {
          return null;
        }
        const current = Number(prev.value);
        const pttl = prev.pxatMs - now;
        const resetAt = now + Math.max(0, pttl);
        const blocked = current > maxReq ? 1 : 0;
        return [current, blocked, resetAt];
      }

      // --- Token bucket increment ---
      if (script.includes('--rlf:bi')) {
        const key = keys[0]!;
        const now = Number(argv[0]);
        const tpi = Number(argv[1]);
        const intervalMs = Number(argv[2]);
        const bucketSize = Number(argv[3]);
        const cost = Math.max(1, Number(argv[4]) || 1);

        let tokens: number;
        let lastRefill: number;

        const h = hashes.get(key);
        if (!h) {
          tokens = bucketSize;
          lastRefill = now;
        } else {
          tokens = Number(h.tokens);
          lastRefill = Number(h.last_refill);
        }

        const elapsed = now - lastRefill;
        const intervals = Math.floor(elapsed / intervalMs);
        if (intervals > 0) {
          tokens = Math.min(bucketSize, tokens + intervals * tpi);
          lastRefill += intervals * intervalMs;
        }

        if (tokens >= cost) {
          tokens -= cost;
          hashes.set(key, {
            tokens: String(tokens),
            last_refill: String(lastRefill),
          });
          const remaining = tokens;
          const totalHits = bucketSize - remaining;
          const nextTick = lastRefill + intervalMs;
          return [1, remaining, totalHits, 0, nextTick];
        }

        hashes.set(key, {
          tokens: String(tokens),
          last_refill: String(lastRefill),
        });
        const nextRefill = lastRefill + intervalMs;
        return [0, tokens, bucketSize, 1, nextRefill];
      }

      // --- Token bucket decrement ---
      if (script.includes('--rlf:bd')) {
        const key = keys[0]!;
        const bucketSize = Number(argv[0]);
        const add = Math.max(1, Number(argv[1]) || 1);
        const h = hashes.get(key);
        if (!h) {
          return 0;
        }
        let tokens = Number(h.tokens);
        tokens = Math.min(bucketSize, tokens + add);
        hashes.set(key, { ...h, tokens: String(tokens) });
        return 1;
      }

      // --- Token bucket get ---
      if (script.includes('--rlf:bg')) {
        const key = keys[0]!;
        const now = Number(argv[0]);
        const tpi = Number(argv[1]);
        const intervalMs = Number(argv[2]);
        const bucketSize = Number(argv[3]);

        const h = hashes.get(key);
        if (!h) {
          return null;
        }

        let tokens = Number(h.tokens);
        let lastRefill = Number(h.last_refill);

        const elapsed = now - lastRefill;
        const intervals = Math.floor(elapsed / intervalMs);
        if (intervals > 0) {
          tokens = Math.min(bucketSize, tokens + intervals * tpi);
          lastRefill += intervals * intervalMs;
        }

        const remaining = tokens;
        const totalHits = bucketSize - remaining;
        const blocked = remaining === 0 && totalHits >= bucketSize ? 1 : 0;
        const nextTick = lastRefill + intervalMs;
        return [remaining, totalHits, blocked, nextTick];
      }

      // --- Token bucket sync (set) ---
      if (script.includes('--rlf:bs')) {
        const k = keys[0]!;
        const tokens = Number(argv[0]);
        const lastRefill = Number(argv[1]);
        const intervalMs = Number(argv[2]);
        hashes.set(k, {
          tokens: String(tokens),
          last_refill: String(lastRefill),
        });
        void intervalMs;
        return 1;
      }

      throw new Error('redis-eval-emulator: unhandled script');
    },

    flushdb: async () => {
      zsets.clear();
      strings.clear();
      hashes.clear();
    },
  };
}

export type RedisEvalEmulatorClient = RedisLikeClient & {
  flushdb(): Promise<void>;
};
