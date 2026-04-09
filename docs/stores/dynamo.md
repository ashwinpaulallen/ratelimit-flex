# DynamoDB store (`DynamoStore`)

Entry: **`ratelimit-flex/dynamo`** — exports **`DynamoStore`**, **`dynamoStoreTableSchema`**, **`dynamoStoreEnableTtlParams`**, helpers for the weighted sliding algorithm, and types. Use **`dynamoPreset`** and **`expressRateLimiter`** from the main package (`ratelimit-flex`).

## Table setup (one-time)

The library **does not** call **`CreateTable`** or **`UpdateTimeToLive`** at runtime. In CDK, Terraform, CloudFormation, or the AWS CLI:

1. Create a table matching **`dynamoStoreTableSchema`** (partition key **`pk`**, string; on-demand billing in the example).
2. Enable **TTL** on attribute **`ttl`** (see **`dynamoStoreEnableTtlParams`** — **`UpdateTimeToLive`** after the table exists).
3. Pass **`tableName`** and a **`DynamoDBDocumentClient`** into **`DynamoStore`** or **`dynamoPreset({ client, tableName })`**.

If you rename the TTL attribute, set **`ttlAttribute`** on **`DynamoStoreOptions`**.

## Exact vs approximate strategies

| Strategy | Exactness |
|----------|-----------|
| **Fixed window** | **Exact** — single **`UpdateItem`** path with conditional logic. |
| **Token bucket** | **Exact** — refill + consume in one update. |
| **Sliding window** | **Approximate** — see below. |

## Sliding window: weighted sub-windows

DynamoDB does not offer Redis-style ordered sets or cheap “count events in this ms range” primitives in one atomic update the way we need for a **perfect** sliding window. **`DynamoStore`** therefore implements a **weighted sub-window** estimator:

- The window is divided into conceptual sub-buckets; each increment contributes weight; **`weightedSlidingCount`** / **`sliding-weighted`** helpers in the package implement the math.
- **Typical** error under steady traffic: **&lt; ~2%**.
- **Worst-case** near window boundaries (documented in **`DynamoStore`**): up to **~10%** transient error.

For **exact** sliding windows, use **`RedisStore`**, **`PgStore`**, or **`MongoStore`**.

## TTL cleanup

DynamoDB’s **managed TTL** deletes expired items using the **`ttl`** attribute (Unix epoch seconds). No application cron is required; allow time for the TTL background process after **`reset_at`**.

## Throttling and errors

The AWS SDK may throw **`ProvisionedThroughputExceededException`**, **`ThrottlingException`**, etc. This package **does not** retry automatically — configure retries on **`DynamoDBClient`**. Use **`onDynamoError`** (**fail-open** / **fail-closed**) on **`DynamoStore`** for application-level policy.

## Presets and constructor defaults

- **`new DynamoStore({ client, tableName })`** uses **`FIXED_WINDOW`** when **`strategy`** is omitted — same rationale as the preset (exact counts).
- **`dynamoPreset({ client, tableName })`** defaults to **fixed window** (exact) and **`inMemoryBlock: true`**. Opt into **`RateLimitStrategy.SLIDING_WINDOW`** only when you accept the approximation.

## Troubleshooting

| Symptom | Things to check |
|--------|-------------------|
| **`ResourceNotFoundException`** | Table name / region mismatch; deploy **`CreateTable`** first. |
| Items never deleted | TTL not enabled or wrong attribute name (**`ttlAttribute`**). |
| Sliding window feels “loose” | Expected for weighted mode; switch strategy or backend if you need exact counts. |
