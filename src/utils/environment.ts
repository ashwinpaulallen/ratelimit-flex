import cluster from 'node:cluster';
import fs from 'node:fs';
import type { RateLimitStore } from '../types/index.js';
import { MemoryStore } from '../stores/memory-store.js';

/**
 * Snapshot of deployment-related signals detected from `process.env` and the Node cluster API.
 *
 * @description Best-effort; use for logging or startup hints, not security guarantees.
 * @see {@link detectEnvironment}
 * @see {@link warnIfMemoryStoreInCluster}
 * @since 1.2.0
 */
export interface EnvironmentInfo {
  /**
   * @description `true` when this process is a cluster worker, the primary has multiple workers, or PM2 markers are present.
   * @default false
   */
  isCluster: boolean;
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
   * @description Suggested store kind for shared limits: `redis` when {@link EnvironmentInfo.isMultiInstance} is true, else `memory`.
   */
  recommended: 'memory' | 'redis';
}

function dockerenvExists(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

/**
 * Inspect the current process environment and return deployment context signals.
 *
 * @description Heuristics only: e.g. `PM2_HOME` may be set without cluster mode; Docker may be a single replica.
 * @returns {@link EnvironmentInfo}.
 * @example
 * ```ts
 * const env = detectEnvironment();
 * if (env.recommended === 'redis') {
 *   console.log('Consider RedisStore for shared rate limits.');
 * }
 * ```
 * @since 1.2.0
 */
export function detectEnvironment(): EnvironmentInfo {
  const isCluster =
    cluster.isWorker === true ||
    (cluster.isPrimary === true &&
      cluster.workers != null &&
      Object.keys(cluster.workers).length > 1) ||
    process.env['PM2_HOME'] !== undefined;

  const isKubernetes = process.env['KUBERNETES_SERVICE_HOST'] !== undefined;

  const isDocker = dockerenvExists() || process.env['DOCKER'] !== undefined;

  const isMultiInstance = isCluster || isKubernetes || isDocker;

  return {
    isCluster,
    isKubernetes,
    isDocker,
    isMultiInstance,
    recommended: isMultiInstance ? 'redis' : 'memory',
  };
}

let hasWarned = false;

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
  console.warn(
    '[ratelimit-flex] WARNING: MemoryStore detected in a multi-instance environment.\n' +
      '  Rate limits will be tracked per-instance, not globally.\n' +
      '  Consider using RedisStore for shared rate limiting.\n' +
      '  See: https://github.com/ashwinpaulallen/ratelimit-flex#deployment-guide',
  );
}
