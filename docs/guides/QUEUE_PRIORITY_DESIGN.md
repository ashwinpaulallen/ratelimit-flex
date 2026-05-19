# Priority-aware queues (draft spec — not shipped in core yet)

Goals:

1. **Tenant / plan hints** enqueue waiters deterministically (**enterprise** drains before noisy neighbors) without indefinite starvation.
2. **FIFO fairness** preserved within identical priority strata.
3. **Opt-in starvation guard**: starvation watchdog requeues stalled waiters ≥ **N s**.
4. **Engine parity**: prioritized queue MUST still decrement using **`matchingDecrementOptions`** on skip-response rules.

Suggested API sketch (discussion only):

```ts
type QueuePriorityTier = number; // ascending = hotter

interface PrioritizedEnqueueOptions<T> {
  key: string;
  priorityHint: QueuePriorityTier;
  task: () => Promise<T>;
}
```

Implementation target: **`KeyedRateLimiterQueue`** variant + stable heap per key with audit metrics.

Track future work issue when demand exists.
