# Catalog Scope Sync And Merge Candidate Handoff

This handoff is the operator and maintainer guide for milestone #54: a scope-first, multi-provider Catalog sync that reviews merged Catalog candidates before canonical Catalog Item/Product changes are promoted.

The workflow is:

```text
Choose Catalog scope and providers
-> pull provider Source Observations
-> build merged Catalog candidates
-> resolve promote, split, update, ignore, or defer decisions
-> preview Promotable Catalog Item/Product Changes
-> apply canonical Catalog commands after approval
```

## Ownership

- Catalog owns semantic scope contracts, provider eligibility, Source Observations, merge candidates, candidate review decisions, promotion planning, canonical Catalog commands, rollout-control enforcement, and admin read models.
- Provider adapters own provider transport only. They do not own merge identity, selected Options, duplicate prevention, Product mapping, or canonical promotion decisions.
- Deployables compose Catalog routes and UI modules. They must not duplicate promotion planner logic, parse provider payloads, or require admins to author raw JSON for normal review.
- Operators use the Admin workbench and visible rollout controls. Normal UAT must not depend on handcrafted URLs, direct API calls, SQL, CLI commands, provider endpoints, or browser-console state changes.

## First Shippable Vertical Slice

The first shippable slice is Pokemon TCG / English / Expansion with:

- TCGdex item facts as Source Observations.
- TCGplayer marketplace Product and SKU evidence as Source Observations.
- One Catalog scope selected first, then eligible providers selected inside that scope.
- A parent scope sync run with child provider jobs.
- Merge candidates as the primary review unit.
- Promotion planning from approved candidates, not directly from raw provider rows.
- Projection-lag messaging when jobs complete before admin read models catch up.

The slice is not complete until the scope-first workbench, typed split/update command payloads, and #2602 UAT/docs evidence have landed. Do not close epic #2592 or milestone #54 from planner evidence alone.

## Required UAT Scenarios

Use fixture-backed or staging-safe evidence; live provider calls are not required for automated tests.

| Scenario | Acceptance evidence |
| --- | --- |
| Candidate ready path | TCGdex and TCGplayer observations merge into one ready candidate, and the promotion preview creates or refreshes one Catalog Item with the correct External Catalog Item Reference and External Product Reference levels. |
| Candidate conflict path | Disagreeing provider facts keep the candidate blocked, show field provenance and conflict diagnostics, and do not emit canonical Catalog commands. |
| Split path | An incorrectly merged candidate can be split into separate typed command payloads without raw JSON authoring, preserving source membership and audit reason. |
| Update path | An admin can correct identity, variant, selected Option, or reference mapping through typed payloads before promotion, and the preview shows the exact route body. |
| Ignore path | A candidate can be ignored without deleting provider Source Observation evidence or canonical Catalog facts. |
| Defer path | A candidate can be kept in review with an operator reason and no hidden skip list. |
| Re-sync path | Changed provider facts update Source Observations and mark the candidate or promotable change stale, changed, or blocked until reviewed. |
| Partial provider failure | One provider can fail while another succeeds; the parent sync run remains understandable, retryable, and scoped to the affected child job. |

## Operator Workflow

1. Open Catalog Integrations and select the Catalog scope before selecting providers.
2. Review eligible provider rows, readiness, option freshness, rollout-control state, and estimated work.
3. Start the parent scope sync and follow parent and child job cards to terminal state.
4. Review merge candidates first. Use Source Observations as supporting evidence, not the main decision queue.
5. For each candidate, inspect identity, source membership, field provenance, proposed references, proposed Product mapping, conflicts, and promotion readiness.
6. Choose promote, split, update, ignore, or defer. Split and update must use generated typed command payloads.
7. Preview Promotable Catalog Item/Product Changes before applying canonical commands.
8. Treat stale counts after completed jobs as projection lag unless health diagnostics point to a failed projector or blocked worker.

## Rollout And Emergency Stops

The existing Catalog integration rollout controls are the release and incident boundary for this workflow:

- `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=read-only` freezes writes while keeping review available.
- `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=dry-run-only` blocks import, promotion, reapply, and activation while preserving reads and dry-run evidence.
- `CATALOG_INTEGRATION_IMPORTS_DISABLED` or `CATALOG_INTEGRATION_IMPORT_UNITS_DISABLED` stops unsafe provider pulls.
- `CATALOG_INTEGRATION_PROMOTION_DISABLED` or `CATALOG_INTEGRATION_PROMOTION_UNITS_DISABLED` stops canonical promotion while allowing evidence review.
- `CATALOG_INTEGRATION_REAPPLY_DISABLED` or `CATALOG_INTEGRATION_REAPPLY_UNITS_DISABLED` stops replay/reapply while import review remains governed separately.
- `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP` or unit-scoped emergency stops isolate provider transport incidents.
- `CATALOG_INTEGRATION_WORKER_MODE=disabled` stops worker processing while queued jobs remain inspectable.

Use the narrowest provider or unit scope that stops the unsafe behavior. Rollback evidence must include the active env value, affected provider/unit, Admin readiness rollout snapshot, denied-control metric key, job counts, and release/deploy identifier.

## Evidence Packet

Record milestone evidence in the closing issue or PR, not as raw provider data in docs. The packet should include:

- scope summary: product domain, language, product form, scope level, set/expansion/series label, and redacted provider identifiers;
- selected providers and units, profile versions, readiness states, rollout-control snapshot, and option freshness/cache state;
- parent run id, child job ids, terminal states, retry state, and partial-failure diagnostics;
- Source Observation counts by provider and candidate membership counts;
- candidate ready, conflict, split, update, ignore, defer, re-sync, and partial-provider-failure screenshots or test artifacts;
- promotion preview fingerprints, command counts, blocked diagnostics, and External Catalog Item Reference versus External Product Reference evidence;
- projection-lag expectation and observed catch-up state;
- scoped test commands or CI checks used for the touched workspaces.

Do not include API keys, cookies, team ids, account identifiers, raw provider payloads, full provider URLs, provider imagery, prices, seller facts, inventory facts, screenshots exposing sensitive values, or console captures.

## Closure Gate

Before closing #2602, #2592, or milestone #54, confirm:

- #2599 evidence proves candidate-aware promotion planning from approved candidates.
- #2600 evidence proves admins can complete the scope-first workbench flow without leaving the workbench.
- #2636 evidence proves typed split/update command payloads are generated and submitted without raw JSON authoring.
- Automated coverage names the required scenarios above or links a focused follow-up issue for each accepted gap.
- Interface-only UAT evidence covers the first shippable vertical slice and rollback strategy.
- Current scoped checks pass for every touched workspace.

## Related References

- [Catalog Sync Scope Planning](./catalog-sync-scope-planning.md)
- [Source Observation Integration](./source-observation-integration.md)
- [Provider Integration Mapping Contract](./provider-integration-mapping-contract.md)
- [Catalog Integration Rollout Controls](./catalog-integration-rollout-controls.md)
- [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md)
- [Catalog Integration Job Consistency](./catalog-integration-job-consistency.md)
- [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md)
