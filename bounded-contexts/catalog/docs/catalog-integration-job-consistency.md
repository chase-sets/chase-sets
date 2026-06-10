# Catalog Integration Job Consistency

Catalog owns consistency for provider profile lifecycle work, integration jobs, Source Observation review jobs, promotion, reapply, rollback, and retirement. Platform durable-job storage provides leases, events, and work-unit checkpoints; Catalog defines what duplicate submissions, profile changes, retries, partial failures, and deploy skew mean to operators. The schema versioning and compatibility policy for job payloads, work units, profile snapshots, and retained data is documented in [Catalog Integration Schema Compatibility](./catalog-integration-schema-compatibility.md). The reset/backfill/rollback release plan is documented in [Catalog Integration Data Migration Reset](./catalog-integration-data-migration-reset.md).

## Submission And Lifecycle Rules

- Duplicate import or reapply submissions reuse an active job only when action, normalized scope, actor/account context, and profile snapshot match.
- Import jobs snapshot provider key, profile key, profile version, lifecycle, connector kind, connector source version, and Source Observation mapping fingerprint at enqueue time.
- Reapply integration jobs snapshot `current-active-profile` mode plus the active profile version and enqueue one work unit per eligible promoted Source Observation.
- Profile edits, activation, rollback, deprecation, and retirement are blocked while same-provider import, reapply, or promote work is queued or running. Provider-unknown promote/reapply jobs are treated as blocking until their scope is known.
- Dry runs are request-time evaluations and do not enqueue durable jobs, write Source Observations, or change profile lifecycle state.

## Retry And Resume

- Worker turns are bounded. Each successful turn persists progress and mixed outcomes before releasing the claim.
- Retrying an import requeues the same durable job id, preserves the snapshotted profile, keeps successful expansion or target outcomes, and prunes failed outcomes so only failed provider work runs again.
- Resuming an import requeues the same durable job only when it is queued or the running claim is stale. A live running claim returns the current job snapshot instead of creating duplicate provider work.
- Cancelling an import marks the durable job as failed with operator status `cancelled`, clears live claims, records a status event, and leaves successful mixed outcomes visible for audit. Completed jobs and unsupported actions fail closed.
- Reapply work units are claimed independently and use Source Observation IDs as unit IDs, so replaying worker setup does not enqueue duplicate units for completed observations.
- Lost parent-job or work-unit leases cause a handoff instead of marking the job failed. The next worker resumes from durable outcomes and terminal work-unit states.
- API and worker deploy skew is safe because jobs execute against their snapshotted profile version instead of whichever version is active after deployment.
- Integration job payloads use `catalog-integration-durable-job-v1`; integration work-unit payloads use `catalog-integration-work-unit-v1`. Both are retained while referenced and must tolerate additive fields during API/worker deploy skew.

## Promotion And Reapply Idempotency

- Source Observations are keyed by provider, language, and external key. Re-importing unchanged provider facts records refresh evidence instead of duplicating observations.
- Promoting an observed Source Observation reuses an existing source-linked or duplicate-prevention Catalog Item when exactly one safe candidate exists.
- Promoting a changed or already promoted Source Observation refreshes the linked Catalog Item and preserves `catalog_item_id`.
- Reapply targets only promoted Source Observations, requires an existing promoted Catalog Item link, and never creates replacement Catalog Items.
- Promotion and reapply outcomes are mixed: skipped and failed records remain visible without rolling back already-durable successful outcomes.

## Operator Status

Admin job summaries expose both durable state and operator status:

- `queued`: durable job exists and has not been claimed.
- `running`: a worker owns or is actively processing the job.
- `stale`: reserved for projections that detect an expired claim or lagging checkpoint.
- `retried`: reserved for projections that aggregate retry attempts from work-unit history.
- `partial`: the job completed with one or more failed outcomes.
- `failed`: the job itself failed before a complete mixed result was durable.
- `cancelled`: an operator cancelled a queued or running provider import job.
- `completed`: all requested work completed without failed outcomes.

The job DTO also exposes consistency policy names: duplicate submissions reuse active jobs, profile snapshots are captured at enqueue, retry/resume skips completed outcomes, partial failures are mixed outcomes, and work is claimed through leased job turns or leased work units depending on the workflow.

## Rollback And Retirement

Rollback activates a prior validated profile version and deprecates the current active version; it does not rewrite observations or running jobs. Retirement requires the profile to be inactive and unreferenced by Source Observations, and it is blocked while matching active jobs are present.

Pre-launch reset is blocked while integration or bulk review jobs are queued or running. Forced active-job cleanup is only for explicit pre-launch wipe decisions; normal rollback cancels or drains active work, activates the prior profile version, and enqueues fresh import/reapply work when the rollback must affect new processing.

For the Catalog Control Plane rebuild, "retire", "remove", "deprecate", and "cleanup" mean complete deletion from runtime code, API routes, UI modules, product patterns, tests, fixtures, screenshots, documentation, runbooks, release notes, operator instructions, aliases, flags, fallbacks, redirects, support-only routes, and compatibility shims.
