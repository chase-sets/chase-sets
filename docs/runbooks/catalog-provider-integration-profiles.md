# Catalog Provider Integration Profiles

Catalog provider profile versions control provider option queries, Source Observation normalization, promotion planning, and durable import behavior.

## Normal Activation

1. Open Catalog Integrations admin with `catalog.manage`.
2. Clone the current profile version.
3. Edit the draft or test version through guided profile sections. Do not edit raw profile JSON for normal operator work.
4. Run fixture dry-runs against committed fixture payloads and review grouped diagnostics, redaction summary, normalized output, duplicate-prevention decisions, selected Options, external references, and promotion command-plan preview.
5. Compare the candidate against the active profile and review lifecycle, capabilities, option queries, connector, mapping, evidence, duplicate-prevention, promotion-plan, fixture, and mapping-fingerprint impact.
6. Record structured migration evidence when the mapping fingerprint changes. Include before/after fingerprints, fixture run id, replay scope, observed impact, and an operator note.
7. Activate the version from admin. Activation must pass the fixture harness and migration-evidence guard before it can become active.
8. Run a narrow provider import or reapply job and review Source Observation counts, job result summary, grouped failures, and promoted/reapplied counts before broad import.

Activation diagnostics with code `profile_activation_blocked` are operator-actionable. Fix the reported fixture, mapping, redaction, or migration-evidence issue, then retry activation. Do not bypass the fixture harness with live provider calls.

## View-Only Access

Operators with `catalog.view` can inspect profiles, review observations, compare versions, and inspect safe diagnostics. Profile authoring, lifecycle writes, imports, promotion, reapply, rollback, retirement, and migration-evidence saves require `catalog.manage`.

If a write action is disabled, confirm the actor has `catalog.manage` before treating it as a product defect. Server-side authorization remains the source of truth even when the UI also disables write controls.

## Blocked Activation

When activation is blocked:

1. Open the activation readiness or compare panel for the candidate profile.
2. Fix diagnostics in the relevant guided section. The diagnostic path should identify the section/control without requiring JSON editing.
3. Re-run the fixture dry-run for the failing flow.
4. Add or update migration evidence if the active/candidate mapping fingerprint changed.
5. Retry activation only after readiness checks are non-blocking.

Never paste raw provider payloads, secrets, pricing, inventory, seller, listing, order, message, or operations facts into evidence notes.

## Fixture Failure

Fixture failures indicate a profile contract problem, stale fixture coverage, or unsafe evidence use.

1. Select the failing fixture flow in the dry-run workbench.
2. Review grouped diagnostics and redaction summary.
3. Use safe typed override controls only for supported fixture variations.
4. Update the profile section or fixture metadata through guided controls.
5. Commit fixture changes through the owning code path when fixture evidence needs to change.

Do not use live provider calls to satisfy activation evidence.

## Missing Migration Evidence

When activation reports missing migration evidence:

1. Compare candidate and active profiles.
2. Record before and after mapping fingerprints.
3. Run the relevant fixture or replay scope.
4. Capture observed impact and the operator decision in structured migration evidence fields.
5. Retry activation.

## Rollback

Rollback means reactivating a prior validated profile version. Use it when a newly activated profile causes import failures, unexpected Source Observation normalized facts, or promotion command-plan regressions.

After rollback, queued import jobs that already have a profile snapshot continue using their queued version. New imports use the rolled-back active profile. Integration reapply jobs snapshot `current-active-profile` when queued, so cancel and enqueue a new reapply job if the rollback must affect a pending reapply.

After rollback, run a narrow import or reapply job and verify the completed job summary before broad replay. Record lifecycle audit context through admin; do not edit historical profile rows in place.

## Pre-Launch Data Reset

Use the Catalog Integration Data Migration Reset and Legacy Cleanup plans when release needs to wipe unlaunched integration-control-plane data and rebuild from current bootstrap.

1. Verify no Catalog integration or bulk review jobs are queued or running.
2. Capture the before-reset verification report from `collectCatalogIntegrationDataVerificationReport`.
3. Run the pre-launch wipe/rebuild path from `resetCatalogIntegrationPreLaunchData`.
4. Confirm seeded provider profiles were rebuilt through the persisted profile version store.
5. Confirm Source Observations, integration jobs, bulk review jobs, work units, and learned provider rate limits are empty.
6. Confirm legacy Source Observation profile references are zero.
7. Confirm profile section projections exist for retained or seeded profile versions.
8. Confirm normal Admin authoring exposes section-scoped typed controls with `rawJsonBacked=false`.
9. Record any retained admin-authored profile, Source Observation, fixture, job, raw JSON route, or compatibility path with owner, reason, removal date, removal criteria, and launch gate in #804.

Forced reset with active jobs is allowed only for explicit pre-launch cleanup decisions. Normal rollback should cancel or drain active work, activate the prior profile version, and enqueue fresh import/reapply work if needed.

The broad Provider Integration Profile patch route is quarantined under #789 for controlled internal or migration compatibility. Operators should not use it for normal profile authoring, validation, activation, dry-run, import, promotion/reapply, rollback, or retirement workflows.

## Retirement

Retire a profile version only after no Source Observations reference it as a source or promotion profile version. Admin retirement is blocked while references remain.

If retirement is blocked, use Source Observation filters and profile-version audit data to decide whether to archive historical observations, re-import/reapply them under the active profile, or keep the version deprecated and readable.

## Bootstrap Failure

Catalog bootstrap preserves admin-authored profile rows and then checks that seeded active providers still have an active persisted row. If bootstrap reports a missing active provider profile row:

1. Inspect Catalog Integrations admin or the `catalog_provider_integration_profile_versions` table for the provider.
2. Activate a validated replacement version or restore the seeded active version.
3. Re-run bootstrap.

Do not re-enable static runtime profile fallback. Persisted profile versions are the runtime source of truth for admin-managed integrations.
