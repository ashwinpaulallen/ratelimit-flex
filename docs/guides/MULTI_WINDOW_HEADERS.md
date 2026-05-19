# Multi-window **`RateLimit-Policy` copy-paste snippets

When composing **second-by-second + minute** windows, **`RateLimit`** headers bind to whichever slot dominates for that request (`bindingSlotIndex`), but **`RateLimit-Policy`** SHOULD enumerate each slot for transparency (`draft-6/7`; `draft-8` uses Structured Fields policy names):

### Draft‑6 illustrative

```
RateLimit: limit=600, remaining=540, reset=2
RateLimit: limit=30, remaining=29, reset=60
RateLimit-Policy: 600;w=60, 30;w=10
Retry-After: 2     # whichever slot binds on block
```

### Draft‑8 illustrative (policy identifiers)

```
RateLimit-Policy: "10-per-1";q=600;w=1, "30-per-10";q=30;w=10
RateLimit: "10-per-1";r=540;t=2
Retry-After: 2
```

> Always align identifiers with **`identifier`/`defaultRateLimitIdentifier`** so monitoring sees stable cardinality.
