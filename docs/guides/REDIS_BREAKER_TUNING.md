# Redis circuit breaker tuning playbook

Signals you need softer defaults:

| Symptom | Knob (`RedisResilienceOptions`) | Commentary |
|---------|---------------------------------|------------|
| Frequent failover flapping | **`failureThreshold`** ↑ (e.g. 8‑12) | Avoids jittery clouds |
| Takes too long to trust Redis again | **`recoveryTimeMs`** ↓ slightly | Faster **OPEN→HALF_OPEN** probing |
| Long tail latency bursts | Tune client socket **`connectTimeout/commandTimeout`** externally + larger **`recoveryTimeMs`** | Breaker reacts to systemic slowness, not micro-spikes |

Validate with staged chaos (tcpkill on Redis replicas) verifying insurance counters converge.
