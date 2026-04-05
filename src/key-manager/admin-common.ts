import type { KeyManager } from './KeyManager.js';
import type { AuditEntry, BlockReason, KeyState } from './types.js';

const AUDIT_ACTIONS = new Set<AuditEntry['action']>([
  'block',
  'unblock',
  'penalty',
  'reward',
  'set',
  'delete',
  'get',
]);

/** JSON-safe {@link KeyState} (dates as ISO strings). */
export function keyStateToJson(state: KeyState): Record<string, unknown> {
  return {
    key: state.key,
    totalHits: state.totalHits,
    remaining: state.remaining,
    resetTime: state.resetTime.toISOString(),
    isBlocked: state.isBlocked,
    isManuallyBlocked: state.isManuallyBlocked,
    blockReason: state.blockReason,
    blockExpiresAt:
      state.blockExpiresAt === undefined
        ? undefined
        : state.blockExpiresAt === null
          ? null
          : state.blockExpiresAt.toISOString(),
    penaltyPoints: state.penaltyPoints,
    rewardPoints: state.rewardPoints,
  };
}

export function auditEntryToJson(e: AuditEntry): Record<string, unknown> {
  return {
    timestamp: e.timestamp.toISOString(),
    key: e.key,
    action: e.action,
    details: e.details,
    actor: e.actor,
  };
}

export function resolveActorFromRequest(
  req: { body?: unknown; user?: unknown },
  body: { actor?: string } | undefined,
): string | undefined {
  if (body?.actor !== undefined && String(body.actor).length > 0) {
    return String(body.actor);
  }
  const u = req.user;
  if (u !== null && typeof u === 'object') {
    const rec = u as Record<string, unknown>;
    if (typeof rec.sub === 'string' && rec.sub.length > 0) {
      return rec.sub;
    }
    if (typeof rec.id === 'string' && rec.id.length > 0) {
      return rec.id;
    }
    if (typeof rec.username === 'string' && rec.username.length > 0) {
      return rec.username;
    }
  }
  return undefined;
}

export function parseBlockReason(value: unknown): { ok: true; reason: BlockReason } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, reason: { type: 'manual' } };
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return { ok: false, error: 'reason must be an object with a type field' };
  }
  const o = value as Record<string, unknown>;
  const t = o.type;
  if (t === 'manual') {
    return { ok: true, reason: { type: 'manual', ...(typeof o.message === 'string' ? { message: o.message } : {}) } };
  }
  if (t === 'penalty-escalation') {
    const penaltyCount = o.penaltyCount;
    const threshold = o.threshold;
    if (typeof penaltyCount !== 'number' || typeof threshold !== 'number') {
      return { ok: false, error: 'penalty-escalation requires numeric penaltyCount and threshold' };
    }
    return {
      ok: true,
      reason: {
        type: 'penalty-escalation',
        penaltyCount,
        threshold,
        ...(typeof o.violationNumber === 'number' ? { violationNumber: o.violationNumber } : {}),
      },
    };
  }
  if (t === 'abuse-pattern') {
    if (typeof o.pattern !== 'string') {
      return { ok: false, error: 'abuse-pattern requires pattern string' };
    }
    return { ok: true, reason: { type: 'abuse-pattern', pattern: o.pattern } };
  }
  if (t === 'custom') {
    if (typeof o.code !== 'string') {
      return { ok: false, error: 'custom requires code string' };
    }
    return {
      ok: true,
      reason: {
        type: 'custom',
        code: o.code,
        ...(typeof o.metadata === 'object' && o.metadata !== null ? { metadata: o.metadata as Record<string, unknown> } : {}),
      },
    };
  }
  return { ok: false, error: `unknown reason type: ${String(t)}` };
}

export function parseAuditQuery(query: Record<string, string | string[] | undefined>): { ok: true; filter: Parameters<KeyManager['getAuditLog']>[0] } | { ok: false; error: string } {
  const filter: Parameters<KeyManager['getAuditLog']>[0] = {};
  const key = query.key;
  if (typeof key === 'string' && key.length > 0) {
    filter.key = key;
  }
  const action = query.action;
  if (typeof action === 'string' && action.length > 0) {
    if (!AUDIT_ACTIONS.has(action as AuditEntry['action'])) {
      return { ok: false, error: `invalid action: ${action}` };
    }
    filter.action = action as AuditEntry['action'];
  }
  const since = query.since;
  if (typeof since === 'string' && since.length > 0) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, error: 'since must be a valid ISO date string' };
    }
    filter.since = d;
  }
  const limit = query.limit;
  if (typeof limit === 'string' && limit.length > 0) {
    const n = Number.parseInt(limit, 10);
    if (!Number.isFinite(n) || n < 1 || n > 10_000) {
      return { ok: false, error: 'limit must be between 1 and 10000' };
    }
    filter.limit = n;
  }
  return { ok: true, filter };
}

export async function adminGetKey(
  km: KeyManager,
  key: string,
  actor: string | undefined,
): Promise<{ status: number; body: unknown }> {
  const state = await km.get(key, { actor });
  if (state === null) {
    return { status: 404, body: { error: 'Not found' } };
  }
  return { status: 200, body: { state: keyStateToJson(state) } };
}

