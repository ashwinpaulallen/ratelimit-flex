# PostgreSQL store (`PgStore`)

Entry: **`ratelimit-flex/postgres`** — exports **`PgStore`**, **`pgStoreSchema`** / **`pgStoreSchemaDown`**, and types. Use **`postgresPreset`** and **`expressRateLimiter`** from the main package (`ratelimit-flex`).

## Schema and migrations

The library **does not** run DDL at runtime. Apply the SQL in **`pgStoreSchema`** once per environment (migration tool, init container, or manual):

- Table **`rate_limits`** with:
  - **`key`** — primary key (text), logical rate-limit key (with any prefix your app uses).
  - **`total_hits`**, **`reset_at`** — window / bucket bookkeeping.
  - **`hits`** — **JSONB** array of hit timestamps (epoch ms) for **sliding window**; `NULL` for fixed window / token bucket.
  - **`tokens`**, **`last_refill_at`** — token bucket state; `NULL` for window strategies.
- Index **`rate_limits_reset_at_idx`** on **`reset_at`** — supports the **background sweep** that deletes expired rows.

Use **`pgStoreSchemaDown`** only in dev or when you intentionally drop the table.

## Indexes and performance

- **Primary key** lookups are O(1) per key.
- **Sweep** scans by **`reset_at`**; keep the index and avoid huge tables by tuning sweep frequency (**`autoSweepIntervalMs`**, **`sweepBatchSize`**) and connection pool size for your QPS.
- For very hot keys, Postgres still serializes updates per row — expect **~2–10ms** typical latency on a well-sized instance (see README store matrix).

## Strategies

| Strategy | Behavior |
|----------|------------|
| **Sliding window** | Stores recent hit timestamps in **`hits` JSONB**; trims outside the window in the same statement family as increment. **Exact** for the configured window. |
| **Fixed window** | Single counter + **`reset_at`**; **atomic UPSERT** with **`ON CONFLICT`**. |
| **Token bucket** | **`tokens`** + **`last_refill_at`**; refills computed atomically with conflict handling. |

## Presets

- **`postgresPreset({ pool })`** — defaults to sliding window, draft-6 headers, **`inMemoryBlock: true`**. Merge overrides (e.g. **`maxRequests`**, **`strategy`**). Use **`failClosedPostgresPreset`** when you want **fail-closed** behavior on database errors instead of the default preset.

## Failure modes

- Configure **`onPostgresError`** on **`PgStore`** (or use **`failClosedPostgresPreset`**) to choose **fail-open** vs **fail-closed** when the database errors.
- Connection pool exhaustion surfaces as query errors — size **`pool`** for concurrent limit checks; avoid per-request pool creation.

## Troubleshooting

| Symptom | Things to check |
|--------|-------------------|
| Migration fails | Postgres version supports **`JSONB`** and **`ON CONFLICT`** (9.5+). |
| Rising table size | Sweep not running (**`autoSweepIntervalMs: 0`** disables timer; call **`sweep()`** periodically yourself if you disable the timer), or **`reset_at`** skew from clock issues. |
| Slow hot keys | Row-level lock contention — shard keys, reduce window cost, or move hottest limits to Redis. |
