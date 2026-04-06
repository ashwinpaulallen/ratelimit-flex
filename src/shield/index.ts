/**
 * In-memory shield layer over a {@link RateLimitStore} (block cache to save remote store calls).
 *
 * Exports:
 * - {@link InMemoryShield} — class
 * - {@link shield} — helper (`new InMemoryShield(...)` shorthand)
 * - {@link InMemoryShieldOptions}, {@link ShieldEntry}, {@link ShieldMetrics} — types (`ShieldEntry` for advanced custom-store tooling)
 *
 * @module
 */
export { InMemoryShield } from './InMemoryShield.js';
export { shield } from './shield.js';
export type { InMemoryShieldOptions, ShieldEntry, ShieldMetrics } from './types.js';
