import { describe, expect, it } from 'vitest';
import {
  AdminAuthRequiredError,
  assertAdminRouterOptions,
  type AdminAuthMiddleware,
  type AdminAuthMode,
  type AdminRouterOptions,
} from '../../src/key-manager/admin-auth.js';

describe('AdminAuthRequiredError', () => {
  it('has a stable name and documents required auth strategies and docs link', () => {
    const err = new AdminAuthRequiredError();
    expect(err.name).toBe('AdminAuthRequiredError');
    expect(err.message).toContain('KeyManager admin router requires the `auth` option');
    expect(err.message).toContain('{ type: "bearer", token }');
    expect(err.message).toContain('{ type: "basic", username, password }');
    expect(err.message).toContain('{ type: "middleware", handler }');
    expect(err.message).toContain('{ type: "unsafe-no-auth", acknowledgeRisk: true }');
    expect(err.message).toContain(
      'https://github.com/ashwinpaulallen/ratelimit-flex#admin-api-security',
    );
  });
});

/** Exhaustive switch — if `AdminAuthMode` gains a variant, TypeScript fails here. */
function describeAuthMode(mode: AdminAuthMode): string {
  switch (mode.type) {
    case 'bearer':
      return `bearer:${mode.token}`;
    case 'basic':
      return `basic:${mode.username}`;
    case 'middleware':
      return 'middleware';
    case 'unsafe-no-auth':
      return `unsafe:${String(mode.acknowledgeRisk)}`;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

describe('AdminAuthMode (discriminated union)', () => {
  it('narrows fields per variant', () => {
    expect(describeAuthMode({ type: 'bearer', token: 'abc' })).toBe('bearer:abc');
    expect(describeAuthMode({ type: 'basic', username: 'u', password: 'p' })).toBe('basic:u');
    const noopMw: AdminAuthMiddleware = (_req, _res, next) => {
      next();
    };
    expect(describeAuthMode({ type: 'middleware', handler: noopMw })).toBe('middleware');
    expect(describeAuthMode({ type: 'unsafe-no-auth', acknowledgeRisk: true })).toBe('unsafe:true');
  });
});

describe('assertAdminRouterOptions', () => {
  it('throws AdminAuthRequiredError when options is null or undefined', () => {
    expect(() => assertAdminRouterOptions(undefined)).toThrow(AdminAuthRequiredError);
    expect(() => assertAdminRouterOptions(null)).toThrow(AdminAuthRequiredError);
  });

  it('throws when auth is missing at runtime', () => {
    expect(() => assertAdminRouterOptions({} as AdminRouterOptions)).toThrow(AdminAuthRequiredError);
  });

  it('accepts a valid options object', () => {
    const opts: AdminRouterOptions = {
      auth: { type: 'unsafe-no-auth', acknowledgeRisk: true },
    };
    expect(() => assertAdminRouterOptions(opts)).not.toThrow();
  });
});
