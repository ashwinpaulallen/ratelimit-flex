/**
 * Vitest runs tests in worker threads by default. Node's `cluster` module only behaves as a
 * primary/worker tree in a real process tree; inside a worker thread, `cluster.fork()` / IPC are
 * unreliable. This file is run under `pool: 'forks'` (see vitest.config.ts) so the test process
 * is a normal Node child process and can act as the cluster primary.
 */
import cluster from 'node:cluster';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ClusterStorePrimary } from '../../src/cluster/ClusterStorePrimary.js';

type TestResultsMsg = {
  type: 'test_results';
  results: Array<{ totalHits: number; remaining: number; isBlocked: boolean }>;
};

type TestErrorMsg = { type: 'test_error'; error: string };

describe('cluster integration (slow)', () => {
  it(
    'shares a single MemoryStore counter across forked workers via IPC',
    { timeout: 10_000 },
    async () => {
      if (!cluster.isPrimary) {
        throw new Error('Expected cluster primary (run this file with vitest pool: forks)');
      }

      const workerPath = fileURLToPath(new URL('./clusterWorker.ts', import.meta.url));
      cluster.setupPrimary({
        exec: workerPath,
        execArgv: ['--import', 'tsx'],
      });

      ClusterStorePrimary.init();

      const batches: TestResultsMsg['results'][] = [];

      try {
        await new Promise<void>((resolve, reject) => {
          let pending = 2;
          const onMessage = (msg: unknown): void => {
            if (msg && typeof msg === 'object' && 'type' in msg) {
              const t = msg as TestResultsMsg | TestErrorMsg;
              if (t.type === 'test_error') {
                reject(new Error(t.error));
                return;
              }
              if (t.type === 'test_results') {
                batches.push(t.results);
                pending -= 1;
                if (pending === 0) resolve();
              }
            }
          };

          for (let i = 0; i < 2; i++) {
            const w = cluster.fork();
            w.on('message', onMessage);
            w.on('error', reject);
          }
        });

        const flat = batches.flat();
        expect(flat).toHaveLength(10);

        const sorted = [...flat].sort((a, b) => a.totalHits - b.totalHits);
        for (let i = 0; i < 10; i++) {
          const n = i + 1;
          expect(sorted[i].totalHits).toBe(n);
          expect(sorted[i].remaining).toBe(10 - n);
        }

        const tenth = sorted.find((r) => r.totalHits === 10);
        expect(tenth).toBeDefined();
        expect(tenth!.remaining).toBe(0);
      } finally {
        ClusterStorePrimary.destroy();
        await new Promise<void>((resolve, reject) => {
          cluster.disconnect((err) => (err ? reject(err) : resolve()));
        });
      }
    },
  );
});
