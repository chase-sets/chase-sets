# Catalog Provider Integration Profiles

Catalog provider profile versions control provider option queries, Source Observation normalization, promotion planning, and durable import behavior.

## Normal Activation

1. Clone the current profile version in Catalog Integrations admin.
2. Edit the draft or test version and run fixture dry-runs against committed fixture payloads.
3. Record migration evidence that summarizes fixture results, replay comparison, and any mapping fingerprint changes.
4. Activate the version from admin. Activation must pass the fixture harness and migration-evidence guard before it can become active.
5. Run a narrow provider import or reapply job and review Source Observation counts before broad import.

Activation diagnostics with code `profile_activation_blocked` are operator-actionable. Fix the reported fixture, mapping, redaction, or migration-evidence issue, then retry activation. Do not bypass the fixture harness with live provider calls.

## Rollback

Rollback means reactivating a prior validated profile version. Use it when a newly activated profile causes import failures, unexpected Source Observation normalized facts, or promotion command-plan regressions.

After rollback, queued import jobs that already have a profile snapshot continue using their queued version. New imports use the rolled-back active profile. Integration reapply jobs snapshot `current-active-profile` when queued, so cancel and enqueue a new reapply job if the rollback must affect a pending reapply.

## Retirement

Retire a profile version only after no Source Observations reference it as a source or promotion profile version. Admin retirement is blocked while references remain.

If retirement is blocked, use Source Observation filters and profile-version audit data to decide whether to archive historical observations, re-import/reapply them under the active profile, or keep the version deprecated and readable.

## Bootstrap Failure

Catalog bootstrap preserves admin-authored profile rows and then checks that seeded active providers still have an active persisted row. If bootstrap reports a missing active provider profile row:

1. Inspect Catalog Integrations admin or the `catalog_provider_integration_profile_versions` table for the provider.
2. Activate a validated replacement version or restore the seeded active version.
3. Re-run bootstrap.

Do not re-enable static runtime profile fallback. Persisted profile versions are the runtime source of truth for admin-managed integrations.
