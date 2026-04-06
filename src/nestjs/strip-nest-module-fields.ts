import type { RateLimitOptions } from '../types/index.js';
import type { NestRateLimitModuleOptions } from './types.js';

/**
 * Drops Nest-only fields so the rest can be merged as {@link RateLimitOptions}.
 */
export function stripNestRateLimitModuleFields(
  nest: NestRateLimitModuleOptions,
): Partial<RateLimitOptions> {
  const {
    globalGuard: _gg,
    getRequestResponse: _grr,
    errorFactory: _ef,
    skip: _sk,
    keyGenerator: _kg,
    ...rest
  } = nest;
  void _gg;
  void _grr;
  void _ef;
  void _sk;
  void _kg;
  return rest;
}
