import type { Pool } from 'pg';
import { pgStoreSchema } from '../../src/stores/postgres/schema.js';
import type { PgClientLike } from '../../src/stores/postgres/types.js';

export const runPgStoreIntegration =
  Boolean(process.env.TEST_POSTGRES_URL) ||
  Boolean(process.env.PG_TEST_URL) ||
  process.env.PG_STORE_TEST === '1';

function wrapPoolWithConnect(pool: Pool): PgClientLike {
  return {
    query: (text, values) => pool.query(text, values as unknown[]),
    connect: async () => {
      const c = await pool.connect();
      return {
        query: (text, values) => c.query(text, values as unknown[]),
        release: () => {
          c.release();
        },
      };
    },
  };
}

export async function initPgStoreTestBackend(): Promise<{
  client: PgClientLike;
  cleanup: () => Promise<void>;
  /** Underlying pool — for tests that must assert {@link Pool.end} was not called by {@link PgStore.shutdown}. */
  pool: Pool;
  /** Connection string (same DB as {@link pool}) — for opening an isolated {@link Pool} in a single test. */
  connectionUri: string;
}> {
  const url = process.env.TEST_POSTGRES_URL ?? process.env.PG_TEST_URL;
  if (url) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: url });
    await pool.query(pgStoreSchema);
    return {
      client: wrapPoolWithConnect(pool),
      pool,
      connectionUri: url,
      cleanup: async () => {
        await pool.end();
      },
    };
  }

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const { Pool } = await import('pg');
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const connectionUri = container.getConnectionUri();
  const pool = new Pool({ connectionString: connectionUri });
  await pool.query(pgStoreSchema);
  return {
    client: wrapPoolWithConnect(pool),
    pool,
    connectionUri,
    cleanup: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
