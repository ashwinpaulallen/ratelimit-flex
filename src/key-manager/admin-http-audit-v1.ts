/**
 * Versioned envelopes for **`createAdminRouter` / Fastify plugin** **`onAdminAction`** payloads.
 *
 * @description Persist these as structured logs (stdout → Loki/Datadog) or enqueue to your SIEM. The envelope
 * is intentionally small and forwards-compatible: bump **`schemaVersion`** only when introducing breaking JSON shape changes.
 *
 * @see docs/key-manager/ADMIN_AUDIT_SCHEMA.md
 */

export const ADMIN_HTTP_AUDIT_SCHEMA_VERSION = '1' as const;

/**
 * Mirrors the **`onAdminAction`** callback payload from {@link AdminRouterOptions}.
 */
export interface AdminHttpAuditEventV1 {
  method: string;
  path: string;
  key?: string;
  actor?: string;
  timestamp: Date;
}

/** Single NDJSON-ready record for ingestion pipelines (`schemaVersion` + **`event`** + wall-clock **`emittedAtIso`**). */
export interface AdminHttpAuditEnvelopeV1 {
  schemaVersion: typeof ADMIN_HTTP_AUDIT_SCHEMA_VERSION;
  emittedAtIso: string;
  event: AdminHttpAuditEventV1;
}

/** Build a **`1`**-schema envelope (ISO-8601 millisecond timestamps are JSON-safe strings). */
export function toAdminHttpAuditEnvelopeV1(event: AdminHttpAuditEventV1): AdminHttpAuditEnvelopeV1 {
  return {
    schemaVersion: ADMIN_HTTP_AUDIT_SCHEMA_VERSION,
    emittedAtIso: new Date().toISOString(),
    event,
  };
}

/** `JSON.stringify` helper that emits stable ISO timestamps for **`event.timestamp`**. */
export function formatAdminHttpAuditNdjsonV1(envelope: AdminHttpAuditEnvelopeV1): string {
  return `${JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    emittedAtIso: envelope.emittedAtIso,
    event: {
      ...envelope.event,
      timestamp:
        envelope.event.timestamp instanceof Date
          ? envelope.event.timestamp.toISOString()
          : envelope.event.timestamp,
    },
  })}\n`;
}
