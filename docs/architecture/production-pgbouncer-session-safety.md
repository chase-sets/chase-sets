# Production PgBouncer Session-Safety Audit

Issues: #3226, refreshed by #3342, landed by #4655

## Decision

Production `DATABASE_URL_*` query traffic runs through DigitalOcean transaction-mode PgBouncer pools. #4655 converged production query traffic onto managed transaction pools, mirroring the staging pooled shape and closing the last deliberate staging/production database-topology asymmetry. Session-level and `LISTEN` paths stay direct.

Normal bounded-context reads and writes are compatible with transaction pooling. DigitalOcean documents transaction pooling as the general-use pooling mode, while session-level behavior such as prepared statements, session advisory locks, and listen/notify belongs on session or direct connections. Production therefore keeps direct/session-compatible paths for work-signal, context-owned waiter, relay-listener, and schema-bootstrap traffic while ordinary query traffic rides the pools.

The #3342 refresh set the convergence direction (`production_pgbouncer_ready = false` until plan evidence existed); #4655 flips it true. Server-side pool sizes cap cluster backends regardless of client count, so KEDA burst worker scaling (#4057) stays budget-safe: production rolling-deploy overlap demand is 63/94 on `db-s-2vcpu-4gb`, below the 80% (75) tier-upgrade trigger, and adding `platform-api` or `platform-worker` instances adds zero cluster backends to that envelope.

## Source Rules

- DigitalOcean managed PostgreSQL exposes separate client and backend connection concepts for connection pools. Backend pool size consumes the database cluster connection budget.
- DigitalOcean transaction-mode PgBouncer queues work by transaction and is useful for many idle clients.
- Session-level PostgreSQL behavior, including listen/notify and session advisory locks held across statements, must stay on direct or session-compatible connections.
- `pg_dump`, schema bootstrap, grant, migration, and admin/maintenance paths must bypass transaction pools.

## Session-State Audit (#4655)

Every steady-state production query path was checked for session-scoped state before pooling. Advisory-lock usage is the only session-adjacent construct in the query paths, and it is transaction-scoped or single-statement everywhere it touches pooled traffic:

