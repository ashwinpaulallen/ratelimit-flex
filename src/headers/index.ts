/**
 * Rate-limit HTTP header formatting (pure, no framework deps).
 *
 * @packageDocumentation
 * @since 1.4.0
 */
export {
  defaultRateLimitIdentifier,
  formatRateLimitHeaders,
  sanitizeIdentifierFor8941,
  type HeaderFormat,
  type HeaderInput,
  type HeaderOutput,
} from './formatHeaders.js';
export { resolveHeaderConfig, resolveWindowMsForHeaders } from './resolveConfig.js';
export type { StandardHeadersDraft } from '../types/index.js';
