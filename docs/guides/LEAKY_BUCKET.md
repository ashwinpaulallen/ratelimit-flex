# Leaky bucket vs **`TOKEN_BUCKET`** in ratelimit-flex

Traditional **leaky buckets** drip out work at constant rate irrespective of instantaneous arrivals unless the bucket is idle. **`ratelimit-flex`** implements a **classic token bucket**:

- Credits **refill in batches** (`tokensPerInterval` every `interval` ms once traffic occurs).
- **Burst allowance** capped by **`bucketSize`**.

To approximate leaky behavior choose **fine `interval` + small bursts** (`bucketSize≈steadyRate*interval`). For metering smoothness closer to leaky semantics, clamp **`incrementCost`** using business rules (slow endpoints cost more). See presets **`apiGatewayPreset`** for pragmatic defaults.

If you genuinely need leaky-with-continuous-drains, compose a **`RateLimiterQueue`** emitting work at scheduler cadence—but that solves **traffic shaping**, distinct from HTTP **`429`** guarding.
