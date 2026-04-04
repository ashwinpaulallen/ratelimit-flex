import cluster from 'node:cluster';
import fs from 'node:fs';
import type { RateLimitStore } from '../types/index.js';
import { MemoryStore } from '../stores/memory-store.js';
import { RedisStore } from '../stores/redis-store.js';

/**
 * Snapshot of deployment-related signals detected from `process.env` and the Node cluster API.
 *
 * @description Best-effort; use for logging or startup hints, not security guarantees.
 * @see {@link detectEnvironment}
 * @see {@link warnIfMemoryStoreInCluster}
 * @see {@link warnIfRedisStoreWithoutInsurance}
 * @since 1.2.0
 */
export interface EnvironmentInfo {
  /**
   * @description `true` when this process is a cluster worker, the primary has multiple workers, or PM2 markers are present.
   * @default false
   */
  isCluster: boolean;
  /**
   * @description `true` when Node’s native `cluster` module is active: this process is a worker, or the primary has forked at least one worker.
   * @default false
   */
  isNativeCluster: boolean;
  /**
   * @description `true` when `KUBERNETES_SERVICE_HOST` is set.
   * @default false
   */
  isKubernetes: boolean;
  /**
   * @description `true` when `/.dockerenv` exists or `DOCKER` env is set.
   * @default false
   */
  isDocker: boolean;
  /**
   * @description `true` if any of cluster, Kubernetes, or Docker signals fired.
   * @default false
   */
  isMultiInstance: boolean;
  /**
   * @description Suggested store kind: `memory` when single-instance; `cluster` when {@link EnvironmentInfo.isNativeCluster} and multi-instance (IPC + primary {@link MemoryStore}); `redis` for other multi-instance deployments.
   */
  recommended: 'memory' | 'redis' | 'cluster';
}

function dockerenvExists(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

/**
 * Heuristic: this process may be running under PM2 (`PM2_HOME` or `pm_id` is set).
 *
 * @description Best-effort only — `PM2_HOME` can be set without PM2 cluster mode. See {@link detectEnvironment}.
 * @since 1.4.2
 */
export function isPm2ManagedProcess(): boolean {
  return process.env['PM2_HOME'] !== undefined || process.env['pm_id'] !== undefined;
}

/**
 * Inspect the current process environment and return deployment context signals.
 *
 * @description Heuristics only: e.g. `PM2_HOME` / `pm_id` may be set without PM2 cluster mode; Docker may be a single replica.
 * @returns {@link EnvironmentInfo}.
 * @example
 * ```ts
 * const env = detectEnvironment();
 * if (env.recommended === 'redis') {
 *   console.log('Consider RedisStore for shared rate limits.');
 * }
 * if (env.recommended === 'cluster') {
 *   console.log('Consider ClusterStore with ClusterStorePrimary on the primary process.');
 * }
 * ```
 * @since 1.2.0
 */
export function detectEnvironment(): EnvironmentInfo {
  const isNativeCluster =
    cluster.isWorker === true ||
    (cluster.isPrimary === true &&
      cluster.workers != null &&
      Object.keys(cluster.workers).length > 0);

  const isCluster =
    cluster.isWorker === true ||
    (cluster.isPrimary === true &&
      cluster.workers != null &&
      Object.keys(cluster.workers).length > 1) ||
    isPm2ManagedProcess();

  const isKubernetes = process.env['KUBERNETES_SERVICE_HOST'] !== undefined;

  const isDocker = dockerenvExists() || process.env['DOCKER'] !== undefined;

  const isMultiInstance = isCluster || isKubernetes || isDocker || isNativeCluster;

  let recommended: 'memory' | 'redis' | 'cluster' = 'memory';
  if (isMultiInstance) {
    recommended = isNativeCluster ? 'cluster' : 'redis';
  }

  return {
    isCluster,
    isNativeCluster,
    isKubernetes,
    isDocker,
    isMultiInstance,
    recommended,
  };
}

let hasWarned = false;

let hasWarnedRedisNoInsurance = false;

/**
 * Log a **one-time** warning when a {@link MemoryStore} is used in a detected multi-instance environment.
 *
 * @description Invoked by Express/Fastify middleware after options merge. Per-instance counters are not globally consistent when multiple replicas exist.
 * @param store - The resolved store backing the limiter.
 * @returns `void` (no throw).
 * @example
 * ```ts
 * // Usually automatic via expressRateLimiter / fastifyRateLimiter
 * warnIfMemoryStoreInCluster(myMemoryStore);
 * ```
 * @see {@link detectEnvironment}
 * @see {@link RedisStore}
 * @since 1.2.0
 */
export function warnIfMemoryStoreInCluster(store: RateLimitStore): void {
  if (hasWarned || !(store instanceof MemoryStore)) {
    return;
  }

  const optOut = process.env['RATELIMIT_FLEX_NO_MEMORY_WARN'];
  if (optOut === '1' || optOut?.toLowerCase() === 'true') {
    return;
  }

  const env = detectEnvironment();
  if (!env.isMultiInstance) {
    return;
  }

  hasWarned = true;
  if (env.isNativeCluster) {
    console.warn(
      'ratelimit-flex: MemoryStore detected in cluster mode. Consider ClusterStore (no Redis needed) or RedisStore for shared limits.\n' +
        '  See: https://github.com/ashwinpaulallen/ratelimit-flex#deployment-guide',
    );
  } else {
    console.warn(
      '[ratelimit-flex] WARNING: MemoryStore detected in a multi-instance environment.\n' +
        '  Rate limits will be tracked per-instance, not globally.\n' +
        '  Consider using RedisStore for shared rate limiting.\n' +
        '  See: https://github.com/ashwinpaulallen/ratelimit-flex#deployment-guide',
    );
  }
}

/**
 * Log a **one-time** warning when a {@link RedisStore} is used **without** an insurance limiter in a detected multi-instance environment.
 *
 * @description Invoked by Express/Fastify middleware after options merge. Suppress with `RATELIMIT_FLEX_NO_RESILIENCE_WARN=1` or `true`.
 * @param store - The resolved store backing the limiter.
 * @returns `void` (no throw).
 * @see {@link detectEnvironment}
 * @see {@link RedisStore.hasInsuranceLimiter}
 * @since 1.3.2
 */
export function warnIfRedisStoreWithoutInsurance(store: RateLimitStore): void {
  if (hasWarnedRedisNoInsurance || !(store instanceof RedisStore)) {
    return;
  }

  const optOut = process.env['RATELIMIT_FLEX_NO_RESILIENCE_WARN'];
  if (optOut === '1' || optOut?.toLowerCase() === 'true') {
    return;
  }

  const env = detectEnvironment();
  if (!env.isMultiInstance) {
    return;
  }

  if (store.hasInsuranceLimiter()) {
    return;
  }

  hasWarnedRedisNoInsurance = true;
  console.warn(
    'ratelimit-flex: RedisStore detected in a multi-instance environment without an insurance limiter. Consider using resilientRedisPreset() or adding an insuranceLimiter for Redis failover protection.',
  );
}
