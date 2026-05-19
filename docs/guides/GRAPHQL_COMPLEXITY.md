# GraphQL: complexity and incrementCost

1. Instrument your parser/post-parse phase to accumulate **estimated cost** (`sum(selection cost)` respecting aliasing limits).
2. Feed cost into **`incrementCost`** (function or **`resolveIncrementOpts`**) keyed by **`req`**:
   ```ts
   incrementCost(req) =>
     graphqlCostFromParsedBody((req as GqlReq).apollo?.document);
   ```
3. For persisted queries, whitelist costs server-side rather than trusting client supplied numbers.
4. Pair skip-response decrement rules with **`matchingDecrementOptions`** so partial handler failures refund fairly.
