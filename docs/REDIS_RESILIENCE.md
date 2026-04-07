# Redis Resilience

Handle Redis outages gracefully with insurance limiters, circuit breakers, and counter synchronization.

## Table of Contents

- [Overview](#overview)
- [Problem Statement](#problem-statement)
- [Solution: Insurance Limiter](#solution-insurance-limiter)
- [Manual Setup](#manual-setup)
- [Preset Configuration](#preset-configuration)
- [Circuit Breaker](#circuit-breaker)
- [Counter Synchronization](#counter-synchronization)
- [Comparison: fail-open/fail-closed vs Insurance](#comparison-fail-openfail-closed-vs-insurance)
- [Observability Hooks](#observability-hooks)
- [HTTP Headers](#http-headers)

---

## Overview

When Redis is unavailable, the default **`fail-open`** / **`fail-closed`** modes either allow every request or block every request globally—there is no per-client quota during the outage.

An **insurance limiter** fixes that: a dedicated **`MemoryStore`** that activates automatically when the circuit breaker decides Redis is unhealthy, so each process still enforces **per-process** limits.

---

## Problem Statement

**Without insurance limiter:**
- **fail-open**: All requests allowed during Redis outage (no rate limiting)
- **fail-closed**: All requests blocked during Redis outage (total service disruption)

**Neither option provides per-client rate limiting during outages.**

---

## Solution: Insurance Limiter

Configure an in-memory cap as roughly **total shared limit ÷ expected worker count**:

**Example:** 300 requests/minute across 5 replicas → **60 requests/minute per process**

During Redis outages, each process enforces its own 60 req/min limit, keeping total traffic around 300 req/min (5 × 60).

---

## Manual Setup

```typescript
import { expressRateLimiter, RedisStore, MemoryStore, RateLimitStrategy } from 'ratelimit-flex';

const insuranceStore = new MemoryStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 60, // 300 / 5 workers
});

const store = new RedisStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 300,
  url: process.env.REDIS_URL!,
  resilience: {
    insuranceLimiter: { store: insuranceStore },
    circuitBreaker: { failureThreshold: 3, recoveryTimeMs: 5000 },
    hooks: {
      onFailover: (err) => console.error('Redis down, using fallback', err),
      onRecovery: (ms) => console.log(`Redis recovered after ${ms}ms`),
    },
  },
});

app.use(expressRateLimiter({ store, strategy: RateLimitStrategy.SLIDING_WINDOW }));
```

---

## Preset Configuration

`resilientRedisPreset` wires **Redis** + **insurance `MemoryStore`** + **circuit breaker** and estimates worker count from the environment:

```typescript
import { expressRateLimiter, resilientRedisPreset } from 'ratelimit-flex';

app.use(expressRateLimiter(
  resilientRedisPreset(
    { url: process.env.REDIS_URL! },
    { maxRequests: 300, estimatedWorkers: 5 }
  )
));
```

**Automatic worker estimation:**
- Detects Kubernetes, Docker, PM2, cluster mode
- Falls back to manual `estimatedWorkers` if detection fails
- Divides global limit by worker count for per-process insurance limit

---

## Circuit Breaker

The breaker around Redis has three states:

### Closed (Normal Operation)
- Redis is used for all operations
- Successes reset failure streaks
- System operates normally

### Open (Redis Unavailable)
- Too many consecutive failures detected
- Requests are **not** sent to Redis
- Insurance store handles all requests
- Avoids wasted round-trips to dead server

### Half-Open (Recovery Probe)
- After recovery window, allows one Redis attempt
- **Success** → circuit closes, Redis restored
- **Failure** → circuit reopens, continues using insurance

**Configuration:**
```typescript
circuitBreaker: {
  failureThreshold: 3,     // Open after 3 consecutive failures
  recoveryTimeMs: 5000,    // Wait 5s before probing
}
```

---

## Counter Synchronization

When the circuit **closes** again after an outage, accumulated hits in the insurance **`MemoryStore`** can be **replayed into Redis** so shared state catches up.

**Default:** `syncOnRecovery: true`

### How It Works

**Sliding Window:**
- Bulk-inserts synthetic hits with timestamps at recovery time
- Counts match actual usage during outage
- Visible window is not time-smoothed across outage

**Fixed Window:**
- Increments Redis counter by accumulated count
- Preserves window boundaries

**Token Bucket:**
- Adjusts token count based on insurance usage
- Maintains refill schedule

**Disable sync:**
```typescript
resilience: {
  insuranceLimiter: { 
    store: insuranceStore,
    syncOnRecovery: false, // Don't replay to Redis
  },
}
```

---

## Comparison: fail-open/fail-closed vs Insurance

| Feature | fail-open / fail-closed | Insurance limiter |
|---------|------------------------|-------------------|
| Redis down behavior | Allow all or block all | Fallback to in-memory rate limiting |
| Rate limiting during outage | None (open) or total block (closed) | Per-process limits enforced |
| Circuit breaker | No | Yes — avoids wasted Redis round-trips |
| Counter sync on recovery | No | Yes — replays in-memory hits to Redis |
| Observability hooks | `onRedisError` only | `onFailover`, `onRecovery`, `onCircuitOpen`, `onCircuitClose`, `onInsuranceHit`, `onCounterSync` |

**When insurance is configured, it replaces the binary fail-open/fail-closed behavior for quota operations.**

---

## Observability Hooks

### Available Hooks

```typescript
resilience: {
  hooks: {
    // Circuit state changes
    onCircuitOpen: (error) => {
      console.error('Circuit opened:', error);
      alerting.notify('Redis circuit breaker opened');
    },
    
    onCircuitClose: () => {
      console.log('Circuit closed, Redis restored');
      alerting.notify('Redis circuit breaker closed');
    },
    
    // Failover events
    onFailover: (error) => {
      console.error('Failover to insurance limiter:', error);
      metrics.increment('redis.failover');
    },
    
    onRecovery: (downtimeMs) => {
      console.log(`Redis recovered after ${downtimeMs}ms`);
      metrics.histogram('redis.downtime', downtimeMs);
    },
    
    // Insurance usage
    onInsuranceHit: (key) => {
      metrics.increment('insurance.hits', { key });
    },
    
    // Counter sync
    onCounterSync: (key, count) => {
      console.log(`Synced ${count} hits for ${key} to Redis`);
    },
  },
}
```

### Monitoring Example

```typescript
import { expressRateLimiter, RedisStore, MemoryStore, RateLimitStrategy } from 'ratelimit-flex';

let redisDowntime = 0;
let lastFailover: Date | null = null;

const store = new RedisStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 300,
  url: process.env.REDIS_URL!,
  resilience: {
    insuranceLimiter: { 
      store: new MemoryStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 60,
      }),
    },
    circuitBreaker: { failureThreshold: 3, recoveryTimeMs: 5000 },
    hooks: {
      onFailover: (err) => {
        lastFailover = new Date();
        console.error('Redis failover:', err.message);
        
        // Alert operations team
        alerting.critical('Redis rate limiter down, using insurance', {
          error: err.message,
          timestamp: lastFailover,
        });
      },
      
      onRecovery: (ms) => {
        redisDowntime += ms;
        console.log(`Redis recovered after ${ms}ms (total downtime: ${redisDowntime}ms)`);
        
        // Clear alert
        alerting.resolve('Redis rate limiter restored', {
          downtime: ms,
          totalDowntime: redisDowntime,
        });
      },
      
      onInsuranceHit: (key) => {
        // Track which keys are hitting insurance limiter
        metrics.increment('insurance_hits', { key });
      },
    },
  },
});

app.use(expressRateLimiter({ store }));

// Expose metrics endpoint
app.get('/health/redis', (req, res) => {
  res.json({
    status: lastFailover ? 'degraded' : 'healthy',
    lastFailover,
    totalDowntime: redisDowntime,
    usingInsurance: !!lastFailover,
  });
});
```

---

## HTTP Headers

Middleware sets **`X-RateLimit-Store: fallback`** when `storeUnavailable` is true (insurance path) so monitors can tell primary Redis from fallback.

**Normal operation:**
```http
X-RateLimit-Store: redis
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 250
```

**During failover:**
```http
X-RateLimit-Store: fallback
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
```

---

## Configuration Options

### InsuranceLimiterOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `RateLimitStore` | — | Insurance store (usually `MemoryStore`) |
| `syncOnRecovery` | `boolean` | `true` | Replay insurance hits to Redis on recovery |

### CircuitBreakerOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `failureThreshold` | `number` | `3` | Consecutive failures before opening |
| `recoveryTimeMs` | `number` | `5000` | Wait time before probing (ms) |

### ResilienceHooks

| Hook | Parameters | Description |
|------|------------|-------------|
| `onCircuitOpen` | `(error: Error)` | Circuit breaker opened |
| `onCircuitClose` | `()` | Circuit breaker closed |
| `onFailover` | `(error: Error)` | Switched to insurance limiter |
| `onRecovery` | `(downtimeMs: number)` | Redis restored |
| `onInsuranceHit` | `(key: string)` | Request served by insurance |
| `onCounterSync` | `(key: string, count: number)` | Counters synced to Redis |

---

## Best Practices

### 1. Size Insurance Limits Appropriately

```typescript
// Global limit: 1000 req/min across 10 workers
// Insurance limit per worker: 1000 / 10 = 100 req/min

const insuranceStore = new MemoryStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100, // Per-process limit
});
```

### 2. Monitor Failover Events

```typescript
hooks: {
  onFailover: (err) => {
    // Alert immediately - Redis is down
    pagerDuty.trigger('redis-down', { error: err.message });
  },
  
  onRecovery: (ms) => {
    // Resolve alert - Redis is back
    pagerDuty.resolve('redis-down', { downtime: ms });
  },
}
```

### 3. Test Failover Behavior

```typescript
// Simulate Redis outage in staging
describe('Redis failover', () => {
  it('should use insurance limiter when Redis is down', async () => {
    // Stop Redis
    await redis.disconnect();
    
    // Verify insurance limiter activates
    const response = await request(app).get('/api/endpoint');
    expect(response.headers['x-ratelimit-store']).toBe('fallback');
    
    // Restart Redis
    await redis.connect();
    
    // Verify Redis restored
    const response2 = await request(app).get('/api/endpoint');
    expect(response2.headers['x-ratelimit-store']).toBe('redis');
  });
});
```

### 4. Adjust Circuit Breaker Thresholds

```typescript
// Sensitive (opens quickly)
circuitBreaker: {
  failureThreshold: 2,      // Open after 2 failures
  recoveryTimeMs: 10_000,   // Wait 10s before probing
}

// Tolerant (waits longer)
circuitBreaker: {
  failureThreshold: 5,      // Open after 5 failures
  recoveryTimeMs: 30_000,   // Wait 30s before probing
}
```

---

## See Also

- [Main README](../README.md#redis-resilience) - Quick overview
- [Redis Failure Handling](../README.md#redis-failure-handling) - fail-open vs fail-closed
- [Deployment Guide](../README.md#deployment-guide) - Production patterns
- [Presets](../README.md#presets) - `resilientRedisPreset`
