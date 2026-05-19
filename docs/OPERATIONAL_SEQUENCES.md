# Operational sequences

Mermaid views of runtime paths. Companion to [FAILURE_MODES.md](FAILURE_MODES.md).

## Standard allow path (HTTP, engine middleware)

```mermaid
sequenceDiagram
  participant C as Client
  participant M as Middleware
  participant E as RateLimitEngine
  participant S as Store

  C->>M: HTTP request
  M->>E: consume(key)
  E->>E: allow/block lists, KM block, draft?
  E->>S: increment(key)
  S-->>E: counts + resetTime
  E-->>M: allowed
  M->>C: route + headers
```

## Rollback (`skipSuccessfulRequests` / `skipFailedRequests`)

```mermaid
sequenceDiagram
  participant M as Middleware
  participant S as Store
  participant H as Route handler

  M->>S: increment(key, opts)
  S-->>M: allowed
  M->>H: handler
  H-->>M: response status
  M->>M: rollback rule matches?
  M->>S: decrement(key, matchingDecrementOptions)
```

## Queued inbound request (wake on capacity)

```mermaid
sequenceDiagram
  participant C as Client
  participant Q as RateLimiterQueue
  participant S as Store

  C->>Q: acquire slot (HTTP wrapper)
  Q->>S: increment (when polled)
  S-->>Q: blocked / allowed
  loop while blocked & within wait budget
    Q->>Q: schedule retry / wait
    Q->>S: increment
  end
  Q-->>C: proceed or reject
```

Uses **`store.increment` only** — see [QUEUING.md § Engine parity](QUEUING.md#engine-middleware-vs-queued-middleware-parity).

## Redis resilience: failover to insurance MemoryStore

```mermaid
sequenceDiagram
  participant M as Middleware
  participant RS as RedisStore
  participant CB as Circuit breaker
  participant INS as MemoryStore<br/>(insurance)

  M->>RS: increment via Lua
  alt Redis fails / circuit open
    RS->>CB: record failure
    RS->>INS: increment instead
    INS-->>M: synthetic global budget
  else Redis OK
    RS-->>M: authoritative count
  end
```

Counter replay when Redis closes the circuit again is outlined in **[REDIS_RESILIENCE.md](REDIS_RESILIENCE.md)** and `RedisStore` JSDoc (sliding-window timestamp smearing caveat).
