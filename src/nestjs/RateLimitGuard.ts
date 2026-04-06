import { createRequire } from 'node:module';
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { formatRateLimitHeaders, resolveHeaderConfig, type HeaderInput } from '../headers/index.js';
import {
  jsonErrorBody,
  keyManagerBlockedJson,
  mergeRateLimiterOptions,
  resolveStoreWithInMemoryShield,
} from '../middleware/merge-options.js';
import type { MetricsManager } from '../metrics/manager.js';
import type { MetricsCounters } from '../metrics/counters.js';
import { RateLimitEngine, defaultKeyGenerator } from '../strategies/rate-limit-engine.js';
import type { KeyManager } from '../key-manager/KeyManager.js';
import type { InMemoryShield } from '../shield/InMemoryShield.js';
import type { RateLimitConsumeResult, RateLimitOptions, RateLimitStore } from '../types/index.js';
import { RateLimitStrategy } from '../types/index.js';
import type { WindowRateLimitOptions } from '../types/index.js';
import { stripNestRateLimitModuleFields } from './strip-nest-module-fields.js';
import { tryResolveGraphqlRequestResponse } from './resolve-graphql-req-res.js';
import type { NestRateLimitModuleOptions, RateLimitDecoratorOptions } from './types.js';
import {
  RATE_LIMIT_KEY_MANAGER,
  RATE_LIMIT_METADATA,
  RATE_LIMIT_METRICS,
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_SHIELD,
  RATE_LIMIT_SKIP_METADATA,
  RATE_LIMIT_STORE,
} from './types.js';

function isWindowOpts(o: RateLimitOptions): o is WindowRateLimitOptions {
  return o.strategy !== RateLimitStrategy.TOKEN_BUCKET;
}

function isPlainRouteLimitOptions(meta: unknown): meta is RateLimitDecoratorOptions {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return false;
  }
  const o = meta as Record<string, unknown>;
  return (
    'maxRequests' in o ||
    'windowMs' in o ||
    'cost' in o ||
    'strategy' in o ||
    'keyGenerator' in o
  );
}

function mergeRouteIntoOptions(
  base: RateLimitOptions,
  route: RateLimitDecoratorOptions | undefined,
): RateLimitOptions {
  if (!route) {
    return base;
  }
  const merged: RateLimitOptions = { ...base };
  if (isWindowOpts(merged) && route.maxRequests !== undefined) {
    (merged as WindowRateLimitOptions).maxRequests = route.maxRequests;
  }
  if (isWindowOpts(merged) && route.windowMs !== undefined) {
    (merged as WindowRateLimitOptions).windowMs = route.windowMs;
  }
  if (route.cost !== undefined) {
    merged.incrementCost = route.cost;
  }
  if (route.strategy !== undefined && route.strategy !== merged.strategy) {
    // Per-route strategy changes require a compatible store; ignore for the guard.
  }
  return merged;
}

function applyHeaderMap(res: unknown, headers: Record<string, string>): void {
  if (res === null || typeof res !== 'object') {
    return;
  }
  const r = res as {
    setHeader?: (n: string, v: string | number) => void;
    header?: (n: string, v: string | number) => void;
  };
  if (typeof r.setHeader !== 'function' && typeof r.header !== 'function') {
    return;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof r.setHeader === 'function') {
      r.setHeader(name, value);
    } else if (typeof r.header === 'function') {
      r.header(name, value);
    }
  }
}

/** Resolve `createRequire` root for optional peer imports (ESM + CJS builds). */
function createRequireFromHere(): NodeRequire {
  return createRequire(import.meta.url);
}

