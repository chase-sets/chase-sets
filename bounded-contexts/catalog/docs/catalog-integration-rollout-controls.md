# Catalog Integration Rollout Controls

Catalog Integration Control Plane rollout controls are Catalog-owned guardrails for staged enablement, provider transport incidents, and emergency stops. They are enforced by the Source Observations runtime/API/worker seams and surfaced in the Admin Control Plane readiness overview.

The authoritative TypeScript policy lives in:

```text
bounded-contexts/catalog/features/source-observations/api/catalog-integration-rollout-controls.ts
```

## Ownership

- Catalog Source Observations owns control ids, default states, capability decisions, Admin readiness surfacing, structured denial evidence, and tests.
- Ops/Release owns deployment-time environment values, staged rollout sequencing, incident activation, and rollback coordination.
- Provider adapters own transport behavior, but Catalog evaluates rollout controls before option queries, import planning, provider payload fetches, promotion, reapply, activation, or worker processing run.

## Default State

Operational controls default to open outside production-like environments. Production-like Magic sync defaults to dry-run-only with MTGJSON, Scryfall, and TCGplayer imports, promotion, reapply, and non-test activation stopped until Ops explicitly opens the controls and records the Magic production signoff reference.

## Control Inventory

| Control id | Env/config | Default | Owner | Blocks or degrades |
| --- | --- | --- | --- | --- |
| `control-plane-read-only` | `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=read-only` | open | Catalog Source Observations | Blocks import, promotion, reapply, and activation |
| `dry-run-only` | `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=dry-run-only` | open | Catalog Source Observations | Blocks import, promotion, reapply, activation; dry runs and reads remain available |
| `rollback-ready-release-mode` | `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=rollback-ready` | open | Ops/Release | Degraded release posture; operators should avoid broad changes and keep rollback evidence current |
| `provider-adapter-disabled` | `CATALOG_INTEGRATION_DISABLED_PROVIDER_ADAPTERS=<provider list or all>` | open | Catalog Source Observations | Blocks provider transport, provider option queries, and imports for the scoped provider |
| `provider-api-emergency-stop` | `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP=<provider list or all>` | open | Catalog Source Observations | Blocks provider transport, provider option queries, and imports during provider API/rate-limit incidents |
| `provider-option-queries-disabled` | `CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES=disabled` | open | Catalog Source Observations | Blocks live option queries |
| `provider-option-queries-cache-only` | `CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES=cache-only` | open | Catalog Source Observations | Blocks live option queries and serves only fresh or stale cached options |
| `imports-disabled` | `CATALOG_INTEGRATION_IMPORTS_DISABLED=<provider list or all>` | open | Catalog Source Observations | Blocks import enqueue and import worker turns for the scoped provider |
| `promotion-disabled` | `CATALOG_INTEGRATION_PROMOTION_DISABLED=<provider list or all>` | open | Catalog Source Observations | Blocks single and bulk Source Observation promotion for the scoped provider |
| `reapply-disabled` | `CATALOG_INTEGRATION_REAPPLY_DISABLED=<provider list or all>` | open | Catalog Source Observations | Blocks explicit and scoped reapply for the scoped provider |
| `activation-disabled` | `CATALOG_INTEGRATION_ACTIVATION_MODE=disabled` | open | Catalog Source Observations | Blocks provider profile activation |
| `activation-test-profiles-only` | `CATALOG_INTEGRATION_ACTIVATION_MODE=test-profiles-only` | open | Catalog Source Observations | Blocks activation unless the candidate profile lifecycle is `test` |
| `magic-production-signoff-required` | `CATALOG_INTEGRATION_MAGIC_PRODUCTION_SIGNOFF_REFERENCE=<approval and #2039 UAT evidence>` | open outside production-like envs; blocked for production-like Magic writes when missing | Catalog Source Observations | Blocks MTGJSON, Scryfall, and TCGplayer import, promotion, reapply, and activation until provider-data signoff and interface-only staging UAT evidence are recorded |
| `worker-processing-disabled` | `CATALOG_INTEGRATION_WORKER_MODE=disabled` | open | Catalog Source Observations | Blocks integration worker job processing |
| `worker-lane-limited` | `CATALOG_INTEGRATION_WORKER_MODE=lane-limited` | open | Ops/Release | Degrades worker throughput; lane counts remain platform-worker config |

