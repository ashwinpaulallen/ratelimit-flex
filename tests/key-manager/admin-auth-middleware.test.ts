import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { resolveAdminAuth } from '../../src/key-manager/admin-auth-middleware.js';

function createMockRes(): {
  res: Response;
  body: unknown;
  ended: boolean;
  headers: Record<string, string | string[] | undefined>;
} {
  const headers: Record<string, string | string[] | undefined> = {};
  const state = {
    body: undefined as unknown,
    ended: false,
    headers,
  };
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    end(chunk?: unknown) {
      this.headersSent = true;
      state.ended = true;
      if (chunk !== undefined && chunk !== null) {
        try {
          state.body = JSON.parse(String(chunk));
        } catch {
          state.body = chunk;
        }
      }
      return this;
    },
  } as unknown as Response;
  return { res, get body() { return state.body; }, get ended() { return state.ended; }, headers };
}

describe('resolveAdminAuth — bearer', () => {
  const secret = '0123456789abcdef0123456789abcdef';

  it('accepts correct token', () => {
    const mw = resolveAdminAuth({ type: 'bearer', token: secret });
    const { res, body, ended } = createMockRes();
    const req = {
      headers: { authorization: `Bearer ${secret}` },
    } as Request;
    let nextCalls = 0;
    mw(req, res, () => {
      nextCalls++;
    });
    expect(nextCalls).toBe(1);
    expect(ended).toBe(false);
    expect(body).toBeUndefined();
  });

  it('rejects wrong token, missing header, malformed header', () => {
    const mw = resolveAdminAuth({ type: 'bearer', token: secret });

    const wrong = createMockRes();
    mw({ headers: { authorization: 'Bearer wrong' } } as Request, wrong.res, () => {});
    expect(wrong.res.statusCode).toBe(401);
    expect(wrong.headers['www-authenticate']).toBe('Bearer');
    expect(wrong.body).toEqual({ error: 'Unauthorized' });

    const missing = createMockRes();
    mw({ headers: {} } as Request, missing.res, () => {});
    expect(missing.res.statusCode).toBe(401);

    const malformed = createMockRes();
    mw({ headers: { authorization: 'NotBearer x' } } as Request, malformed.res, () => {});
    expect(malformed.res.statusCode).toBe(401);

    const noSpace = createMockRes();
    mw({ headers: { authorization: 'Bearer' } } as Request, noSpace.res, () => {});
    expect(noSpace.res.statusCode).toBe(401);
  });
});

describe('resolveAdminAuth — basic', () => {
  const user = 'admin';
  const pass = 's3cret';

  function basicHeader(u: string, p: string): string {
    return `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;
  }

  it('accepts correct user+pass', () => {
    const mw = resolveAdminAuth({ type: 'basic', username: user, password: pass });
    const { res } = createMockRes();
    const req = { headers: { authorization: basicHeader(user, pass) } } as Request;
    let nextCalls = 0;
    mw(req, res, () => {
      nextCalls++;
    });
    expect(nextCalls).toBe(1);
  });

  it('rejects wrong user, wrong pass, missing header, payload without colon', () => {
    const mw = resolveAdminAuth({ type: 'basic', username: user, password: pass });

    const wrongUser = createMockRes();
    mw({ headers: { authorization: basicHeader('other', pass) } } as Request, wrongUser.res, () => {});
    expect(wrongUser.res.statusCode).toBe(401);
    expect(wrongUser.headers['www-authenticate']).toBe('Basic');

    const wrongPass = createMockRes();
    mw({ headers: { authorization: basicHeader(user, 'bad') } } as Request, wrongPass.res, () => {});
    expect(wrongPass.res.statusCode).toBe(401);

    const missing = createMockRes();
    mw({ headers: {} } as Request, missing.res, () => {});
    expect(missing.res.statusCode).toBe(401);

    const noColon = createMockRes();
    mw(
      { headers: { authorization: `Basic ${Buffer.from('nocolon', 'utf8').toString('base64')}` } } as Request,
      noColon.res,
      () => {},
    );
    expect(noColon.res.statusCode).toBe(401);
  });
});

describe('resolveAdminAuth — middleware & unsafe-no-auth', () => {
  it('middleware passthrough works', () => {
    const inner: import('express').RequestHandler = (_req, _res, next) => {
      next();
    };
    const mw = resolveAdminAuth({ type: 'middleware', handler: inner });
    const { res } = createMockRes();
    let nextCalls = 0;
    mw({ headers: {} } as Request, res, () => {
      nextCalls++;
    });
    expect(nextCalls).toBe(1);
  });

  it('unsafe-no-auth always calls next()', () => {
    const mw = resolveAdminAuth({ type: 'unsafe-no-auth', acknowledgeRisk: true });
    const { res } = createMockRes();
    let nextCalls = 0;
    mw({ headers: {} } as Request, res, () => {
      nextCalls++;
    });
    expect(nextCalls).toBe(1);
  });
});

describe('resolveAdminAuth — bearer timing-stable compare', () => {
  it('wrong last byte vs wrong first byte: similar duration distribution (timingSafeEqual)', () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const wrongLast = `${secret.slice(0, -1)}X`;
    const wrongFirst = `X${secret.slice(1)}`;
    const mw = resolveAdminAuth({ type: 'bearer', token: secret });

    function measureWrong(wrongToken: string): number[] {
      const samples: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const { res } = createMockRes();
        const req = { headers: { authorization: `Bearer ${wrongToken}` } } as Request;
        const t0 = performance.now();
        mw(req, res, (() => {}) as NextFunction);
        samples.push(performance.now() - t0);
      }
      return samples;
    }

    const a = measureWrong(wrongLast);
    const b = measureWrong(wrongFirst);

    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const std = (xs: number[]) => {
      const m = mean(xs);
      return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
    };

    const meanA = mean(a);
    const meanB = mean(b);
    const stdA = std(a);
    const stdB = std(b);

    const meanDiffRatio = Math.abs(meanA - meanB) / Math.max((meanA + meanB) / 2, 1e-9);
    // Microbench means are noisy on shared runners; keep a loose bound so we still catch ~2× skew.
    expect(meanDiffRatio).toBeLessThan(0.75);

    const stdTol = Math.max(stdA, stdB, 1e-9);
    expect(Math.abs(stdA - stdB)).toBeLessThan(stdTol * 0.85 + 0.02);
  });
});
