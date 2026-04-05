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

export { createAdminRouter } from './admin-router.js';
export { createFastifyAdminPlugin as fastifyAdminPlugin } from './admin-fastify.js';
