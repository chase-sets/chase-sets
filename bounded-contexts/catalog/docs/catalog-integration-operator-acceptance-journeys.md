# Catalog Integration Operator Acceptance Journeys

Operator acceptance proves the Admin Control Plane supports real Catalog integration jobs from start to recovery. It is separate from the dense UX and accessibility checklist: UX checks prove the workspace is operable; these journeys prove operators can finish the work with realistic data, diagnostics, impact, and audit evidence.

The [Catalog Integration No-Confusion UX Acceptance](./catalog-integration-no-confusion-ux-acceptance.md) packet is the launch gate for first-slice acceptance. Evidence must come from the rebuilt primary workbench contracts, rebuilt UI modules, API/read-model routes, E2E smoke for the rebuilt journey, and proof gates. Do not use retired admin implementation artifacts as launch acceptance evidence.

Supporting proof remains required: `catalog-integration-provider-transport-budgets.test.ts` owns provider transport/performance acceptance and `scripts/check-structure/catalog-integration-security-privacy-launch-gate.test.mjs` owns security/privacy launch safety. The no-confusion acceptance packet links both so operator acceptance cannot pass while the primary path is confusing, unsafe, slow, or dependent on retired behavior.

The primary-path framing for the rebuilt control plane is documented in [Catalog Control Plane Architecture](./catalog-control-plane-architecture.md). Implementation evidence should treat J08 through J11 and J14 as the core import-to-promotion acceptance set unless a narrower issue explicitly states why one journey is out of scope.

## Acceptance Matrix

| ID | Journey | Scenario type | Operator goal | Verification evidence |
| --- | --- | --- | --- | --- |
| J01 | Integration health triage | happy path | Distinguish Catalog semantic readiness, provider adapter transport readiness, fixture status, dry-run status, diagnostics, and audit lifecycle before touching a profile. | `catalog-integration-no-confusion-ux-acceptance.test.ts`, `primary-workbench-admin-contracts.test.ts`, and `route.test.ts` cover readiness facts and overview API contracts. |
| J02 | Draft profile creation | happy path | Clone a reviewed profile version, keep immutable identity facts stable, and start a draft/test version for scoped edits. | `provider-profile-admin-contracts.test.ts`, provider profile route coverage, and rebuilt profile workspace tests cover clone controls and clean contract behavior. |
| J03 | Guided section editing | happy path | Edit Catalog-facing sections through typed controls without Profile JSON, preserving unrelated sections and surfacing stale-edit conflicts. | `provider-profile-section-registry.test.ts`, `provider-profile-section-projection.test.ts`, and rebuilt profile section workspace tests cover typed controls and absence of raw JSON fallback. |
| J04 | Fixture validation failure | failure | Attach or evaluate fixture coverage, see blocking fixture-flow diagnostics with long paths/remediation, and understand why activation is blocked. | `provider-profile-sections.test.ts` and `catalog-integration-fixture-lifecycle.test.ts` cover blocked activation readiness and long diagnostics. |
| J05 | Dry-run evidence review | happy path | Run a fixture-backed dry run, inspect redacted Source Observation facts, duplicate candidates, promotion command evidence, diagnostics, and safe payload override controls. | `catalog-integration-dry-run-proofs.test.ts` and `route.test.ts` prove redacted dry-run evidence. |
| J06 | Semantic profile comparison | happy path | Compare draft/test against active, read section-level semantic changes, activation impact, mapping fingerprint impact, and unchanged areas without Candidate or Active profile JSON. | `provider-profile-section-projection.test.ts` and `provider-profile-review.test.ts` cover semantic comparison evidence. |
| J07 | Activation readiness blocked | failure | Attempt activation, review blocking checks grouped by domain concept, affected references, fixture status, migration evidence requirement, and disabled confirmation. | `provider-integration-profiles.test.ts`, `provider-profile-sections.test.ts`, and `route.test.ts` prove blocked activation behavior. |
| J08 | Provider import and job diagnostics | failure/recovery | Start a scoped import, track queued/running/completed job status, inspect profile snapshot and failed result groups, and link into filtered Source Observations. | `primary-workbench-import-jobs.test.ts`, `primary-workbench-health-triage.test.ts`, `primary-workbench-page.test.tsx`, and `route.test.ts` cover import diagnostics and recovery. |
| J09 | Source Observation provenance review | happy path | Review Source Observations by provider/scope, inspect source URL, source hash, normalized facts, diagnostics, redaction, and provenance before promotion decisions. | `primary-workbench-source-observation-review.test.ts`, `primary-workbench-conflict-resolution.test.ts`, and `route.test.ts` cover review and redacted provenance. |
| J10 | Promote, reject, or defer observations | failure/recovery | Preview bulk promotion or rejection by explicit rows or filters, require rejection reasons, enqueue durable jobs, and keep partial failures scoped. | `primary-workbench-page.test.tsx`, `provider-promotion-command-planner.test.ts`, and `route.test.ts` prove promotion/reject/defer behavior. |
| J11 | Reapply mapping changes | recovery | Preview and reapply promoted observations with current-active-profile mode, show eligible/ineligible/matched counts, and keep job progress durable. | `primary-workbench-admin-contracts.test.ts`, `route.test.ts`, and `runtime.test.ts` cover reapply/replay behavior. |
| J12 | Bad activation rollback | destructive recovery | Roll back to a previously validated profile version, show lifecycle context, affected reference counts, audit implications, and job-conflict guidance. | `catalog-integration-impact-analysis.test.ts` and `provider-integration-profiles.test.ts` prove rollback context. |
| J13 | Retirement and deprecation | destructive recovery | Deprecate or retire transitional profile versions only when reference counts and lifecycle rules allow it, with blocked-action explanations. | `primary-workbench-admin-contracts.test.ts` and `scripts/check-structure/catalog-integration-legacy-cleanup.test.mjs` prove complete deletion semantics. |
| J14 | Audit and release evidence | audit | Confirm who changed what, which profile/job/Source Observation/Catalog Item each decision touched, and what acceptance evidence must ship with release notes. | `catalog-integration-audit-evidence.test.ts` and `catalog-integration-no-confusion-ux-acceptance.test.ts` govern audit capture. |

