# Glossary — ratelimit-flex

Brief definitions tying concepts from [`PROJECT_GUIDE_FOR_FRESHERS.md`](PROJECT_GUIDE_FOR_FRESHERS.md) back to observable fields (`RateLimit-*` headers), runtime flags, or docs anchors.

## Insurance limiter / insurance store

Redis resilience path: lightweight **fallback `MemoryStore` limiter** consulted when **`RedisStore` cannot satisfy an increment**. See [`FAILURE_MODES.md`](FAILURE_MODES.md) § Redis down + **`resilientRedisPreset`**.

## Binding window (`bindingSlotIndex`)

When using **`limits[]`** / **`groupedWindowStores`** the engine attaches **`bindingSlotIndex`** to denote which tier bound the **`RateLimit-*` header** approximation (tightest slot). Mentioned throughout [`METRICS.md`](METRICS.md) + [`OPERATIONAL_SEQUENCES.md`](OPERATIONAL_SEQUENCES.md).

## Draft mode (`draft`)

**`draft: true`** keeps counting but **suppresses outward blocks** (`draftWouldBlock`). Used for simulations / shadow rollout. Detailed in middleware JSDoc and [`METRICS.md`](METRICS.md) tracing appendix.

## `storeUnavailable`

Set on **`RateLimitResult`** when the backing store surfaced a **policy-level failure** (`fail-closed` Redis outage, Dynamo throttling surfaced as unavailable, …). Mapped to **`X-RateLimit-Store: fallback`** in Express middleware. See **[`FAILURE_MODES.md`](FAILURE_MODES.md)**.

## Head-of-line blocking (global FIFO queue)

**`QueuedRateLimiterQueue`** drains one waiter globally—good for homogeneous traffic, poor for abusive keys starving others unless you switch to **`KeyedRateLimiterQueue`**. Expanded in **[`QUEUING.md`](QUEUING.md)** + README queuing primer.
