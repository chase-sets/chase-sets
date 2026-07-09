# Push-Wake Connection Budget

## Purpose

This is the per-environment DigitalOcean managed Postgres connection ledger for the push-first projection wake topology, and the contract behind the plan-time Terraform safety checks `wake_connection_budget` and `wake_listener_topology_parity` in `infrastructure/digitalocean/platform`. It answers three questions before any push-wake phase is enabled:

- How many cluster backend connections each environment can demand in the worst case, and against which database tier.
- Which processes are allowed to hold `LISTEN` connections, on which channels, and why every other listener pattern is rejected.
- How staging and production keep the same logical query/listener/control-plane topology while scaling differently (#1243, #1244, #1236).

The budget locals live in `infrastructure/digitalocean/platform/locals.tf` and the checks in `infrastructure/digitalocean/platform/main.tf`. Both environments are computed from the same locals; only scale knobs (`api_instances`, `worker_instances`, pool maxima, `database_size`) and the staging-first ramp flags differ. Generate a CI-safe evidence record from the checked-in locals with `pnpm run ops push-wake:capacity-evidence -- --out artifacts/release-health/push-wake-capacity-evidence.json`; the script reads no secrets and contacts no live environment.

Terraform also exposes `connection_budget_profiles` so release operators can inspect the resolved profile, active/exposed/provisioned context counts, steady-state demand, rolling-deploy demand, headroom, and the 80% rolling-deploy tier-upgrade trigger. The current pool-max envelope is per process, not per mounted context, so landing mode lowers active route/context surface while the profiled API and worker families keep the production backend-demand model small and explicit.

## PgBouncer Vs Direct Connection Semantics

- **App Platform query traffic is pooled in every environment (#4655).** Terraform creates one managed PgBouncer transaction pool per active context database. App Platform components (API, worker, bootstrap job) hold client-side connections to PgBouncer; the cluster backends those clients can occupy are capped by the server-side pool `size` values in `context_database_connection_pool_sizes`, not by app pool maxima. The sum of those sizes is the worst-case backend footprint of all pooled traffic. #4655 added production query pools with their own budget entries (`production_context_database_connection_pool_size_overrides`), converging production onto the staging pooled shape and closing the last staging/production database-topology asymmetry; production no longer attaches App Platform database bindings.
- **DOKS staging query traffic is currently direct.** The Kubernetes Secret export in `.github/workflows/platform-production.yml` builds `DATABASE_URL_*`, `PLATFORM_CONTROL_DATABASE_URL`, and `PLATFORM_WORK_SIGNAL_DATABASE_URL` from `digitalocean_database_user.contexts` plus the cluster host/port, not from `digitalocean_database_connection_pool.contexts`. DOKS staging worker pool changes therefore count against cluster backends until that exporter is changed to use PgBouncer pool resources for ordinary query URLs. The DOKS-exported direct URLs also carry the session-scoped schema bootstrap (see below), which must not run through a transaction pool.
- **`LISTEN` is incompatible with transaction pooling.** PgBouncer transaction mode swaps the server connection between transactions, so notifications are silently unreliable. Every budgeted listener must use a direct or session-compatible connection. That is why staging and production both get explicit per-context direct `WORKER_LISTENER_DATABASE_URL_<CONTEXT>` values built from the same Terraform expression, using dedicated least-privilege `cs_<env>_<context>_wake_listener` users (#1243: `CONNECT` + schema `USAGE` + event-store `SELECT` only) instead of the owning context users or App Platform bindings. The listener connection **count** is unchanged by the least-privilege credentials — still one direct backend per direct-listened source context (`relay_listener_demand`), enforced by `check "wake_listener_least_privilege"` alongside the parity check.
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

Tier limits used by `cluster_connection_limits` (DigitalOcean totals minus a conservative 3 reserved for maintenance): `db-s-1vcpu-1gb` 22→19, `db-s-1vcpu-2gb` 47→44, `db-s-2vcpu-4gb` 97→94, `db-s-4vcpu-8gb` 197→194. A database size missing from the map resolves to a limit of 0 and fails the check until the new tier is budgeted.

### Staging (`staging_database_size` = `db-s-2vcpu-4gb`, `staging_database_storage_size_mib` = `25600`, budgeted limit 94)

Direct cluster backends (what the check asserts, from `push-wake-capacity-evidence/v1`):

| Demand | Math | Backends |
| --- | --- | --- |
| PgBouncer server-side allocation | 17 platform contexts with overrides: auth 3 + catalog 6 + control 4 + discovery 3 + identity 3 + marketplace 3 + notifications 2 + public-presence 3; all other contexts 1 | 36 |
| Relay listeners (active relay only) | 7 direct-listened source contexts × 1 | 7 |
| API waiter listeners | 4 waiter contexts × 1 API component × 1 instance | 4 |
| Bootstrap/maintenance reservation | one bootstrap pool (the staging bootstrap job itself rides PgBouncer; this covers the direct Terraform grant connection and ad hoc maintenance) | 4 |
| **Steady-state total** | 36 + 7 + 4 + 4 | **51 ≤ 94** (headroom 43) |
| **Deploy overlap** | 36 + 2 × 7 + 2 × 4 + 4 (old and new relay/API generations may briefly both hold listeners; PgBouncer backends do not grow with client count) | **62 ≤ 94** (headroom 32) |

App Platform staging worker `DATABASE_POOL_MAX` is `14` (2 projection + 2 operations + 4 job + 1 inventory-import + 1 dispatch + 1 scheduled + 3 wake = 14 runner slots; see `check "worker_runner_capacity"`). App Platform staging query traffic is PgBouncer-pooled, so the worker's client-side pool max does **not** add cluster backends — the server-side allocation above is the whole footprint — which is why App Platform staging can carry two operations executors for recovery drills without any budget movement.

Client-side PgBouncer connections (not cluster backends, listed for completeness): platform-api 6 × 1 component × 1 instance = 6; platform-worker 14 × 1 component × 2 instances = 28.

DOKS staging uses the generated Helm baseline plus `infrastructure/helm/platform/values.staging.yaml`. That overlay intentionally keeps projection, operations, and job runner counts at the compact DOKS baseline while adding representative wake headroom for the staging drill target: worker `DATABASE_POOL_MAX` `8→9`, `WORKER_WAKE_MAX_CONCURRENT_RUNNERS` `2→3`, and `WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT` `1→2` (`1 projection + 1 operations + 1 job + 1 inventory-import + 1 dispatch + 1 scheduled + 3 wake = 9`). Because the current DOKS staging Secret exporter is direct, the standalone DOKS staging release envelope counts those pools against the cluster:

| Demand | Math | Backends |
| --- | --- | --- |
| API pools | 6 pool max × 1 component × 1 replica | 6 |
| Worker pools | 9 pool max × 1 component × 1 replica | 9 |
| Relay listeners | 7 direct-listened source contexts × 1 active relay | 7 |
| API waiter listeners | 4 waiter contexts × 1 API component × 1 replica | 4 |
| Bootstrap (transient hook) | one bootstrap pool | 4 |
| **Steady-state total** | 6 + 9 + 7 + 4 + 4 | **30 ≤ 94** (headroom 64) |
| **Deploy overlap** | 2 × (6 + 9) + 2 × 7 + 2 × 4 + 4 | **56 ≤ 94** (headroom 38; below the 75 backend tier-upgrade trigger) |

The #4633 DOKS staging change is an incremental direct-worker bump of +1 steady-state backend and +2 rolling-overlap backends over the previous pool-8 DOKS worker. Do not treat simultaneous App Platform and DOKS rolling deploys as proven by this standalone envelope; if both orchestration lanes are intentionally rolled at once, record a combined migration budget first.

### Production (`database_size` = `db-s-2vcpu-4gb`, budgeted limit 94)

#4655 converged production query traffic onto managed transaction pools, so production now uses the same PgBouncer server-side allocation branch as staging: app pool maxima are client-side only, and the summed production pool sizes are the cluster-backend footprint of pooled query traffic. Waiter and relay listener URLs stay direct. The budget still budgets the relay as enabled even though `WORKER_PROJECTION_WAKE_RELAY_ENABLED` is currently `false` in production, so flipping the proof, public, or relay switches can never violate the budget after the fact.

Production PgBouncer server-side allocation (`production_context_database_connection_pool_size_overrides`, all other active contexts size 1): auth 2 + catalog 4 + checkout 2 + control 3 + discovery 2 + identity 2 + marketplace 3 + public-presence 2 = 20 over the eight overridden contexts, plus 9 remaining active platform contexts at 1 = **29**.

| Demand | Math | Backends |
| --- | --- | --- |
| PgBouncer server-side allocation | 8 overridden contexts (20) + 9 contexts at 1 | 29 |
| Relay listeners (budgeted worst case, relay currently killed) | 7 direct-listened source contexts × 1 | 7 |
| API waiter listeners | 4 waiter contexts × 1 API component × 2 instances | 8 |
| Bootstrap/maintenance reservation (transient PRE_DEPLOY + direct grant/admin) | one bootstrap pool | 4 |
| **Steady-state total** | 29 + 7 + 8 + 4 | **48 ≤ 94** (headroom 46) |
| **Deploy overlap** | 29 + 2 × 7 + 2 × 8 + 4 (old and new relay/API generations may briefly both hold direct listeners; PgBouncer backends do not grow with client count) | **63 ≤ 94** (headroom 31) |

Client-side PgBouncer connections (not cluster backends, listed for completeness): platform-api 6 × 1 component × 2 instances = 12; platform-worker 8 × 1 component × 1 instance = 8. Production worker `DATABASE_POOL_MAX` is `8` (1 projection + 1 operations + 1 job + 1 inventory-import + 1 dispatch + 1 scheduled + 2 wake = 8 runner slots). Because production query traffic is now pooled, changing the worker pool max, adding a worker instance, or adding a second projection-operation executor adds **zero** cluster backends — this is exactly what makes KEDA burst worker scaling (#4057) budget-safe. The session-scoped schema bootstrap runs on direct URLs (DOKS-owned in production; the interim App Platform bootstrap job rides the pooled URLs staging has proven), never adding steady-state pooled query load.

The rolling-deploy overlap envelope (63) is deliberately pessimistic (both deployment generations' direct relay and waiter listeners held at once), but PgBouncer's server-side allocation is client-count-independent, so the overlap no longer moves with API or worker instance count. On the current `db-s-2vcpu-4gb` production tier the tier-upgrade trigger is `75` backends (`floor(94 × 0.80)`); production overlap demand is `63`, a headroom of 12 to the trigger — **no longer within one worker of it** (the pre-#4655 direct model sat at 74/75, one worker from the trigger, and a second worker or a third API instance would have crossed it). Adding direct LISTEN source contexts is now the only thing that moves the overlap envelope: each additional direct-listened source context costs 2 overlap backends.

### Profile Summary Output

`connection_budget_profiles` records the resolved active profile plus named `landing`, `proof`, and `public` entries. The named entries intentionally separate context profile visibility from backend demand:

- `landing` uses the landing/support context surface and shows production provisioned contexts separately so a landing rollback does not imply database deletion.
- `proof` shares the public bounded-context surface; #4655 converged production query traffic onto managed transaction pools, so pooled server-side allocation is the app-query backend footprint in every mode.
- `public` preserves the full marketplace context surface.

Each entry includes `active_context_count`, `exposed_context_count`, `provisioned_context_count`, `steady_state_demand`, `rolling_deploy_demand`, `cluster_connection_limit`, `steady_state_headroom`, `rolling_deploy_headroom`, `rolling_deploy_upgrade_trigger_percent`, `rolling_deploy_upgrade_trigger`, `rolling_deploy_upgrade_required`, and `production_pgbouncer_ready`. `production_pgbouncer_ready` is `true` as of #4655: production query traffic runs through managed transaction pools with their own budget entries, sized for production concurrency, while waiter/listener/bootstrap/maintenance traffic stays direct. The #3342 refresh set the convergence direction; #4655 flipped it with staging and production plan evidence showing no destructive database actions.

### Preview

Previews no longer create DigitalOcean managed Postgres clusters or managed PgBouncer pools. Each PR preview gets disposable in-cluster Postgres inside its Kubernetes namespace, and namespace teardown removes the database state. The managed-cluster budget therefore applies only to staging and production. A preview must not be read as push-first health evidence: previews remain fallback-first (#1243), define no Terraform-managed listener URLs, and never carry push rollout.

## Topology Parity Contract

- The same Terraform locals produce the staging and production App Platform wiring: `worker_listener_source_contexts`, `worker_listener_database_urls`, `context_database_urls`, pool maxima, pool sizes, and the wake enablement flags. Environment differences are explicit scale/ramp expressions (`local.is_staging ? … : …`), never structural branches. Listener URLs are a single shared expression for staging and production (dedicated wake-listener users on direct cluster URLs); App Platform query traffic is now pooled in every managed-postgres environment (#4655), so `context_database_urls` derives from `digitalocean_database_connection_pool.contexts` in staging and production alike, while previews synthesize namespace-local in-cluster Postgres URLs outside this managed-cluster contract (#4656). DOKS staging currently has a separate direct-query Secret export path called out in the staging ledger.
- Env var names are identical in staging and production: `DATABASE_URL_<CONTEXT>`, `DATABASE_URL_<CONTEXT>_WAITER`, `PLATFORM_CONTROL_DATABASE_URL`, `PLATFORM_WORK_SIGNAL_DATABASE_URL`, `WORKER_LISTENER_DATABASE_URL_<CONTEXT>`, `WORKER_PROJECTION_WAKE_RELAY_ENABLED`, `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED`, `PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS`, `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED`.
- `check "wake_listener_topology_parity"` fails the plan when the listener URL map keys stop matching `worker_listener_source_contexts` in either staging or production, or when a preview grows listener URLs. `check "wake_listener_least_privilege"` fails the plan when a listener URL stops embedding its dedicated wake-listener user.
- The operator procedure for collecting deployed-environment parity evidence (Terraform checks, app spec env vars, worker status, wake-status) is the [Topology Parity Inspection section of Push-Wake Operations](../runbooks/push-wake-operations.md#topology-parity-inspection-1243-evidence).
- Per-environment rollout is carried by the kill switches and the [source-context wake registry](./source-context-wake-registry.md), not by differing infrastructure shape.

## Expansion Headroom

Each additional direct LISTEN source context costs 1 steady-state backend and 2 overlap backends in production. Against the current worst-case envelopes:

- Staging can absorb all remaining direct listener waves on the current tier (steady-state headroom 43, overlap headroom 32).
- Production overlap demand is now 63/94 (headroom 31 to the hard limit, 12 to the 75 upgrade trigger) after #4655 pooled its query traffic. That leaves 15 additional direct listener slots before the absolute current-tier limit and 6 before the 80% upgrade trigger. The remaining wave-2 relay listener expansion (`catalog`, `fulfillment`) adds 4 overlap backends to 67/94 and now fits under both the hard tier limit and the 75/94 trigger, so it no longer forces a tier upgrade — pooling the query traffic was what recovered that headroom.
- The runtime registry currently has ten staging-enabled relay contexts (`catalog`, wave 1, `identity`, `inventory`, `platform-operations`, `public-presence`, `settlement`), while Terraform provisions direct listener URLs for wave 1 plus `identity`, `inventory`, and `public-presence`. Missing direct listener URLs are an intentional catch-up-only posture, not notification-latency proof for those contexts. Moving active catch-up-only registry sources to direct LISTEN in production would add overlap backends and fits only when the checked-in capacity evidence remains under the tier trigger; enablement still needs issue-specific latency and convergence evidence.
- Composite wake origins add query/notify load, and API-owned durable/realtime waiters now add the `api_waiter_listener_demand` direct-connection envelope above. Their throughput and latency budgets are still owned by durable wake-store capacity evidence (#1246) and composite phase evidence (#1248/#1249); their connection budget is owned here.

## Budget Violation And Rollback Behavior

- **Violation is a plan-time failure.** `check "wake_connection_budget"` fails during `terraform plan`/`apply` in the deployment workflows before any app spec changes ship, naming the over-budget environment. The fix is to reduce pool maxima, instance counts, or listener contexts, or to scale `database_size` and add the new tier to `cluster_connection_limits` — and to update this ledger in the same change.
- **Tier-upgrade trigger is earlier than the hard limit.** `check "wake_connection_budget_tier_upgrade_trigger"` asserts rolling-deploy overlap demand stays at or below 80% of the selected tier's reserved backend budget for staging and production. Crossing it means the scale change must first upgrade `database_size` to the next budgeted tier or land query-safe production transaction pools with direct waiter/listener/bootstrap/maintenance paths preserved.
- **Rollback of push wakes does not change the budget.** Disabling the relay or emission (`WORKER_PROJECTION_WAKE_RELAY_ENABLED`, `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED`, or registry state) only releases listener connections; the budget already assumed them, so rollback always moves demand further under the limit. Durable correctness (checkpoints, fallback polling) is unaffected per the registry rollback contract.
- **Production promotion evidence reuses this ledger.** The same numbers proven in staging are the connection-budget input to the production proof gates referenced by the [source-context wake registry](./source-context-wake-registry.md) and the [push-driven projection runtime phase map](./push-driven-projection-runtime-phase-map.md).
- **Cost posture.** Capacity questions are answered first with the existing managed Postgres cluster and control database (tier scale-up within this map). Introducing a paid broker or queue requires a new ADR with cost/performance proof before it can replace any budgeted path here (#1244).
