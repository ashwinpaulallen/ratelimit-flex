# Redis namespaces on shared clusters

Operational checklist:

1. **`keyPrefix`** per tenant (`rlf:${tenant_id}:`) so counters never collide—even if attackers guess raw keys elsewhere.
2. **ACL / AUTH token per logical tenant** whenever security isolates quotas (Upstash/AWS IAM style).
3. **Monitor hot partition keys**: extremely hot API keys amortize shards poorly on Redis Cluster—fan out **`keyGenerator`** fan-in with hashed suffix.
4. **Failover stories**: resilient presets still need **matching insurance store window** sizing—coordinate with infra for rolling deploy length.
