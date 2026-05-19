# Admin HTTP audit envelopes (`schemaVersion: "1"`)

**`AdminRouterOptions.onAdminAction`** receives `{ method, path, key?, actor?, timestamp }`. To feed SIEM tooling emit **NDJSON** lines built from **`toAdminHttpAuditEnvelopeV1`** + **`formatAdminHttpAuditNdjsonV1`** (exported from **`ratelimit-flex`** alongside **`createAdminRouter`**).

Example:

```ts
import {
  createAdminRouter,
  formatAdminHttpAuditNdjsonV1,
  toAdminHttpAuditEnvelopeV1,
} from 'ratelimit-flex';

const router = createAdminRouter({
  auth: { type: 'bearer', token: process.env.ADMIN_TOKEN! },
  km,
  onAdminAction(evt) {
    process.stdout.write(formatAdminHttpAuditNdjsonV1(toAdminHttpAuditEnvelopeV1(evt)));
  },
});
```

Each line is one JSON object: **`schemaVersion`**, envelope **`emittedAtIso`**, and **`event`** with ISO **`timestamp`** for stable parsing.
