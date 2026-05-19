/**
 * @file Side-effect typings so Nest **`req`** exposes the same read-only telemetry fields documented for Express middleware.
 */

import type { RateLimitConsumeResult } from '../types/index.js';
import type { RateLimitInfo } from '../types/index.js';

declare module 'express-serve-static-core' {
  interface Request {
    rateLimit?: RateLimitInfo;
    rateLimitComposed?: RateLimitConsumeResult;
  }
}

export {};
