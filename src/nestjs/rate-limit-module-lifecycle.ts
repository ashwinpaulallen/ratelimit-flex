import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { RateLimitModuleInit } from './rate-limit-module-init.js';
import { RATE_LIMIT_MODULE_INIT } from './rate-limit-module-init.js';

/**
 * Calls {@link KeyManager.destroy} when the module created the {@link KeyManager} from `penaltyBox`
 * (see {@link RateLimitModuleInit.disposeKeyManagerOnDestroy}). User-injected `keyManager` options
 * are never destroyed here — call `destroy()` yourself if you own the instance.
 */
@Injectable()
export class RateLimitModuleLifecycle implements OnModuleDestroy {
  constructor(@Inject(RATE_LIMIT_MODULE_INIT) private readonly init: RateLimitModuleInit) {}

  onModuleDestroy(): void {
    if (this.init.disposeKeyManagerOnDestroy && this.init.keyManager !== null) {
      this.init.keyManager.destroy();
    }
  }
}
