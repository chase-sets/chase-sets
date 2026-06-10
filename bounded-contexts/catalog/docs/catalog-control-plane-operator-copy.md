# Catalog Control Plane Operator Copy

Issue #1058 owns the operator-facing language system for the rebuilt Catalog Control Plane primary workbench. The copy system keeps the main operator job front and center: pull provider data, review Source Observations, and promote eligible sources into Catalog Items or Catalog-owned references. Supporting workflows may explain, unblock, govern, recover, or verify that job, but they must not read like equal primary destinations.

The implementation source of truth is:

```text
bounded-contexts/catalog/features/source-observations/ui/primary-workbench-copy.ts
```

Coverage is enforced by:

```text
bounded-contexts/catalog/features/source-observations/ui/primary-workbench-copy.test.ts
bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx
```

## Copy Contract

Every operator-facing blocked, disabled, denied, degraded, unsafe, unavailable, empty, resilience, or completion state uses the same shape:

| Field | Requirement |
| --- | --- |
| Label | Human-readable state label. Do not expose machine slugs such as `provider-transport-timeout`. |
| Reason | One sentence explaining why the operator cannot safely continue or why evidence is degraded. |
| Next step | A direct action that gets the operator back to provider pull, Source Observation review, promotion preview, promotion, or release evidence. |
| Support target | The supporting workflow that resolves or explains the state while preserving route context. |
| Group | Permission, readiness, rollout, job, profile, fixture, credential, provider transport, Source Observation, promotion, security/privacy, resilience, or retirement. |

Primary-path buttons, row actions, readiness blockers, job failures, transport summaries, empty states, and resilience/error states must consume this contract instead of formatting category names directly.

## Blocked And Denied States

Blocked or disabled actions must show both the reason and next step. Denied states must distinguish permission/RBAC from rollout stops, provider transport, readiness, security/privacy, and stale/degraded read-model conditions.

| State group | Operator distinction |
| --- | --- |
| Permission | The operator lacks the required Catalog role or server-side authorization. Next step goes to governance controls. |
| Rollout | A rollout stop or kill switch intentionally blocks the workflow. Next step goes to governance controls and release evidence. |
| Provider transport | Provider rate limits, throttles, quota, timeouts, pagination, partial data, stale cache, or degraded reachability affect provider import. Next step goes to adapter readiness or health triage. |
| Readiness | Provider context, active profile, fixture evidence, credentials, or read-model health is missing. Next step returns to the specific context after resolution. |
| Security/privacy | Redaction or governed-evidence safeguards fail closed. Next step goes to governance controls before any promotion retry. |
| Promotion | Duplicate evidence, conflicts, stale previews, or destructive changes require a fresh command plan or confirmation. Next step stays in the primary workbench. |
| Retirement | Removed launch-only behavior is not a fallback. Next step uses rebuilt typed contracts only. |

## Provider Transport Language

Provider transport terms come from #1065 and must stay distinct:

| Category | Label | Operator next step |
| --- | --- | --- |
| `rate-limit` | Rate limit cooldown | Wait for cooldown or reduce pull cadence before retrying. |
| `throttle` | Provider throttle | Let the throttle window pass, then resume or retry the durable import job. |
| `quota` | Provider quota exhausted | Pause imports until quota resets or update credentials. |
| `timeout` | Provider timeout | Retry after checking health triage for reachability. |
| `pagination-failure` | Provider pagination failed | Inspect cursor diagnostics in adapter readiness, then resume from durable progress. |
| `partial-data` | Partial provider data | Review grouped failures, retry recoverable units, and promote only complete observations. |
| `stale-cache` | Stale provider cache | Refresh provider readiness before pulling provider data again. |
| `degraded-provider` | Provider degraded | Use health triage to identify the degraded capability before retrying. |

The UI must render the operator labels above, not raw category values.

## Empty And Recovery States

Empty states should point to the next useful action:

