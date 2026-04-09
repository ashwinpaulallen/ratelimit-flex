import cluster from 'node:cluster';
import { detectEnvironment, type EnvironmentInfo } from '../utils/environment.js';

export function ceilDiv(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return Math.max(1, numerator);
  }
  return Math.max(1, Math.ceil(numerator / denominator));
}

/**
 * Best-effort replica count from {@link detectEnvironment} when `estimatedWorkers` is omitted.
 *
 * @internal Exported for Postgres presets; same logic as legacy private helper in `./index.js`.
 */
export function estimateWorkersFromEnvironment(
  explicit: number | undefined,
  env: EnvironmentInfo = detectEnvironment(),
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }
  if (!env.isMultiInstance) {
    return 1;
  }
  let n = 1;
  if (env.isKubernetes) {
    n = Math.max(n, 4);
  }
  if (env.isDocker) {
    n = Math.max(n, 2);
  }
  if (env.isCluster) {
    const workerCount =
      cluster.isPrimary && cluster.workers
        ? Object.keys(cluster.workers).length
        : cluster.isWorker
          ? 1
          : 0;
    n = Math.max(n, workerCount > 1 ? workerCount : 2);
  }
  return Math.max(1, n);
}
