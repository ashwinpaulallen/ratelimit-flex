import type { KeyManager } from '../key-manager/KeyManager.js';
import type { MetricsManager } from '../metrics/manager.js';
import type { InMemoryShield } from '../shield/InMemoryShield.js';
import type { RateLimitStore } from '../types/index.js';
import type { NestRateLimitModuleOptions } from './types.js';

/** Internal token: merged init payload for async registration and lifecycle. */
export const RATE_LIMIT_MODULE_INIT = Symbol('RATE_LIMIT_MODULE_INIT');

export interface RateLimitModuleInit {
  moduleOptions: NestRateLimitModuleOptions;
  store: RateLimitStore;
  keyManager: KeyManager | null;
  shield: InMemoryShield | null;
  metricsManager: MetricsManager;
  /**
   * When true, {@link RateLimitModuleLifecycle} calls {@link KeyManager.destroy} on module teardown.
   * Set when {@link KeyManager} was auto-created from `penaltyBox` (user did not pass `keyManager` in
   * `forRoot` / `forRootAsync`). User-supplied instances are never destroyed by the module.
   */
  disposeKeyManagerOnDestroy: boolean;
}