| Empty state | Required direction |
| --- | --- |
| No provider scopes | Create or activate a typed provider profile. |
| Import context incomplete | Choose provider, ingestion unit, scope, and active profile. |
| No import jobs | Pull provider data to create durable job evidence. |
| No Source Observations | Pull provider data or adjust filters. |
| No promotable observations | Select changed observations or pull fresh provider data before previewing. |
| No audit evidence | Run provider import, review, preview, or promotion to generate evidence. |

Recovery copy must keep retry, resume, reapply, replay, reject, defer, rollback, and release evidence attached to the provider/unit/scope context that opened the supporting workflow.

## Resilience States

Resilience and error-boundary copy must fail closed without raw payload escape hatches:

| State | Distinction |
| --- | --- |
| Route load failure | The route failed before provider context loaded. Reload or verify release evidence. |
| API failure | The Catalog primary workbench API failed or is unavailable. Retry after health triage confirms recovery. |
| Detail panel failure | The evidence side sheet failed to load redacted Source Observation detail. Reopen after refresh. |
| Telemetry unavailable | Instrumentation evidence is missing, so release proof may be incomplete. Verify audit evidence. |
| Degraded read model | The workbench has only partial/degraded read-model evidence. Resolve before high-impact commands. |

## Glossary

| Term | Use | Avoid |
| --- | --- | --- |
| Source Observation | Redaction-safe Catalog-owned provider fact and provenance evidence before promotion. | Raw provider data or imported Catalog Item. |
| Catalog Item | Catalog-owned product entity created or updated by promotion. | Implying every Source Observation is already a Catalog Item. |
| Catalog-owned reference | Catalog-managed external reference linked to provider identifiers. | Provider-owned reference. |
| Provider profile | Typed mapping and governance contract for provider facts. | Editable payload JSON. |
| Ingestion unit | Provider/product-form/import-purpose scope for readiness, jobs, and review evidence. | Provider alone. |
| Provider scope | Provider, ingestion unit, import scope, and active profile context. | All-provider fallback. |
| Promotion | Command that writes eligible Source Observation facts after preview. | Provider import or review-only actions. |
| Reject | Review decision that excludes observations with an auditable reason. | Defer. |
| Defer | Review decision that keeps observations in review for later judgment. | Rejection. |
| Reapply | Reprocess promoted observations with the current active profile. | Replay with original source profile. |
| Replay | Rebuild Source Observation evidence with its original source profile version. | Active mapping reapply. |
| Audit evidence | Redacted proof of operator actions, command safeguards, context, and release facts. | Provider payloads or operator secrets. |
| Provider transport | Adapter-facing provider connectivity, throttle, quota, pagination, payload acquisition, and cache state. | Profile validation or promotion conflicts. |
| Rollout stop | Governance control that blocks or quarantines a provider, unit, or command. | Permission denial. |
| Security/privacy blocker | Fail-closed state caused by unsafe evidence, missing redaction, or governed data exposure risk. | Raw provider evidence route. |
| Retire | Complete removal of associated code, product patterns, routes, APIs, clients, tests, fixtures, screenshots, documentation, runbooks, release notes, and operator instructions. | Soft deprecation, compatibility redirects, hidden support paths, aliases, shims, or preserved tests. |

## Retirement Language

For this milestone, retire, deprecate, remove legacy, and cleanup mean complete deletion. Retired behavior must not remain in code, product patterns, route/module/API/client behavior, feature flags, fallback branches, compatibility redirects, aliases, migration shims, support-only routes, tests, fixtures, screenshots, documentation, runbooks, release notes, or operator instructions.

Operator copy may say a removed behavior is unavailable only to explain why the rebuilt workbench fails closed. It must never teach operators how to use the removed behavior or imply a preserved support path exists.

## Related References

- [Catalog Control Plane Primary Path](./catalog-control-plane-primary-path.md)
- [Catalog Control Plane Section Navigation](./catalog-control-plane-section-navigation.md)
- [Catalog Primary Workbench Admin Contract](./primary-workbench-admin-contract.md)
- [Catalog Integration Provider Transport Budgets](./catalog-integration-provider-transport-budgets.md)
- [Catalog Control Plane First-Slice Stage Board](./catalog-control-plane-first-slice-stage-board.md)
