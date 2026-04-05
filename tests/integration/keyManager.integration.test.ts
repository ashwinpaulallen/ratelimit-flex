import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { KeyManager } from '../../src/key-manager/KeyManager.js';
import { exponentialEscalation } from '../../src/key-manager/strategies.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

/**
 * Brute-force login protection with KeyManager (failed logins accumulate penalties until auto-block).
 * Store limit is set above the traffic needed so sliding-window quota does not mask penalty escalation.
 */
const WINDOW_MS = 60_000;
/** Room for 3 good + 3 bad attempts per round without hitting generic rate limit first */
const MAX_REQ = 12;

describe('KeyManager + Express login protection (integration)', () => {
  let store: MemoryStore;
  let keyManager: KeyManager;
  let app: express.Express;

  beforeEach(() => {
    vi.useFakeTimers();
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
      penaltyBlockThreshold: 3,
      penaltyEscalation: exponentialEscalation(60_000),
      syncIntervalMs: 0,
      blockExpiryCheckIntervalMs: 1000,
      maxAuditLogSize: 500,
    });

    app = express();
    app.use(express.json());
    app.use(
      expressRateLimiter({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: WINDOW_MS,
        maxRequests: MAX_REQ,
        store,
        keyManager,
        keyGenerator: () => 'test-ip',
        headers: false,
      }),
    );
    app.post('/login', async (req, res) => {
      const password = (req.body as { password?: string }).password;
      if (password === 'correct-horse') {
        res.status(200).json({ ok: true });
        return;
      }
      await keyManager.penalty('test-ip', 1);
      res.status(401).json({ error: 'Invalid credentials' });
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    keyManager.destroy();
    await store.shutdown();
  });

  it('escalating penalties, expiry, second violation, manual unblock, audit, and reward', async () => {
    const login = (body: { password: string }) =>
      request(app).post('/login').send(body).set('Content-Type', 'application/json');

    // 1) Normal logins — all allowed
    for (let i = 0; i < 3; i++) {
      const res = await login({ password: 'correct-horse' });
      expect(res.status).toBe(200);
    }

    const state = await keyManager.get('test-ip');
    expect(state).not.toBeNull();
    expect(state!.totalHits).toBe(3);
    expect(state!.remaining).toBe(MAX_REQ - 3);
    expect(state!.isBlocked).toBe(false);

    // 2) Failed logins — penalty until auto-block
    for (let i = 0; i < 2; i++) {
      const res = await login({ password: 'wrong' });
      expect(res.status).toBe(401);
      expect(keyManager.isBlocked('test-ip')).toBe(false);
    }
    const thirdBad = await login({ password: 'wrong' });
    expect(thirdBad.status).toBe(401);
    expect(keyManager.isBlocked('test-ip')).toBe(true);

    // Next HTTP request: middleware short-circuits (KeyManager block)
    const blockedRes = await login({ password: 'correct-horse' });
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body).toMatchObject({
      blocked: true,
      reason: 'penalty-escalation',
    });

    // 3) First block duration: 60s (violation 1)
    const exp1 = keyManager.getBlockInfo('test-ip')!.expiresAt!.getTime();
    expect(exp1 - Date.now()).toBe(60_000);

    vi.advanceTimersByTime(60_001);
    await vi.runOnlyPendingTimersAsync();
    expect(keyManager.isBlocked('test-ip')).toBe(false);

    const afterExpiry = await login({ password: 'correct-horse' });
    expect(afterExpiry.status).toBe(200);

    // 4) Second round of failures — second violation → 120s block
    for (let i = 0; i < 2; i++) {
      await login({ password: 'wrong' });
      expect(keyManager.isBlocked('test-ip')).toBe(false);
    }
    await login({ password: 'wrong' });
    expect(keyManager.isBlocked('test-ip')).toBe(true);

    const exp2 = keyManager.getBlockInfo('test-ip')!.expiresAt!.getTime();
    expect(exp2 - Date.now()).toBe(120_000);

    expect((await login({ password: 'correct-horse' })).status).toBe(429);

    // 5) Manual unblock — violation count reset, traffic flows
    await keyManager.unblock('test-ip');
    expect(keyManager.isBlocked('test-ip')).toBe(false);

    const afterManual = await login({ password: 'correct-horse' });
    expect(afterManual.status).toBe(200);

    // 6) Audit trail — penalty×3 → block → unblock (expiry) → penalty×3 → block → unblock (manual).
    // `getAuditLog` returns newest-first; reverse to chronological (append order). Fake timers often share one `Date`, so sorting by timestamp is unstable.
    // Manual `unblock()` records only `wasReason`; expiry unblock sets `unblockedBy: 'expiry'`.
    const audit = keyManager.getAuditLog({ key: 'test-ip', limit: 200 }).filter((e) => e.action !== 'get');
    const chronological = [...audit].reverse();
    const story = chronological.map((e) => e.action);
    expect(story.join(',')).toMatch(
      /^(penalty,){3}block,unblock,(penalty,){3}block,unblock$/,
    );

    expect(story.filter((a) => a === 'penalty').length).toBe(6);
    expect(story.filter((a) => a === 'block').length).toBe(2);

    const unblockEntries = chronological.filter((e) => e.action === 'unblock');
    expect(unblockEntries.filter((e) => (e.details as { unblockedBy?: string }).unblockedBy === 'expiry')).toHaveLength(
      1,
    );
    expect(
      unblockEntries.filter(
        (e) =>
          !(e.details as { unblockedBy?: string; bulk?: boolean }).unblockedBy &&
          (e.details as { bulk?: boolean }).bulk !== true,
      ),
    ).toHaveLength(1);

    // 7) Reward after CAPTCHA — headroom back
    const beforeReward = await keyManager.get('test-ip');
    expect(beforeReward).not.toBeNull();
    const remBefore = beforeReward!.remaining;
    await keyManager.reward('test-ip', 2);
    const afterReward = await keyManager.get('test-ip');
    expect(afterReward!.remaining).toBe(remBefore + 2);
  });
});
