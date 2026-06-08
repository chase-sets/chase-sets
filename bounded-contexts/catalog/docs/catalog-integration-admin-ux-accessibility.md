# Catalog Integration Admin UX And Accessibility Acceptance

The Catalog Integration Admin Control Plane is a dense operator workspace for high-volume provider diagnostics, profile authoring, dry runs, Source Observation review, promotion, replay, activation, rollback, retirement, and audit work. It must stay compact, keyboard-operable, and evidence-rich without requiring operators to inspect or edit raw JSON.

This checklist is a release gate for Admin Control Plane UI slices and a test-plan input for #790 and #802.

Operator acceptance journeys are tracked separately in [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md). Use this UX checklist to prove the workspace is operable; use the journey checklist to prove operators can complete happy-path, failure/recovery, destructive lifecycle, and audit jobs.

## Acceptance Checklist

| Area | Acceptance check | Verification |
| --- | --- | --- |
| Dense scanning | Workflow modules use compact headings, status pills, summary facts, tables, and scoped actions without marketing-style hero/card bloat. | `catalog-integrations.spec.ts` verifies validation and operations workflow modules by accessible heading. |
| State coverage | Empty, loading, stale, error, blocked, and partial-success states have visible operator copy and do not collapse the module frame. | Unit tests must cover blocked readiness, disabled write actions, dry-run failures, and job progress states. |
| Long diagnostics | Diagnostic text, remediation, evidence paths, and deeply nested section paths remain readable and associated with the affected workflow/module. | Unit tests should include long path and remediation examples in activation readiness or section diagnostics. |
| High-volume lists | Job, Source Observation, diagnostic, audit, compare, and promotion tables stay compact and server-paginated where the read model can grow. | Query/read-model SLOs define pagination and stale-state expectations; UI tests verify representative dense tables render without raw JSON fallback. |
| Keyboard flow | Module tabs, table actions, dialog actions, section editors, and destructive confirmations are reachable by keyboard and preserve focus context. | E2E tests must tab through the integration module tabs and into scoped workflow actions. |
| Accessible names | Workflow modules, tabs, dialogs, progress, readiness checks, destructive actions, and evidence controls have stable accessible names. | Tests should use role/name selectors for module tabs, workflow headings, dialogs, and primary actions. |
| Responsive behavior | Supported admin viewports keep workflow modules readable; action bars wrap instead of overlapping tables or status labels. | E2E tests should exercise desktop and compact admin widths for validation and operations modules. |
| Impact clarity | Activation, rollback, retirement, bulk promotion, reapply, reject, and migration-evidence confirmations show affected references, profile version, scope, and blocking checks. | Dialog/unit tests verify impact facts before the confirm action is enabled. |
| Readiness separation | Provider adapter/transport readiness is visually distinct from Catalog semantic readiness and activation readiness. | Health/readiness tests verify both adapter readiness and Catalog readiness labels are present. |
| No raw JSON fallback | Normal workflows do not expose Profile JSON, Candidate profile JSON, Active profile JSON, Fixture Payload JSON, or Dry-run output JSON editors. | Unit and E2E tests assert these labels are absent in profile workbench, compare, edit, evidence, and dry-run workflows. |

## Dense-State Fixtures

Acceptance tests should keep examples for these states close to the consuming workflow tests:

- blocked activation with multiple domain concepts, long section paths, remediation, and fixture-flow metadata;
- active or recently completed integration jobs with profile snapshot, scope, progress, and transport/semantic readiness;
- dry-run evidence with diagnostic links, Source Observation facts, duplicate candidates, promotion command evidence, and redaction summary;
- semantic comparison with changed and unchanged sections, severity, fingerprints, and activation impact;
- view-only operator state where safe read actions remain available and write/destructive actions are disabled.

## Release Verification

Every release that changes Admin Control Plane workflow UI must record:

- the focused unit or integration tests that cover the changed workflow states;
- the E2E path that verifies the signed-in operator surface;
- whether responsive/keyboard behavior was verified locally, in CI, or deferred with a follow-up issue;
- any raw JSON fallback found during verification and the owner issue that quarantines it;
- any high-volume list, stale-state, or long-diagnostic gap discovered during review.

## Related References

- [Provider Integration Admin Module](./provider-integration-admin-module.md)
- [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md)
- [Catalog Integration Control Plane](./catalog-integration-control-plane.md)
- [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md)
- [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md)
- [Catalog Integration Diagnostic Taxonomy](./catalog-integration-diagnostic-taxonomy.md)
- [Operational Workflow Patterns](../../../packages/design-system/OPERATIONAL_WORKFLOWS.md)
