/**
 * Key manager, penalty escalation, block persistence, and admin HTTP API.
 *
 * @packageDocumentation
 */

export { KeyManager } from './KeyManager.js';

export type {
  AuditEntry,
  BlockReason,
  KeyManagerEvents,
  KeyManagerOptions,
  KeyState,
} from './types.js';

export type { AdminHttpAuditEnvelopeV1, AdminHttpAuditEventV1 } from './admin-http-audit-v1.js';
export {
  ADMIN_HTTP_AUDIT_SCHEMA_VERSION,
  formatAdminHttpAuditNdjsonV1,
  toAdminHttpAuditEnvelopeV1,
} from './admin-http-audit-v1.js';

export type { BlockStore } from './block-store.js';
export { MemoryBlockStore, RedisBlockStore } from './block-store.js';

export type { EscalationStrategy } from './strategies.js';
export {
  capped,
  exponentialEscalation,
  fibonacciEscalation,
  fixedEscalation,
  linearEscalation,
} from './strategies.js';

export type { AdminAuthMiddleware, AdminAuthMode, AdminRouterOptions } from './admin-auth.js';
export { AdminAuthRequiredError } from './admin-auth.js';
export { resolveAdminAuth } from './admin-auth-middleware.js';
export { createAdminRouter } from './admin.js';
export { createFastifyAdminPlugin as fastifyAdminPlugin } from './admin-fastify.js';
export type { FastifyAdminPluginOptions } from './admin-fastify.js';
