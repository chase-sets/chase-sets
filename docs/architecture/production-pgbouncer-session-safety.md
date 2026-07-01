# Production PgBouncer Session-Safety Audit

Issue: #3226

## Decision

Do not route production `DATABASE_URL_*` runtime traffic through DigitalOcean transaction-mode PgBouncer yet.

Normal bounded-context reads and writes are mostly compatible with transaction pooling, but the same runtime URLs currently also feed work-signal waiters that may attempt `LISTEN` before falling back to bounded polling. DigitalOcean documents transaction pooling as the general-use pooling mode, but session-level behavior such as prepared statements, advisory locks, and listen/notify belongs on session or direct connections. Routing every production runtime URL to transaction pools now would reduce direct backend pressure at the cost of degrading production notification latency in paths that still expect session-compatible waiters.

Production pooling remains a good target after #3234 splits work-signal waiter connections from transaction-pooled query traffic.

## Source Rules

- DigitalOcean managed PostgreSQL exposes separate client and backend connection concepts for connection pools. Backend pool size consumes the database cluster connection budget.
- DigitalOcean transaction-mode PgBouncer queues work by transaction and is useful for many idle clients.
- Session-level PostgreSQL behavior, including listen/notify, must stay on direct or session-compatible connections.
- `pg_dump`, bootstrap, grant, migration, and admin/maintenance paths must bypass transaction pools.

## Current Traffic Classes

| Class | Current path | Pooling posture |
| --- | --- | --- |
| Bounded-context API and worker query traffic | `DATABASE_URL_<CONTEXT>` and `PLATFORM_CONTROL_DATABASE_URL` | Candidate for transaction pooling only after work-signal waiters are split from these URLs. |
| Event-store `pg_notify` emission | Caller transaction queryable | Transaction-pool-safe as an emission hint; durable event rows remain authoritative. |
| Work-signal waiters | `createPostgresWorkSignalWaiter` over the same runtime pool | Direct/session-compatible until #3234 provides a separate waiter URL or equivalent split. |
| Projection wake relay source listeners | `WORKER_LISTENER_DATABASE_URL_<CONTEXT>` | Direct-only and least-privilege; never transaction-pooled. |
| Bootstrap, migrations, grants, and production maintenance | App Platform bindings or Terraform/admin direct URLs | Direct-only. |
| Realtime cleanup and retention | Runtime pool with bounded advisory-lock usage | Keep on current direct production posture until the waiter split proves transaction-pool safety. |

## Audit Evidence

Approved direct/session behavior found in the repo:

- `infrastructure/platform-runtime/work-signal-composite.ts` owns `LISTEN` and `UNLISTEN` for shared work-signal waiters.
- `infrastructure/platform-runtime/durable-job-store.ts`, `durable-job-work-units.ts`, and `control-plane.ts` wait through work-signal composite surfaces.
- `infrastructure/platform-runtime/realtime-outbox-store.ts` uses realtime notification and retention paths over runtime pools.
- `deployables/platform-worker/src/main.ts` already creates dedicated projection wake relay listener pools from `WORKER_LISTENER_DATABASE_URL_<CONTEXT>`.
- `infrastructure/digitalocean/platform/main.tf` already keeps projection wake listener URLs on dedicated wake-listener users and checks that they do not regress to owning context users or App Platform bindings.

## Rollout Gate

Before enabling production transaction pools for runtime query traffic:

1. Complete #3234 so work-signal waiters do not depend on transaction-pooled runtime URLs for production notification latency.
2. Keep projection wake relay listeners on `WORKER_LISTENER_DATABASE_URL_<CONTEXT>`.
3. Add Terraform-managed production transaction pools only for query-safe traffic.
4. Update the connection-budget model to count production PgBouncer backend allocation separately from direct listener, bootstrap, and maintenance demand.
5. Prove staging and production plan output before setting any production pooling toggle.

## Rollback

The rollback path is to keep or restore production runtime `DATABASE_URL_*` values to App Platform direct bindings. Production transaction pooling must remain opt-in until release-health evidence shows notification latency, API traffic, worker runners, and deploy overlap fit the modeled budget.