## Required Data Shapes

Acceptance runs should use the smallest data set that proves the operator decision, but each release must include at least one realistic dense state:

- Long diagnostics with nested section paths, remediation, fixture-flow metadata, and blocking behavior.
- At least one active or recently completed job with provider, ingestion unit, scope, profile snapshot, progress, result groups, and links into Source Observations.
- Dry-run evidence that includes Source Observation facts, duplicate-prevention evidence, promotion command previews, and redaction summaries.
- A semantic comparison with changed and unchanged sections, severity, mapping fingerprints, and activation impact.
- View-only state where safe read actions remain available and write/destructive actions are disabled.

For the guided Catalog Integrations path, the acceptance data set should include a TCGdex Japanese Pokemon scope selected through provider options: Language `Japanese`, Series `SV`, and Expansion `SV8`. The run should prove source options can be loaded from cache or live provider queries, the selected scope can be synced, observed rows become reviewable, promotion preview is scoped to that selection, and promote-all enqueues work only for eligible observations in that selected scope.

## Release Evidence Rules

Every Admin Control Plane release must record:

- One happy path covering J01 through J06 or an explicit reason a journey was unchanged by the release.
- At least three failure/recovery paths from J04, J07, J08, J10, J11, J12, or J13.
- The focused unit/API tests that cover changed journey states.
- The signed-in operator E2E path when UI workflow behavior changed.
- Whether keyboard/responsive checks came from the UX checklist, local E2E, CI, or a named follow-up issue.
- Any raw JSON editor, profile snapshot workaround, retired test anchor, retired screenshot, or legacy documentation discovered during acceptance, with an owning removal issue before milestone closure. Retire means complete deletion of the code, patterns, tests, fixtures, screenshots, docs, runbooks, release notes, and operator instructions that preserve it.
- Any high-volume list, stale-state, long-diagnostic, rollback, or audit gap discovered during acceptance, with a follow-up issue before milestone closure.

## Acceptance Confirmation

A release can claim operator acceptance only when the PR body or release plan names:

- the journeys covered by ID;
- the data shapes exercised;
- the exact test commands or CI checks used;
- any accepted non-blocking gap and its follow-up issue;
- the post-merge deploy or no-runtime-deploy verification result.

If a journey cannot be validated because the underlying runtime capability does not exist yet, keep the journey in this document and link the owning milestone issue instead of deleting or weakening the acceptance row.

## Related References

- [Catalog Integration Control Plane](./catalog-integration-control-plane.md)
- [Catalog Control Plane Architecture](./catalog-control-plane-architecture.md)
- [Provider Integration Admin Module](./provider-integration-admin-module.md)
- [Catalog Integration Admin UX And Accessibility Acceptance](./catalog-integration-admin-ux-accessibility.md)
- [Catalog Integration No-Confusion UX Acceptance](./catalog-integration-no-confusion-ux-acceptance.md)
- [Catalog Scope Sync And Merge Candidate Handoff](./catalog-scope-sync-merge-candidate-handoff.md)
- [Catalog Integration Audit Evidence](./catalog-integration-audit-evidence.md)
- [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md)
- [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md)
