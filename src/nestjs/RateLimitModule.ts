import { DynamicModule, Module, ModuleMetadata, Provider, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { mergeRateLimiterOptions, resolveStoreWithInMemoryShield } from '../middleware/merge-options.js';
import { MetricsManager } from '../metrics/manager.js';
import type { RateLimitOptions } from '../types/index.js';
import { RateLimitGuard } from './RateLimitGuard.js';
import { stripNestRateLimitModuleFields } from './strip-nest-module-fields.js';
import type { NestRateLimitModuleOptions } from './types.js';
import type { RateLimitModuleInit } from './rate-limit-module-init.js';
import { RATE_LIMIT_MODULE_INIT } from './rate-limit-module-init.js';
import { RateLimitModuleLifecycle } from './rate-limit-module-lifecycle.js';
import {
  RATE_LIMIT_KEY_MANAGER,
  RATE_LIMIT_METRICS,
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_SHIELD,
  RATE_LIMIT_STORE,
} from './types.js';

export { RATE_LIMIT_MODULE_INIT, type RateLimitModuleInit } from './rate-limit-module-init.js';

@Module({})
export class RateLimitModule {
  /** `globalGuard ?? global` — default true; `false` disables both APP_GUARD and Nest global module registration. */
  private static resolveRegisterGlobal(opts: {
    globalGuard?: boolean;
    global?: boolean;
  }): boolean {
    const v = opts.globalGuard ?? opts.global;
    return v !== false;
  }

  /**
   * Register the rate limiting module with static options.
   *
   * @example
   * @Module({
   *   imports: [
   *     RateLimitModule.forRoot({
   *       maxRequests: 100,
   *       windowMs: 60_000,
   *       strategy: RateLimitStrategy.SLIDING_WINDOW,
   *     }),
   *   ],
   * })
   * export class AppModule {}
   */
  static forRoot(options: NestRateLimitModuleOptions = {}): DynamicModule {
    const init = RateLimitModule.finalizeOptions(options);
    const registerGlobal = RateLimitModule.resolveRegisterGlobal(options);
    const providers = RateLimitModule.createProvidersFromInit(init, registerGlobal);
    return {
      module: RateLimitModule,
      global: registerGlobal,
      providers,
      exports: [
        RATE_LIMIT_OPTIONS,
        RATE_LIMIT_STORE,
        RATE_LIMIT_KEY_MANAGER,
        RATE_LIMIT_SHIELD,
        RATE_LIMIT_METRICS,
      ],
    };
  }

  /**
   * Register with async options (factory). Useful for loading config from ConfigService.
   *
   * @example
   * RateLimitModule.forRootAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: async (config: ConfigService) => ({
   *     maxRequests: config.get('RATE_LIMIT_MAX'),
   *     windowMs: config.get('RATE_LIMIT_WINDOW_MS'),
   *     store: new RedisStore({ url: config.get('REDIS_URL') }),
   *   }),
   * })
   */
  static forRootAsync(asyncOptions: {
    imports?: ModuleMetadata['imports'];
    inject?: (string | symbol | Type<unknown>)[];
    useFactory: (...args: unknown[]) => NestRateLimitModuleOptions | Promise<NestRateLimitModuleOptions>;
    /**
     * When false, do not register {@link APP_GUARD} and do not register as a Nest global module (same as
     * {@link NestRateLimitModuleOptions.globalGuard} on {@link forRoot}). Default: true.
     */
    globalGuard?: boolean;
    /**
     * @deprecated Use `globalGuard` instead. Removed in v3.0.0 — same codemod as {@link NestRateLimitModuleOptions.global}.
     */
    global?: boolean;
  }): DynamicModule {
    const registerGlobal = RateLimitModule.resolveRegisterGlobal(asyncOptions);
    const providers: Provider[] = [
      {
        provide: RATE_LIMIT_MODULE_INIT,
        useFactory: async (...args: unknown[]) =>
          RateLimitModule.finalizeOptions(await Promise.resolve(asyncOptions.useFactory(...args))),
        inject: asyncOptions.inject ?? [],
      },
      {
        provide: RATE_LIMIT_OPTIONS,
        useFactory: (i: RateLimitModuleInit) => i.moduleOptions,
        inject: [RATE_LIMIT_MODULE_INIT],
      },
      {
        provide: RATE_LIMIT_STORE,
        useFactory: (i: RateLimitModuleInit) => i.store,
        inject: [RATE_LIMIT_MODULE_INIT],
      },
      {
        provide: RATE_LIMIT_KEY_MANAGER,
        useFactory: (i: RateLimitModuleInit) => i.keyManager,
        inject: [RATE_LIMIT_MODULE_INIT],
      },
      {
        provide: RATE_LIMIT_SHIELD,
        useFactory: (i: RateLimitModuleInit) => i.shield,
        inject: [RATE_LIMIT_MODULE_INIT],
      },
      {
        provide: RATE_LIMIT_METRICS,
        useFactory: (i: RateLimitModuleInit) => i.metricsManager,
        inject: [RATE_LIMIT_MODULE_INIT],
      },
      RateLimitModuleLifecycle,
    ];
    if (registerGlobal) {
      providers.push({ provide: APP_GUARD, useClass: RateLimitGuard });
    }
    return {
      module: RateLimitModule,
      global: registerGlobal,
      imports: asyncOptions.imports ?? [],
      providers,
      exports: [
        RATE_LIMIT_OPTIONS,
        RATE_LIMIT_STORE,
        RATE_LIMIT_KEY_MANAGER,
        RATE_LIMIT_SHIELD,
        RATE_LIMIT_METRICS,
      ],
    };
  }

  /**
   * Merge Nest options with {@link mergeRateLimiterOptions}, attach auto store / KeyManager / shield metadata.
   */
  static finalizeOptions(options: NestRateLimitModuleOptions): RateLimitModuleInit {
    const partial = stripNestRateLimitModuleFields(options);
    const merged = mergeRateLimiterOptions({
      ...partial,
      store: options.store,
    } as Partial<RateLimitOptions>);
    const { shield, optionsForEngine } = resolveStoreWithInMemoryShield(merged);
    const metricsManager = new MetricsManager(optionsForEngine.metrics, shield);
    const keyManager = (options.keyManager ?? merged.keyManager) ?? null;
    const disposeKeyManagerOnDestroy =
      keyManager !== null && options.keyManager === undefined;
    const moduleOptions: NestRateLimitModuleOptions = {
      ...options,
      store: merged.store,
      ...(keyManager !== null ? { keyManager } : {}),
    };
    return {
      moduleOptions,
      store: merged.store,
      keyManager,
      shield,
      metricsManager,
      disposeKeyManagerOnDestroy,
    };
  }

  private static createProvidersFromInit(init: RateLimitModuleInit, registerAppGuard: boolean): Provider[] {
    const providers: Provider[] = [
      { provide: RATE_LIMIT_MODULE_INIT, useValue: init },
      { provide: RATE_LIMIT_OPTIONS, useValue: init.moduleOptions },
      { provide: RATE_LIMIT_STORE, useValue: init.store },
      { provide: RATE_LIMIT_KEY_MANAGER, useValue: init.keyManager },
      { provide: RATE_LIMIT_SHIELD, useValue: init.shield },
      { provide: RATE_LIMIT_METRICS, useValue: init.metricsManager },
      RateLimitModuleLifecycle,
    ];
    if (registerAppGuard) {
      providers.push({ provide: APP_GUARD, useClass: RateLimitGuard });
    }
    return providers;
  }
}