export async function adminPostBlock(
  km: KeyManager,
  key: string,
  rawBody: unknown,
  actor: string | undefined,
): Promise<{ status: number; body: unknown }> {
  if (rawBody === null || typeof rawBody !== 'object') {
    return { status: 400, body: { error: 'Expected JSON body' } };
  }
  const body = rawBody as Record<string, unknown>;
  const durationMs = body.durationMs;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return { status: 400, body: { error: 'durationMs must be a non-negative finite number' } };
  }
  const pr = parseBlockReason(body.reason);
  if (!pr.ok) {
    return { status: 400, body: { error: pr.error } };
  }
  const state = await km.block(key, durationMs, pr.reason, { actor });
  return { status: 200, body: { state: keyStateToJson(state) } };
}

export async function adminPostUnblock(
  km: KeyManager,
  key: string,
  actor: string | undefined,
): Promise<{ status: number; body: unknown }> {
  const state = await km.unblock(key, { actor });
  if (state === null) {
    return { status: 404, body: { error: 'Not found' } };
  }
  return { status: 200, body: { state: keyStateToJson(state) } };
}

export async function adminPostPenalty(
  km: KeyManager,
  key: string,
  rawBody: unknown,
  actor: string | undefined,
): Promise<{ status: number; body: unknown }> {
  let points = 1;
  if (rawBody !== null && rawBody !== undefined) {
    if (typeof rawBody !== 'object') {
      return { status: 400, body: { error: 'Expected JSON object body' } };
    }
    const body = rawBody as Record<string, unknown>;
    if (body.points !== undefined) {
      if (typeof body.points !== 'number' || !Number.isFinite(body.points) || body.points < 1) {
        return { status: 400, body: { error: 'points must be a finite number >= 1' } };
      }
      points = Math.floor(body.points);
    }
  }
  const state = await km.penalty(key, points, { actor });
  return { status: 200, body: { state: keyStateToJson(state) } };
}

export async function adminPostReward(
  km: KeyManager,
  key: string,
  rawBody: unknown,
  actor: string | undefined,
): Promise<{ status: number; body: unknown }> {
  let points = 1;
  if (rawBody !== null && rawBody !== undefined) {
    if (typeof rawBody !== 'object') {
      return { status: 400, body: { error: 'Expected JSON object body' } };
    }
    const body = rawBody as Record<string, unknown>;
    if (body.points !== undefined) {
      if (typeof body.points !== 'number' || !Number.isFinite(body.points) || body.points < 1) {
        return { status: 400, body: { error: 'points must be a finite number >= 1' } };
      }
      points = Math.floor(body.points);
    }
  }
  const state = await km.reward(key, points, { actor });
  return { status: 200, body: { state: keyStateToJson(state) } };
}

export async function adminPostSet(
  km: KeyManager,
  key: string,
  rawBody: unknown,
  actor: string | undefined,
): Promise<{ status: number; body: unknown }> {
  if (rawBody === null || typeof rawBody !== 'object') {
    return { status: 400, body: { error: 'Expected JSON body' } };
  }
  const body = rawBody as Record<string, unknown>;
  const totalHits = body.totalHits;
  if (typeof totalHits !== 'number' || !Number.isFinite(totalHits) || totalHits < 0) {
    return { status: 400, body: { error: 'totalHits must be a non-negative finite number' } };
  }
  let expiresAt: Date | undefined;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (typeof body.expiresAt !== 'string') {
      return { status: 400, body: { error: 'expiresAt must be an ISO date string' } };
    }
    const d = new Date(body.expiresAt);
    if (Number.isNaN(d.getTime())) {
      return { status: 400, body: { error: 'expiresAt must be a valid ISO date string' } };
    }
    expiresAt = d;
  }
  const state = await km.set(key, Math.floor(totalHits), expiresAt, { actor });
  return { status: 200, body: { state: keyStateToJson(state) } };
}

export async function adminDeleteKey(
  km: KeyManager,
  key: string,
  actor: string | undefined,
): Promise<{ status: number; body: unknown }> {
  const existed = await km.delete(key, { actor });
  if (!existed) {
    return { status: 404, body: { error: 'Not found' } };
  }
  return { status: 200, body: { deleted: true } };
}

export function adminGetBlocks(km: KeyManager): { status: number; body: unknown } {
  const rows = km.getBlockedKeys().map((e) => ({
    key: e.key,
    reason: e.reason,
    expiresAt: e.expiresAt === null ? null : e.expiresAt.toISOString(),
  }));
  return { status: 200, body: rows };
}

export function adminPostBlocksClear(km: KeyManager, actor: string | undefined): { status: number; body: unknown } {
  const n = km.getBlockedKeys().length;
  km.unblockAll({ actor });
  return { status: 200, body: { cleared: n } };
}

export function decodeKeyParam(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === '') {
    return '';
  }
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function adminGetAudit(
  km: KeyManager,
  query: Record<string, string | string[] | undefined>,
): { status: number; body: unknown } {
  const parsed = parseAuditQuery(query);
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error } };
  }
  const entries = km.getAuditLog(parsed.filter).map(auditEntryToJson);
  return { status: 200, body: entries };
}