- `infrastructure/event-core-postgres/event-store.ts` acquires the global append lock with `pg_advisory_xact_lock` (transaction-scoped per #3636), released at commit — pool-safe.
- `infrastructure/platform-runtime/realtime-outbox-store.ts` acquires the outbox append lock with `pg_advisory_xact_lock` — pool-safe.
- `infrastructure/platform-runtime/realtime-outbox-store.ts` retention prune acquires `pg_try_advisory_lock` and releases `pg_advisory_unlock` inside a single CTE statement (one implicit transaction, one backend) — pool-safe.
- The only session-scoped path is the schema bootstrap (`infrastructure/bounded-context-runtime/schema.ts`), which holds a session advisory lock plus `SET lock_timeout` across multiple statements. It is a deploy-time migration path, not steady-state query traffic. DOKS staging and production bootstrap containers read dedicated `BOOTSTRAP_DATABASE_URL_*` / `BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL` secret keys populated from direct cluster URLs by `.github/workflows/platform-production.yml`; the interim App Platform bootstrap job rides the same pooled URLs staging has proven (single instance, worker quiesced, idempotent DDL).

No prepared-statement pinning, session GUC persistence, temp tables, `WITH HOLD` cursors, or `LISTEN` were found in the pooled query paths. `pg_notify` emission is transaction-pool-safe as a wake hint; durable event rows remain authoritative.

## Current Traffic Classes

| Class | Current path | Pooling posture |
| --- | --- | --- |
| Bounded-context API and worker query traffic | `DATABASE_URL_<CONTEXT>` and `PLATFORM_CONTROL_DATABASE_URL` | Pooled through managed transaction pools in every environment (#4655). |
| Event-store `pg_notify` emission | Caller transaction queryable | Transaction-pool-safe as an emission hint; durable event rows remain authoritative. |
| Platform control-plane work-signal store and projection-operation waiters | `PLATFORM_WORK_SIGNAL_DATABASE_URL` | Direct/session-compatible; falls back to `PLATFORM_CONTROL_DATABASE_URL` until a separate URL is configured. |
| Context-owned durable/realtime waiters | `DATABASE_URL_<CONTEXT>_WAITER` for `catalog`, `discovery`, `inventory`, and `marketplace` | Direct/session-compatible; falls back to the context query pool only when no waiter URL is configured. |
| Projection wake relay source listeners | `WORKER_LISTENER_DATABASE_URL_<CONTEXT>` | Direct-only and least-privilege; never transaction-pooled. |
| Schema bootstrap, migrations, grants, and production maintenance | DOKS-exported `BOOTSTRAP_*` direct cluster URLs, Terraform/admin direct URLs, or the interim App Platform bootstrap job | Direct-only for the DOKS session advisory lock; the interim App Platform bootstrap job rides the staging-proven pooled URLs. |
| Realtime cleanup and retention | Runtime pool with single-statement advisory-lock usage | Transaction-pool-safe (acquire and release inside one CTE statement). |

## Audit Evidence

Approved direct/session behavior found in the repo:

- `infrastructure/platform-runtime/work-signal-composite.ts` owns `LISTEN` and `UNLISTEN` for shared work-signal waiters.
- `deployables/platform-api/src/main.ts` wires the platform control-plane work-signal store and projection-operation waits through `PLATFORM_WORK_SIGNAL_DATABASE_URL`.
- `deployables/platform-api/src/main.ts` wires realtime wake listeners through mounted context `notificationWaiterPool` entries while realtime replay reads stay on ordinary context pools.
- `infrastructure/platform-runtime/durable-job-store.ts`, `durable-job-work-units.ts`, and `control-plane.ts` wait through work-signal composite surfaces.
- `infrastructure/platform-runtime/durable-job-store.ts` accepts `notificationWaiterPool` for context-owned durable job event waits while durable job writes stay on ordinary context pools.
- `infrastructure/platform-runtime/realtime-outbox-store.ts` uses realtime notification and retention paths over runtime pools with single-statement advisory locks.
- `deployables/platform-worker/src/main.ts` already creates dedicated projection wake relay listener pools from `WORKER_LISTENER_DATABASE_URL_<CONTEXT>`.
- `infrastructure/digitalocean/platform/main.tf` keeps projection wake listener URLs on dedicated wake-listener users and checks that they do not regress to owning context users or App Platform bindings, and now provisions per-context production query pools (`production_context_database_connection_pool_size_overrides`).

## Rollout Gate (completed by #4655)

Production transaction pools for runtime query traffic were enabled with these invariants held:

1. Platform work-signal waiters stay on `PLATFORM_WORK_SIGNAL_DATABASE_URL`.
2. Context-owned durable/realtime waiters stay on `DATABASE_URL_<CONTEXT>_WAITER`.
3. Projection wake relay listeners stay on `WORKER_LISTENER_DATABASE_URL_<CONTEXT>`.
4. Session-scoped schema bootstrap stays on direct/session URLs.
5. Add Terraform-managed production transaction pools only for query-safe traffic.
6. The connection-budget model counts production PgBouncer backend allocation (`pgbouncer_server_backend_allocation`) separately from direct listener, waiter, bootstrap, and maintenance demand.
7. Staging and production plan output proves no destructive database actions (no delete/replace of `digitalocean_database_cluster.postgres` or context databases/users) before setting `production_pgbouncer_ready = true`.

## Rollback

The rollback path is to restore production runtime `DATABASE_URL_*` values to direct cluster URLs by reverting `production_pgbouncer_ready` and the pooled `context_database_urls` derivation. Rolling back pooling only changes the app-query connection path; it never deletes the pools, databases, or users, and the connection budget already models both postures.