Provider-scoped env values accept comma-separated provider keys, `all`, `true`, or `*`. Empty means unset. `none`, `false`, and `open` mean no provider scope is disabled, and in production-like environments they explicitly open that control only after the Magic production signoff gate is also satisfied.

## Magic Provider Rollout Behavior

Magic production sync uses `mtgjson`, `scryfall`, and `tcgplayer` provider scopes. Every provider-scoped stop must be tested as a single-provider stop before broad rollout, because the intended behavior is independent provider isolation:

| Provider scope | Disabled provider adapter or emergency stop | Imports disabled | Promotion disabled | Reapply disabled | Cache-only option queries |
| --- | --- | --- | --- | --- | --- |
| `mtgjson` | MTGJSON provider transport, option queries, and imports are blocked; Scryfall and TCGplayer are unaffected unless separately scoped. | MTGJSON imports are blocked; existing observations remain reviewable. | MTGJSON Source Observation promotion is blocked. | MTGJSON reapply/replay is blocked. | Live option queries are blocked for the request path and only cached option pages may answer. |
| `scryfall` | Scryfall provider transport, option queries, and imports are blocked; MTGJSON and TCGplayer are unaffected unless separately scoped. | Scryfall imports are blocked; existing observations remain reviewable. | Scryfall Source Observation promotion is blocked. | Scryfall reapply/replay is blocked. | Live option queries are blocked for the request path and only cached option pages may answer. |
| `tcgplayer` | TCGplayer provider transport, option queries, and imports are blocked; MTGJSON and Scryfall are unaffected unless separately scoped. | TCGplayer imports are blocked; existing observations remain reviewable. | TCGplayer Source Observation promotion is blocked. | TCGplayer reapply/replay is blocked. | Live option queries are blocked for the request path and only cached option pages may answer. |
| `all`, `true`, or `*` | All provider transport, option queries, and imports are blocked. | All provider imports are blocked. | All provider promotions are blocked. | All provider reapply/replay work is blocked. | Live option queries are blocked globally and only cached option pages may answer. |

`dry-run-only` is not provider-scoped. It blocks import, promotion, reapply, and activation for the whole control plane while leaving reads, provider setup, validation, and dry-run evidence available. Production defaults to `dry-run-only` plus imports/promotion/reapply disabled for MTGJSON, Scryfall, and TCGplayer when the corresponding environment values are unset. Setting the corresponding env values to `open`, `none`, or `false` opens those controls only if `CATALOG_INTEGRATION_MAGIC_PRODUCTION_SIGNOFF_REFERENCE` names the accepted provider-data signoff and #2039 interface-only staging UAT evidence.

`provider-option-queries-cache-only` is a degraded option-query posture, not a write gate. The provider option query path returns cache metadata (`fresh`, `stale`, `miss`, `bypass`, or `unavailable`) with `cacheOnly` and `degraded` flags so Admin can label fresh cached pages, stale cached pages, and unavailable selectors explicitly.

## Enforcement Seams

The policy evaluates capabilities instead of routes:

- `provider-option-query`: provider-neutral option query routes.
- `provider-transport`: adapter-backed import planning and payload fetch boundaries.
- `import`: neutral integration job enqueue, direct import services, and import worker turns.
- `promotion`: single-observation promotion and bulk promotion jobs.
- `reapply`: explicit reapply, scoped reapply jobs, and reapply worker turns.
- `activation`: provider profile activation after the candidate lifecycle can be read.
- `worker-job-processing`: integration worker claim/process loop.

