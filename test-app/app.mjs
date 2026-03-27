import express from 'express';
import rateLimit, {
  RateLimitStrategy,
  expressRateLimiter,
  createRateLimiter,
} from '../dist/index.js';

const app = express();

app.use(
  rateLimit({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    maxRequests: 10,
    windowMs: 60_000,
  }),
);

app.use('/strict', expressRateLimiter({ maxRequests: 2, windowMs: 60_000 }));

const limiter = createRateLimiter({ maxRequests: 5, windowMs: 30_000 });
app.use('/api', limiter.express);

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

console.log('✅ ratelimit-flex dist import ok');
console.log('✅ default export:', typeof rateLimit);
console.log('✅ named exports:', typeof expressRateLimiter, typeof createRateLimiter);
console.log('✅ createRateLimiter returns:', Object.keys(limiter));
