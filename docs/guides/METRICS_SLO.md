# Grafana / Prometheus SLO starters

Assuming default metric names wired through **`metrics.prometheus`** (see **[`METRICS.md`](../METRICS.md)** for canonical labels):

```
# Ratio of Redis fail-closed / insurance paths (customize metric text)
rate(ratelimit_flex_redis_fallback_total{result="blocked"}[5m])
  /
(rate(ratelimit_flex_requests_total[5m]) + 1e-6)

# Shield hit dominance (helps validate `inMemoryBlock` tuning)
sum(rate(ratelimit_flex_shield_hits_total[5m]))
  /
sum(rate(ratelimit_flex_shield_misses_total[5m])+1)

# Compose layer tightness variance (histogram if enabled)
histogram_quantile(
  0.95,
  sum by (le)(
    ratelimit_flex_compose_latency_seconds_bucket)
)
```

Tune label names (`job`, `instance`, `strategy`) according to Prometheus relabel configs.