This keeps controls server-side and worker-side; Admin UI button state is not the enforcement boundary.

## Admin Surfacing

`GET /api/catalog/source-observations/integration-control-plane/readiness` includes `rolloutControls` with every control id, owner, default state, status, severity, scoped providers/profiles/units, capabilities, audit event name, metric key, and operator message.

The Admin Health view shows a Rollout controls summary and active blocked/degraded controls. Unit readiness also receives Catalog diagnostics when provider transport, option queries, or imports are blocked for that unit.

## Audit And Observability

Denied controls return structured evidence:

- `code: catalog_integration_rollout_control_denied`
- `diagnosticCode: catalog-integration-rollout-control-denied`
- `controlId`
- `auditEventName: rollout-control-denied`
- `metricKey: catalog.integration.rollout.<control_id>`
- full control snapshot for the denied decision

Future audit persistence should append `rollout-control-denied` records to the Catalog Integration Audit Evidence projection. Metrics should count denied decisions by `metricKey`, provider key, capability, route/job source, and environment.

## Staged Rollout Order

1. Start with defaults open.
2. Enable `rollback-ready` during release windows so Admin reports degraded release posture while normal workflows remain available.
3. Validate readiness, fixtures, dry runs, option queries, and import enqueue in staging.
4. Enable one provider or ingestion unit at a time for import.
5. Enable promotion for reviewed Source Observations after import and conflict evidence are stable.
6. Enable reapply after promotion outcomes and replay impact evidence are accepted.
7. Enable broad activation only after candidate profiles pass activation readiness and rollback evidence is present.
8. Remove `rollback-ready` after production health, job queues, audit evidence, and provider transport metrics stay green.

Magic production sync has an additional start gate. MTGJSON, Scryfall, and
TCGplayer Magic may be implemented behind disabled or dry-run-only controls, but
production activation must wait for [Catalog Integration Magic Production Signoff](./catalog-integration-magic-production-signoff.md)
and the interface-only staging UAT. During the UAT, operators must be able to
verify dry-run-only, provider emergency stop, imports disabled, promotion
disabled, and reapply disabled controls for each provider without using direct
APIs, CLI commands, SQL, provider endpoints, or hidden routes.

## Rollback And Emergency Stops

- Provider API/rate-limit incident: set `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP=<provider>`; option queries, provider transport, and imports stop while Catalog review of existing observations can continue.
- Bad import payload or mapping: set `CATALOG_INTEGRATION_IMPORTS_DISABLED=<provider>`; existing promotion/reapply controls stay independent.
- Bad promotion outcome: set `CATALOG_INTEGRATION_PROMOTION_DISABLED=<provider>` and keep reapply disabled until impact analysis is complete.
- Bad replay/reapply behavior: set `CATALOG_INTEGRATION_REAPPLY_DISABLED=<provider>`.
- Unsafe profile lifecycle change: set `CATALOG_INTEGRATION_ACTIVATION_MODE=disabled` or `test-profiles-only`.
- Worker incident: set `CATALOG_INTEGRATION_WORKER_MODE=disabled`; queued jobs remain inspectable but worker processing stops.
- Broad uncertainty: set `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=read-only` to freeze writes while keeping Admin inspection available.

Rollback verification should record the active env values, Admin readiness rollout snapshot, denied-control metric keys, affected providers, queued/running job counts, and the release/deploy identifier where the stop was applied.

## Related Docs

- [Catalog Integration Control Plane](./catalog-integration-control-plane.md)
- [Catalog Integration Audit Evidence](./catalog-integration-audit-evidence.md)
- [Catalog Integration Job Consistency](./catalog-integration-job-consistency.md)
- [Catalog Integration Provider Option Query Controls](./catalog-integration-provider-option-query-controls.md)
- [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md)
- [Catalog Integration Magic Production Signoff](./catalog-integration-magic-production-signoff.md)
