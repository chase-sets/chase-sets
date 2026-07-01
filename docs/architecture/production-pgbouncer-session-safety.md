# Production PgBouncer Session-Safety Audit

Issue: #3226

## Decision

Do not route production `DATABASE_URL_*` runtime traffic through DigitalOcean transaction-mode PgBouncer yet.

Normal bounded-context reads and writes are mostly compatible with transaction pooling. DigitalOcean documents transaction pooling as the general-use pooling mode, but session-level behavior such as prepared statements, advisory locks, and listen/notify belongs on session or direct connections. Production runtime URLs must therefore keep direct/session-compatible paths for work-signal and context-owned waiter traffic while ordinary query traffic moves independently.

Production pooling remains a good target after a dedicated rollout adds Terraform-managed production transaction pools for query-safe traffic and proves the modeled direct waiter topology.

## Source Rules

- DigitalOcean managed PostgreSQL exposes separate client and backend connection concepts for connection pools. Backend pool size consumes the database cluster connection budget.
- DigitalOcean transaction-mode PgBouncer queues work by transaction and is useful for many idle clients.
- Session-level PostgreSQL behavior, including listen/notify, must stay on direct or session-compatible connections.
- `pg_dump`, bootstrap, grant, migration, and admin/maintenance paths must bypass transaction pools.

## Current Traffic Classes

| Class | Current path | Pooling posture |
| --- | --- | --- |
| Bounded-context API and worker query traffic | `DATABASE_URL_<CONTEXT>` and `PLATFORM_CONTROL_DATABASE_URL` | Candidate for transaction pooling through a dedicated rollout. |
| Event-store `pg_notify` emission | Caller transaction queryable | Transaction-pool-safe as an emission hint; durable event rows remain authoritative. |
| Platform control-plane work-signal store and projection-operation waiters | `PLATFORM_WORK_SIGNAL_DATABASE_URL` | Direct/session-compatible; falls back to `PLATFORM_CONTROL_DATABASE_URL` until a separate URL is configured. |
| Context-owned durable/realtime waiters | `DATABASE_URL_<CONTEXT>_WAITER` for `catalog`, `discovery`, `inventory`, and `marketplace` | Direct/session-compatible; falls back to the context query pool only when no waiter URL is configured. |
| Projection wake relay source listeners | `WORKER_LISTENER_DATABASE_URL_<CONTEXT>` | Direct-only and least-privilege; never transaction-pooled. |
| Bootstrap, migrations, grants, and production maintenance | App Platform bindings or Terraform/admin direct URLs | Direct-only. |
| Realtime cleanup and retention | Runtime pool with bounded advisory-lock usage | Keep on current direct production posture until the waiter split proves transaction-pool safety. |

## Audit Evidence

Approved direct/session behavior found in the repo:

- `infrastructure/platform-runtime/work-signal-composite.ts` owns `LISTEN` and `UNLISTEN` for shared work-signal waiters.
- `deployables/platform-api/src/main.ts` wires the platform control-plane work-signal store and projection-operation waits through `PLATFORM_WORK_SIGNAL_DATABASE_URL`.
- `deployables/platform-api/src/main.ts` wires realtime wake listeners through mounted context `notificationWaiterPool` entries while realtime replay reads stay on ordinary context pools.
- `infrastructure/platform-runtime/durable-job-store.ts`, `durable-job-work-units.ts`, and `control-plane.ts` wait through work-signal composite surfaces.
- `infrastructure/platform-runtime/durable-job-store.ts` accepts `notificationWaiterPool` for context-owned durable job event waits while durable job writes stay on ordinary context pools.
- `infrastructure/platform-runtime/realtime-outbox-store.ts` uses realtime notification and retention paths over runtime pools.
- `deployables/platform-worker/src/main.ts` already creates dedicated projection wake relay listener pools from `WORKER_LISTENER_DATABASE_URL_<CONTEXT>`.
- `infrastructure/digitalocean/platform/main.tf` already keeps projection wake listener URLs on dedicated wake-listener users and checks that they do not regress to owning context users or App Platform bindings.

## Rollout Gate

Before enabling production transaction pools for runtime query traffic:

1. Keep platform work-signal waiters on `PLATFORM_WORK_SIGNAL_DATABASE_URL`.
2. Keep context-owned durable/realtime waiters on `DATABASE_URL_<CONTEXT>_WAITER`.
3. Keep projection wake relay listeners on `WORKER_LISTENER_DATABASE_URL_<CONTEXT>`.
4. Add Terraform-managed production transaction pools only for query-safe traffic.
5. Update the connection-budget model to count production PgBouncer backend allocation separately from direct listener, bootstrap, and maintenance demand.
6. Prove staging and production plan output before setting any production pooling toggle.

## Rollback

The rollback path is to keep or restore production runtime `DATABASE_URL_*` values to App Platform direct bindings. Production transaction pooling must remain opt-in until release-health evidence shows notification latency, API traffic, worker runners, and deploy overlap fit the modeled budget.
