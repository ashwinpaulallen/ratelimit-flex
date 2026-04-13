import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { AdminAuthMode, AdminAuthMiddleware } from './admin-auth.js';

/**
 * Resolve an AdminAuthMode into an Express middleware function.
 * This is the single entry point all adapters use.
 */
export function resolveAdminAuth(mode: AdminAuthMode): AdminAuthMiddleware {
  switch (mode.type) {
    case 'bearer':
      return createBearerAuth(mode.token);
    case 'basic':
      return createBasicAuth(mode.username, mode.password);
    case 'middleware':
      return mode.handler;
    case 'unsafe-no-auth':
      return (_req, _res, next) => next();
  }
}

/**
 * Bearer token auth. Uses timing-safe comparison to prevent token leakage
 * via response-time side channels.
 */
function createBearerAuth(expectedToken: string): AdminAuthMiddleware {
  const expected = Buffer.from(expectedToken, 'utf8');

  return (req, res, next) => {
    const header = req.headers?.authorization;
    if (!header || typeof header !== 'string') {
      return sendUnauthorized(res, 'Bearer');
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const tokenPart = match?.[1];
    if (!tokenPart) {
      return sendUnauthorized(res, 'Bearer');
    }
    const actual = Buffer.from(tokenPart, 'utf8');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return sendUnauthorized(res, 'Bearer');
    }
    next();
  };
}

/**
 * HTTP Basic auth. Timing-safe comparison for both username and password.
 */
function createBasicAuth(
  expectedUser: string,
  expectedPass: string,
): AdminAuthMiddleware {
  const expectedUserBuf = Buffer.from(expectedUser, 'utf8');
  const expectedPassBuf = Buffer.from(expectedPass, 'utf8');

  return (req, res, next) => {
    const header = req.headers?.authorization;
    if (!header || typeof header !== 'string') {
      return sendUnauthorized(res, 'Basic');
    }
    const match = /^Basic\s+(.+)$/i.exec(header);
    const b64 = match?.[1];
    if (!b64) {
      return sendUnauthorized(res, 'Basic');
    }
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      return sendUnauthorized(res, 'Basic');
    }
    const user = Buffer.from(decoded.slice(0, colonIdx), 'utf8');
    const pass = Buffer.from(decoded.slice(colonIdx + 1), 'utf8');

    const userOk =
      user.length === expectedUserBuf.length &&
      timingSafeEqual(user, expectedUserBuf);
    const passOk =
      pass.length === expectedPassBuf.length &&
      timingSafeEqual(pass, expectedPassBuf);

    // IMPORTANT: always evaluate both comparisons before branching, even if
    // the username fails, to prevent timing side channels from distinguishing
    // "bad user" from "bad password".
    if (!userOk || !passOk) {
      return sendUnauthorized(res, 'Basic');
    }
    next();
  };
}

function sendUnauthorized(res: Response, scheme: 'Bearer' | 'Basic'): void {
  if (res.headersSent) {
    return;
  }
  res.setHeader('WWW-Authenticate', scheme);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 401;
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}
