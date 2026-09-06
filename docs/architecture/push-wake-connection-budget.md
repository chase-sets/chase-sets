# Push-Wake Connection Budget

## Purpose

This is the per-environment DigitalOcean managed Postgres connection ledger for the push-first projection wake topology, and the contract behind the plan-time Terraform safety checks `wake_connection_budget` and `wake_listener_topology_parity` in `infrastructure/digitalocean/platform`. It answers three questions before any push-wake phase is enabled:

- How many cluster backend connections each environment can demand in the worst case, and against which database tier.
- Which processes are allowed to hold `LISTEN` connections, on which channels, and why every other listener pattern is rejected.
- How staging and production keep the same logical query/listener/control-plane topology while scaling differently (#1243, #1244, #1236).

The budget locals live in `infrastructure/digitalocean/platform/locals.tf` and the checks in `infrastructure/digitalocean/platform/main.tf`. Both environments are computed from the same locals; only scale knobs (`api_instances`, `worker_instances`, pool maxima, `database_size`) and the staging-first ramp flags differ. Generate a CI-safe evidence record from the checked-in locals with `pnpm run ops push-wake:capacity-evidence -- --out artifacts/release-health/push-wake-capacity-evidence.json`; the script reads no secrets and contacts no live environment.

Terraform also exposes `connection_budget_profiles` so release operators can inspect the resolved profile, active/exposed/provisioned context counts, steady-state demand, rolling-deploy demand, headroom, and the 80% rolling-deploy tier-upgrade trigger. The current pool-max envelope is per process, not per mounted context, so landing mode lowers active route/context surface while the profiled API and worker families keep the production backend-demand model small and explicit.

## PgBouncer Vs Direct Connection Semantics

- **DOKS query traffic is pooled in every managed-Postgres environment (#4655/#4772).** Terraform creates one managed PgBouncer transaction pool per active context database. DOKS API and worker clients connect to PgBouncer; the cluster backends those clients can occupy are capped by the server-side pool `size` values in `context_database_connection_pool_sizes`, not by pod pool maxima. The sum of those sizes is the worst-case backend footprint of all pooled traffic. Production uses explicit overrides in `production_context_database_connection_pool_size_overrides`.
- **DOKS staging query traffic is pooled (#4772).** The Kubernetes Secret exporter reads each `digitalocean_database_connection_pool.contexts` instance from Terraform state. `DATABASE_URL_*` and `PLATFORM_CONTROL_DATABASE_URL` use the provider-returned PgBouncer host/port and the `${context}-runtime` pool name, while `PLATFORM_WORK_SIGNAL_DATABASE_URL`, `DATABASE_URL_*_WAITER`, and `WORKER_LISTENER_DATABASE_URL_*` keep direct cluster URLs. The generated Helm bootstrap component reads dedicated `BOOTSTRAP_DATABASE_URL_*` and `BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL` secret keys, so its container receives direct URLs under the ordinary runtime env names without pooling its session advisory lock or cross-statement `SET lock_timeout` state.
- **`LISTEN` is incompatible with transaction pooling.** PgBouncer transaction mode swaps the server connection between transactions, so notifications are silently unreliable. Every budgeted listener must use a direct or session-compatible connection. Staging and production therefore get explicit per-context direct `WORKER_LISTENER_DATABASE_URL_<CONTEXT>` values built from the same Terraform expression, using dedicated least-privilege `cs_<env>_<context>_wake_listener` users (#1243: `CONNECT` + schema `USAGE` + event-store `SELECT` only) instead of the owning context users. The listener connection count remains one direct backend per direct-listened source context (`relay_listener_demand`), enforced by `check "wake_listener_least_privilege"` alongside the parity check.
- **Context-owned API waiters are split from query traffic.** Platform API receives direct/session-compatible `DATABASE_URL_<CONTEXT>_WAITER` values for `catalog`, `discovery`, `inventory`, and `marketplace`. Durable job event waits and realtime wake listeners use those waiter pools, while durable job writes, realtime replay reads, retention cleanup, and ordinary bounded-context queries stay on `DATABASE_URL_<CONTEXT>`.
- **`DATABASE_POOL_MAX` is per database URL, not per process.** Each deployable creates one `node-postgres` pool per unique context database URL with `max = DATABASE_POOL_MAX`. The theoretical cap is therefore `pool max × attached databases` per process. The budget instead treats `DATABASE_POOL_MAX` as the per-process concurrent-backend allowance, which is honest because: worker runner concurrency is held at or below the pool max by the existing `worker_runner_capacity` check; API concurrent backend use is bounded by in-flight requests; and the 5-second pool idle timeout (`DATABASE_POOL_IDLE_TIMEOUT_MS`) reaps idle backends quickly. The asserted headroom absorbs bursts above the allowance.

## Listener And Channel Inventory

One shared notification channel per concern, never one channel or pool per context:

| Channel | Database | Listener owner | Connection kind | Budget entry |
| --- | --- | --- | --- | --- |
| `platform_event_store_commits` | Each direct-listened source-context database: `checkout`, `identity`, `inventory`, `marketplace`, `ordering`, `payments` | The single active worker-owned relay only (fenced lease; standby workers hold no listeners) | Direct (`WORKER_LISTENER_DATABASE_URL_<CONTEXT>` in staging and production, dedicated least-privilege wake-listener users) | `relay_listener_demand` (1 per direct-listened source context) |
| `platform_projection_operation_events` | Control database | API control-plane waiters for projection-operation events via the work-signal composite | `PLATFORM_WORK_SIGNAL_DATABASE_URL` direct/session-compatible pool when configured; falls back to the control pool | Inside `api_total_pool_demand` |
| `durable_job_events` (default) and context-named durable-job channels (for example `catalog_source_observation_durable_job_events`) | The database owning each durable-job store (context or control) | API durable-job SSE waiters via the work-signal composite — one lazily connected listener per store pool/channel | Direct waiter pools through `DATABASE_URL_CATALOG_WAITER` and `DATABASE_URL_INVENTORY_WAITER`; listener reconnects are circuit-broken (60 s cooldown) | `api_waiter_listener_demand` |
| `realtime_projection_patch` | `catalog`, `discovery`, `marketplace` context databases | Platform API realtime SSE wake signal via the work-signal composite — one lazily connected listener per unique realtime waiter pool (≤3 per API instance) | Direct waiter pools through `DATABASE_URL_CATALOG_WAITER`, `DATABASE_URL_DISCOVERY_WAITER`, and `DATABASE_URL_MARKETPLACE_WAITER`; SSE keeps 1s polling fallback | `api_waiter_listener_demand` |

Rejected patterns (per #1236, enforced by this budget and the guardrail inventory):

- **One session pool per context.** The 21 per-context transaction pools already consume DigitalOcean's practical pool-count ceiling; doubling pools for session mode does not fit and is rejected.
- **Every-process source listeners.** API/worker processes listening to every source database would multiply direct connections by process count; only the fenced active relay holds source listeners.
- **Unbudgeted realtime context listeners.** Any new realtime listener context must be added to the inventory above and to this ledger before enablement.

## Per-Environment Connection Ledger

Tier limits used by `push-wake-capacity-evidence.mjs` (DigitalOcean totals minus a conservative 3 reserved for maintenance): `db-s-1vcpu-1gb` 22→19, `db-s-1vcpu-2gb` 47→44, `db-s-2vcpu-4gb` 97→94, `db-s-4vcpu-8gb` 197→194. A database size missing from the map fails the checked-in evidence calculation until the new tier is budgeted.

### Staging (`staging_database_size` = `db-s-2vcpu-4gb`, `staging_database_storage_size_mib` = `25600`, budgeted limit 94)

DOKS staging uses the generated Helm baseline plus `infrastructure/helm/platform/values.staging.yaml`. That overlay runs two explicitly resourced API replicas (#4765), keeps operations and job runner counts at the compact DOKS baseline, adds representative wake headroom for the staging drill target, and widens the projection runner group to drain the accumulated backlog (#4762): worker `DATABASE_POOL_MAX` `8→12`, `WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS` `1→4`, `WORKER_WAKE_MAX_CONCURRENT_RUNNERS` `2→3`, and `WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT` `1→2` (`4 projection + 1 operations + 1 job + 1 inventory-import + 1 dispatch + 1 scheduled + 3 wake = 12`). The projection widening (#4762) lets the ~26 small starved projection groups drain alongside the 2 large discovery cascade groups instead of waiting pass-after-pass behind them for the single default slot; the groups are independent (own lease + checkpoint), so concurrent runners are safe by design. #4772 routes those query pools through the existing 17 PgBouncer pools, so their client maxima consume PgBouncer client slots and queue at the transaction pool instead of reserving additional cluster backends:

| Demand | Math | Backends |
| --- | --- | --- |
| PgBouncer server-side allocation | Active context pools, including `channels`, `collections`, and `customer-feedback`; client count does not increase this cap | 40 |
| Relay listeners | 7 direct-listened source contexts × 1 active relay | 7 |
| API waiter listeners | 4 waiter contexts × 1 API component × 2 replicas | 8 |
| Bootstrap (transient hook) | one direct/session bootstrap pool | 4 |
| **Steady-state total** | 40 + 7 + 8 + 4 | **59 ≤ 94** (headroom 35) |
| **Deploy overlap** | 40 + (2 relays × 7) + (4 waiter contexts × 2 API generations × 2 replicas) + 4 | **74 ≤ 94** (headroom 20; 1 below the 75 backend tier-upgrade trigger) |

DOKS PgBouncer clients, listed separately from cluster backends: steady state is API `6 × 2 = 12` plus worker `12 × 1 = 12`, or **24** client connections; rolling overlap is API `6 × 3 = 18` plus worker `12 × 2 = 24`, or **42**. Raising `DATABASE_POOL_MAX` or adding a DOKS API/worker replica increases this client-side demand but adds zero cluster backends while the existing server pool sizes stay fixed.

The live DOKS steady and rolling envelopes are the only runtime-compute envelopes after #5668. Retired compute is never started for rollback and therefore contributes no query, listener, waiter, or bootstrap connections. Any additional DOKS replicas must be checked against the same 94-backend hard limit and 75-backend tier-upgrade trigger before rollout.

### Production (`database_size` = `db-s-2vcpu-4gb`, budgeted limit 94)

#4655 converged production query traffic onto managed transaction pools, so production now uses the same PgBouncer server-side allocation branch as staging: app pool maxima are client-side only, and the summed production pool sizes are the cluster-backend footprint of pooled query traffic. Waiter and relay listener URLs stay direct. The budget still budgets the relay as enabled even though `WORKER_PROJECTION_WAKE_RELAY_ENABLED` is currently `false` in production, so flipping the proof, public, or relay switches can never violate the budget after the fact.

Production PgBouncer server-side allocation (`production_context_database_connection_pool_size_overrides`, all other active contexts size 1): auth 2 + catalog 4 + checkout 2 + control 3 + discovery 2 + identity 2 + marketplace 3 + public-presence 2 = 20 over the eight overridden contexts, plus 13 remaining active platform contexts at 1 = **33**.

| Demand | Math | Backends |
| --- | --- | --- |
| PgBouncer server-side allocation | 8 overridden contexts (20) + 13 contexts at 1 | 33 |
| Relay listeners (budgeted worst case, relay currently killed) | 7 direct-listened source contexts × 1 | 7 |
| API waiter listeners | 4 waiter contexts × 1 API replica | 4 |
| Bootstrap/maintenance reservation (transient PRE_DEPLOY + direct grant/admin) | one bootstrap pool | 4 |
| **Steady-state total** | 33 + 7 + 4 + 4 | **48 ≤ 94** (headroom 46) |
| **Deploy overlap** | 33 + 2 × 7 + 2 × 4 + 4 (old and new relay/API generations may briefly both hold direct listeners; PgBouncer backends do not grow with client count) | **59 ≤ 94** (headroom 35) |

Client-side PgBouncer connections (not cluster backends, listed for completeness): platform-api 6 × 1 replica = 6; platform-worker 8 × 1 replica = 8. Production worker `DATABASE_POOL_MAX` is `8` (1 projection + 1 operations + 1 job + 1 inventory-import + 1 dispatch + 1 scheduled + 2 wake = 8 runner slots). Because production query traffic is pooled, changing the worker pool max or replica count adds zero cluster backends; server-side pool sizing remains the controlling budget. The session-scoped DOKS schema bootstrap runs on direct URLs and adds no steady-state pooled query load.

The rolling-deploy overlap envelope (59) is deliberately pessimistic (both deployment generations' direct relay and waiter listeners held at once), but PgBouncer's server-side allocation is client-count-independent. On the current `db-s-2vcpu-4gb` production tier the tier-upgrade trigger is `75` backends (`floor(94 × 0.80)`), leaving 16 backends before the trigger. Each additional direct-listened source context costs 2 overlap backends.

### Capacity Evidence Output

`push-wake-capacity-evidence.mjs` reads the durable Terraform pool maps, the canonical Helm runtime values, and the source-context wake registry. Its redacted `push-wake-capacity-evidence/v1` record reports the active pool allocation, direct listeners, waiter demand, bootstrap reservation, steady and rolling totals, tier trigger, and proposed listener expansion. Runtime profile exposure does not delete pre-provisioned production databases or change the pooled server allocation.

### Preview

Previews no longer create DigitalOcean managed Postgres clusters or managed PgBouncer pools. Each PR preview gets disposable in-cluster Postgres inside its Kubernetes namespace, and namespace teardown removes the database state. The managed-cluster budget therefore applies only to staging and production. A preview must not be read as push-first health evidence: previews remain fallback-first (#1243), define no Terraform-managed listener URLs, and never carry push rollout.

## Topology Parity Contract

- The same Terraform locals and DOKS Secret exporter produce staging and production wiring: `worker_listener_source_contexts`, `worker_listener_database_urls`, `context_database_urls`, pool maxima, pool sizes, and the wake enablement flags. Environment differences are explicit scale/ramp expressions (`local.is_staging ? … : …`), never structural branches. Listener URLs are a single shared expression for staging and production (dedicated wake-listener users on direct cluster URLs); query URLs derive from `digitalocean_database_connection_pool.contexts`, while previews synthesize namespace-local in-cluster Postgres URLs outside this managed-cluster contract (#4656). The exporter splits query, listener, waiter, and bootstrap keys explicitly (#4772).
- Env var names are identical in staging and production: `DATABASE_URL_<CONTEXT>`, `DATABASE_URL_<CONTEXT>_WAITER`, `PLATFORM_CONTROL_DATABASE_URL`, `PLATFORM_WORK_SIGNAL_DATABASE_URL`, `WORKER_LISTENER_DATABASE_URL_<CONTEXT>`, `WORKER_PROJECTION_WAKE_RELAY_ENABLED`, `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED`, `PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS`, `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED`.
- `check "wake_listener_topology_parity"` fails the plan when the listener URL map keys stop matching `worker_listener_source_contexts` in either staging or production, or when a preview grows listener URLs. `check "wake_listener_least_privilege"` fails the plan when a listener URL stops embedding its dedicated wake-listener user.
- The operator procedure for collecting deployed-environment parity evidence (Terraform checks, Kubernetes Secret key names, worker status, wake-status) is the [Topology Parity Inspection section of Push-Wake Operations](../runbooks/push-wake-operations.md#topology-parity-inspection-1243-evidence).
- Per-environment rollout is carried by the kill switches and the [source-context wake registry](./source-context-wake-registry.md), not by differing infrastructure shape.

## Expansion Headroom

Each additional direct LISTEN source context costs 1 steady-state backend and 2 overlap backends in production. Against the current worst-case envelopes:

- The live staging envelope is 59/94 steady and 74/94 during a pessimistic DOKS rollout (headroom 35 and 20 respectively; 1 overlap backend remains before the 75 trigger).
- Production overlap demand is 59/94 (headroom 35 to the hard limit, 16 to the 75 trigger). The current wave-2 direct-listener proposal adds 6 overlap backends to 65/94 and fits under both the hard tier limit and trigger.
- The runtime registry currently has ten staging-enabled relay contexts (`catalog`, wave 1, `identity`, `inventory`, `platform-operations`, `public-presence`, `settlement`), while Terraform provisions direct listener URLs for wave 1 plus `identity`, `inventory`, and `public-presence`. Missing direct listener URLs are an intentional catch-up-only posture, not notification-latency proof for those contexts. Moving active catch-up-only registry sources to direct LISTEN in production would add overlap backends and fits only when the checked-in capacity evidence remains under the tier trigger; enablement still needs issue-specific latency and convergence evidence.
- Composite wake origins add query/notify load, and API-owned durable/realtime waiters now add the `api_waiter_listener_demand` direct-connection envelope above. Their throughput and latency budgets are still owned by durable wake-store capacity evidence (#1246) and composite phase evidence (#1248/#1249); their connection budget is owned here.

## Budget Violation And Rollback Behavior

- **Violation is a static evidence failure.** `push-wake-capacity-evidence.mjs` fails when a proposed listener expansion cannot fit any budgeted tier, and its regression tests pin the current steady, overlap, and trigger values. The fix is to reduce direct demand or scale `database_size`, update the tier map, and update this ledger in the same change.
- **Tier-upgrade trigger is earlier than the hard limit.** The evidence record reports the 80% trigger separately from the hard limit. Crossing it means the scale change must first upgrade `database_size` or reduce direct waiter/listener/bootstrap/maintenance demand.
- **Rollback of push wakes does not change the budget.** Disabling the relay or emission (`WORKER_PROJECTION_WAKE_RELAY_ENABLED`, `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED`, or registry state) only releases listener connections; the budget already assumed them, so rollback always moves demand further under the limit. Durable correctness (checkpoints, fallback polling) is unaffected per the registry rollback contract.
- **Production promotion evidence reuses this ledger.** The same numbers proven in staging are the connection-budget input to the production proof gates referenced by the [source-context wake registry](./source-context-wake-registry.md) and the [push-driven projection runtime phase map](./push-driven-projection-runtime-phase-map.md).
- **Cost posture.** Capacity questions are answered first with the existing managed Postgres cluster and control database (tier scale-up within this map). Introducing a paid broker or queue requires a new ADR with cost/performance proof before it can replace any budgeted path here (#1244).
