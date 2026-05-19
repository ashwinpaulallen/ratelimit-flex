# Internationalizing **`message`**

`expressRateLimiter` / Fastify merges `message`:

- Prefer returning **stable machine keys + params** wrapped by your presenter:
  ```ts
  expressRateLimiter({
    message(req) {
      return { code: 'rate_limit.exceeded', retryAfterApprox: deriveSeconds(req) };
    },
  });
  ```
- Client layers map `code`. Keep HTTP status codes stable (`429`).
- **`skipResponse` refunds** unaffected—wrap only final JSON writer.
