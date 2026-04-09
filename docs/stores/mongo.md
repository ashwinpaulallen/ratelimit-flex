# MongoDB store (`MongoStore`)

Entry: **`ratelimit-flex/mongo`** — exports **`MongoStore`** and types. Use **`mongoPreset`** and **`expressRateLimiter`** from the main package (`ratelimit-flex`).

## Requirements

- **MongoDB 4.2+** — increments use **`findOneAndUpdate`** with an **aggregation pipeline** so conditional logic stays **atomic** in a single round trip.
- A **TTL index** on the document expiry field (default **`resetAt`**) so MongoDB can delete stale documents passively. **`MongoStore`** can call **`ensureIndexes()`** on startup unless you set **`ensureIndexes: false`** (tests or strict migration control).

## Client shapes

Pass one of:

- **`{ client, dbName?, collectionName? }`** — typical for apps that already hold a **`MongoClient`**.
- **`{ db }`** or **`{ collection }`** — when you already have **`Db`** / **`Collection`**.

Collection documents store sliding hits arrays, fixed-window counters, or token-bucket fields analogous to the Postgres layout (see type **`RateLimitDocument`** in the package).

## Strategies

All three strategies are **exact** (conditional updates in one pipeline).

## Presets

- **`mongoPreset(mongo, overrides?)`** — sliding window by default, draft-6 headers, **`inMemoryBlock: true`**.

## Performance

- Expect **~2–10ms** per increment over a network hop to Atlas or self-hosted MongoDB; pipeline updates are single-document.
- Hot keys contend on the same document — same guidance as Postgres: shard keys or move extreme hotspots to Redis.

## Failure modes

- **`onMongoError`** — **fail-open** vs **fail-closed** when the driver throws (network, NotPrimary, etc.).
- **Index build failures** — if **`ensureIndexes`** runs and the collection is in a bad state, check logs; disable **`ensureIndexes`** and create the TTL index in migrations.

## Troubleshooting

| Symptom | Things to check |
|--------|-------------------|
| Duplicate key / write concern errors | Rare with single-doc updates; verify app is not bypassing the store with raw writes to the same keys. |
| Documents not expiring | TTL index missing or **`resetAt`** not aligned with server time; **`expireAfterSeconds: 0`** requires **`resetAt`** in the past for deletion. |
| Slow queries | Compound indexes not needed for single-`_id`/key lookups; watch **CPU** on the primary under hot keys. |
