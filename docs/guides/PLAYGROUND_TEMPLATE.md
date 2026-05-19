# Playground starters

Minimal ways to poke algorithms without cloning the whole repo:

1. **`npm install ratelimit-flex`** in a disposable directory.
2. Create `playground.mjs`:

```js
import { createRateLimiter } from 'ratelimit-flex';

const engine = createRateLimiter({ windowMs: 5000, maxRequests: 3 });
console.log(await engine.consume('u1')); // iterate to watch blocks
```
3. For browser demos (StackBlitz, etc.), pin Node **20+** and optionally chart `remaining` vs time as you hammer the same key.
