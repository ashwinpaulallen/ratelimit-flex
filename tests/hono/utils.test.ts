import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { resolvedHonoRollbackStatus } from '../../src/hono/utils.js';

function ctxWithStatus(status: number | undefined): Context {
  return { res: status === undefined ? undefined : { status } } as unknown as Context;
}

describe('resolvedHonoRollbackStatus', () => {
  it('returns 200 when status is 0 (unset / sentinel)', () => {
    expect(resolvedHonoRollbackStatus(ctxWithStatus(0))).toBe(200);
  });

  it('returns 200 when c.res is missing', () => {
    expect(resolvedHonoRollbackStatus({} as unknown as Context)).toBe(200);
  });

  it('returns 200 when status is out of HTTP range', () => {
    expect(resolvedHonoRollbackStatus(ctxWithStatus(99))).toBe(200);
    expect(resolvedHonoRollbackStatus(ctxWithStatus(600))).toBe(200);
    expect(resolvedHonoRollbackStatus(ctxWithStatus(Number.NaN))).toBe(200);
  });

  it('returns truncated integer for valid HTTP statuses', () => {
    expect(resolvedHonoRollbackStatus(ctxWithStatus(200))).toBe(200);
    expect(resolvedHonoRollbackStatus(ctxWithStatus(404))).toBe(404);
    expect(resolvedHonoRollbackStatus(ctxWithStatus(499.7))).toBe(499);
  });
});