@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly engine: RateLimitEngine;

  private readonly resolved: RateLimitOptions;

  private readonly metricsCounters: MetricsCounters | undefined;

  private metricsCollectorStarted = false;

  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_OPTIONS) private readonly moduleOptions: NestRateLimitModuleOptions,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Optional() @Inject(RATE_LIMIT_KEY_MANAGER) private readonly injectedKeyManager: KeyManager | undefined,
    @Optional() @Inject(RATE_LIMIT_SHIELD) _shield: InMemoryShield | undefined,
    @Optional() @Inject(RATE_LIMIT_METRICS) private readonly metricsManager: MetricsManager | null,
  ) {
    void _shield;
    this.metricsCounters = this.metricsManager?.getCounters() ?? undefined;
    const partial = stripNestRateLimitModuleFields(moduleOptions);
    const merged = mergeRateLimiterOptions({
      ...partial,
      store: this.store,
      keyManager: this.injectedKeyManager ?? partial.keyManager,
    });
    const { optionsForEngine } = resolveStoreWithInMemoryShield(merged);
    this.resolved = optionsForEngine;
    this.engine = this.createEngine(optionsForEngine);
  }

  private createEngine(resolved: RateLimitOptions): RateLimitEngine {
    return new RateLimitEngine(resolved, this.metricsCounters);
  }

  private ensureMetricsStarted(): void {
    if (this.metricsCollectorStarted || !this.metricsManager?.getCounters()) {
      return;
    }
    this.metricsManager.start();
    this.metricsCollectorStarted = true;
  }

  async onModuleDestroy(): Promise<void> {
    await this.metricsManager?.shutdown();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    this.ensureMetricsStarted();

    const skipFn = this.moduleOptions.skip;
    if (skipFn !== undefined) {
      const s = await skipFn(context);
      if (s === true) {
        return true;
      }
    }

    const skipMeta = this.reflector.getAllAndOverride<string | boolean | string[]>(RATE_LIMIT_SKIP_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipMeta === true) {
      return true;
    }
    if (Array.isArray(skipMeta) && skipMeta.length > 0) {
      // Named skip metadata is reserved for future per-layer behavior; currently skips entirely.
      return true;
    }

    const { req, res } = this.getRequestResponse(context);

    const rawMeta = this.reflector.getAllAndOverride<unknown>(RATE_LIMIT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    const routeOverrides = isPlainRouteLimitOptions(rawMeta) ? rawMeta : undefined;

    const effectiveOpts = mergeRouteIntoOptions(this.resolved, routeOverrides);
    const engine = routeOverrides ? this.createEngine(effectiveOpts) : this.engine;

    const key = await this.resolveKey(context, req, routeOverrides);

    const result = await engine.consumeWithKey(key, req);

    const headerCfg = resolveHeaderConfig(
      mergeRouteIntoOptions(this.resolved, routeOverrides),
      req,
      result.bindingSlotIndex,
    );
    if (headerCfg.format) {
      const headerInput: HeaderInput = {
        limit: headerCfg.resolvedLimit,
        remaining: result.remaining,
        resetTime: result.resetTime,
        isBlocked: result.isBlocked,
        windowMs: headerCfg.resolvedWindowMs,
        identifier: headerCfg.identifier,
      };
      const { headers, legacyHeaders } = formatRateLimitHeaders(
        headerInput,
        headerCfg.format,
        headerCfg.includeLegacy,
      );
      applyHeaderMap(res, headers);
      if (legacyHeaders) {
        applyHeaderMap(res, legacyHeaders);
      }
    }

    if (result.storeUnavailable === true) {
      applyHeaderMap(res, { 'X-RateLimit-Store': 'fallback' });
    }

    if (result.isBlocked) {
      throw this.mapBlockedToHttpException(context, key, result, effectiveOpts);
    }

    return true;
  }

  private getRequestResponse(context: ExecutionContext): { req: unknown; res: unknown } {
    if (this.moduleOptions.getRequestResponse) {
      return this.moduleOptions.getRequestResponse(context);
    }

    const contextType = context.getType<string>();

    switch (contextType) {
      case 'http':
        return {
          req: context.switchToHttp().getRequest(),
          res: context.switchToHttp().getResponse(),
        };

      case 'graphql': {
        const gql = tryResolveGraphqlRequestResponse(context, createRequireFromHere());
        if (gql !== null) {
          return gql;
        }
        return {
          req: context.switchToHttp().getRequest(),
          res: context.switchToHttp().getResponse(),
        };
      }

      case 'ws': {
        const client = context.switchToWs().getClient() as {
          _socket?: { remoteAddress?: string };
          handshake?: { address?: string };
        };
        return {
          req: {
            ip: client._socket?.remoteAddress ?? client.handshake?.address ?? 'unknown',
            socket: client._socket,
          },
          res: {},
        };
      }

      case 'rpc': {
        const rpcCtx = context.switchToRpc().getContext();
        return {
          req: rpcCtx,
          res: {},
        };
      }

      default:
        return {
          req: context.switchToHttp().getRequest(),
          res: context.switchToHttp().getResponse(),
        };
    }
  }

  private async resolveKey(
    context: ExecutionContext,
    req: unknown,
    route: RateLimitDecoratorOptions | undefined,
  ): Promise<string> {
    const routeKg = route?.keyGenerator;
    if (routeKg) {
      return routeKg(context);
    }
    const nestKg = this.moduleOptions.keyGenerator;
    if (nestKg) {
      return nestKg(context);
    }
    const base = this.resolved.keyGenerator ?? defaultKeyGenerator;
    return base(req);
  }

  private mapBlockedToHttpException(
    context: ExecutionContext,
    key: string,
    result: RateLimitConsumeResult,
    effective: RateLimitOptions,
  ): HttpException {
    if (result.storeUnavailable || result.blockReason === 'service_unavailable') {
      return new HttpException(jsonErrorBody('Service temporarily unavailable'), 503);
    }

    if (result.blockReason === 'key_manager' && effective.keyManager) {
      const status = effective.statusCode ?? 429;
      const body = keyManagerBlockedJson(effective, key);
      const ex = new HttpException(body, status);
      return this.applyErrorFactory(context, result, ex);
    }

    if (result.blockReason === 'blocklist') {
      const status = effective.blocklistStatusCode ?? 403;
      const msg = effective.blocklistMessage ?? 'Forbidden';
      return new HttpException(jsonErrorBody(msg), status);
    }

    const err = this.moduleOptions.errorFactory?.(context, {
      totalHits: result.totalHits,
      remaining: result.remaining,
      resetTime: result.resetTime,
    });
    if (err !== undefined) {
      if (err instanceof HttpException) {
        return err;
      }
      throw err;
    }

    const statusCode = effective.statusCode ?? 429;
    const msg = effective.message ?? 'Too many requests';
    const body =
      typeof msg === 'string'
        ? jsonErrorBody(msg)
        : { ...(msg as object), statusCode, totalHits: result.totalHits, remaining: result.remaining };
    return new HttpException(body, statusCode);
  }

  private applyErrorFactory(
    context: ExecutionContext,
    result: RateLimitConsumeResult,
    fallback: HttpException,
  ): HttpException {
    const err = this.moduleOptions.errorFactory?.(context, {
      totalHits: result.totalHits,
      remaining: result.remaining,
      resetTime: result.resetTime,
    });
    if (err === undefined) {
      return fallback;
    }
    if (err instanceof HttpException) {
      return err;
    }
    throw err;
  }
}
