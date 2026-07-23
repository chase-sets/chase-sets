# Release Process Evolution

This runbook defines the Chase Sets release model that evolves the current GitHub Actions and DigitalOcean deployment process toward smaller, safer, observable releases.

The operating goals are:

- `main` stays green and close to the smoke-verified `production` marker.
- Production deploys stay automatic for routine deployable changes after required checks pass.
- Launch, live-money, provider, and tax gates block only the capability exposure they protect.
- Operators can lock production promotion during incidents and use one audited emergency path for fix-forward or revert.
- Capability exposure moves from broad environment switches toward deterministic account-level rollout controls.

## Release Queue Policy

Use GitHub native merge queue as the default queue implementation for `main`. Do not build custom `/shipit` tooling unless native merge queue cannot enforce the policy below.

Queue admission requires:

- pull request approval according to repository rules
- a successful `PR Required` check from `.github/workflows/platform-pr.yml`
- no unresolved destructive production infrastructure approval questions
- current branch state rebased or mergeable through the queue's synthetic merge group
- no active production release lock unless the pull request is the audited emergency release

Queue behavior:

- Batch deployable pull requests through GitHub native merge queue with a maximum group size of two.
- Documentation-only and non-deployable changes may batch when the merge queue can still prove `PR Required`.
- Increase beyond two only when release-health metrics show low staging failure, low production smoke failure, low rollback/fix-forward rate, low canary abort rate, low queue wait, and low main-to-production drift.
- If a batched merge group turns red, split and retry the batch to isolate the offending pull request before re-enqueueing healthy changes. This reduces deploy count on green paths but can add bisection time when a grouped PR fails `PR Required`.

`.github/workflows/platform-merge-group-failure-signatures.yml` evaluates completed merge-group, actual Platform Deploy, and ephemeral-verification runs as events; the daily schedule only reconciles the same state. Each root failure is normalized as `delivery-failure-signature/v1` and stored in one canonical issue with a hidden machine marker. A circuit enters `holding` after the same deterministic signature appears on two distinct candidates within 30 minutes or three times within six hours. Retry-pass evidence is reported to the flake digest and does not retain a deterministic hold. Detection and canonical issue updates always run. After the 48-hour advisory comparison, enable release holds first with `DELIVERY_FAILURE_RELEASE_CIRCUIT_ENFORCEMENT=true`; enable merge-group fast-fail separately with `DELIVERY_FAILURE_MERGE_GROUP_CIRCUIT_ENFORCEMENT=true` only after a successful repair-path exercise.

An active circuit holds only its recorded lane. Automatic merge-group and release work fails before the heavy battery or staging mutation. A merge-group repair requires exactly one `ci-circuit-repair` pull request containing `Repairs #<canonical issue>` and a repair author with write permission; it still runs the complete affected battery and `PR Required`. Manual Platform Deploy recovery requires `circuit_issue_number` plus `circuit_reason` from an actor with write permission. API-unavailable enforcement fails closed. Successful repair release/verification, or three consecutive affected-lane successes without a repair, recovers and closes the circuit.
- Keep stale release behavior from the deployment workflow: if a queued automatic deployment starts after a newer `origin/main` exists, skip that stale deployment and let the newest release proceed.
- Keep direct pushes disabled for normal work. Emergency release bypass must be explicit and audited.

Required GitHub native merge queue settings for `main` after the #4022 operator action:

| Setting | Value |
| --- | --- |
| Merge method | `SQUASH` |
| Grouping strategy | `ALLGREEN` |
| Minimum pull requests to merge | `1` |
| Maximum pull requests to merge | `2` |
| Maximum pull requests to build | `2` |
| Minimum merge wait | `0 minutes` |
| Required check | `PR Required` |
| Check response timeout | `60 minutes` |

The machine-readable source of truth is `scripts/release-health-merge-queue-policy.json`; the table above documents the same policy for operators. `.github/workflows/platform-merge-queue-posture.yml` runs `pnpm run ops -- release-health:queue-posture` daily and on demand. The read-only guard fetches ruleset `17097957` with `GET`, compares every checked-in queue parameter and required check with live state, writes a release-health artifact, and fails the workflow when drift is present. It never mutates repository ruleset state. Run the same command locally with a token in `GH_TOKEN` or `GITHUB_TOKEN`; a non-zero exit means an operator must reconcile live state in GitHub. Update the policy file and this table together whenever the release policy changes.

`.github/workflows/platform-pr.yml` must run on `pull_request` and `merge_group` so `PR Required` is evaluated for both pull request heads and merge queue synthetic commits. Non-blocking coverage telemetry intentionally lives in `.github/workflows/platform-coverage.yml`, which runs daily against `main` and can be dispatched manually for a specific ref; merge groups do not wait on coverage artifacts.

Operator action for #4022: GitHub merge queue sizing is repository ruleset state, not workflow code. In the GitHub UI, edit repository ruleset `17097957` (`Require merge queue for main`) and set the merge queue rule for `refs/heads/main` to **Maximum pull requests to merge = 2** and **Maximum pull requests to build = 2**. API operators may instead `GET /repos/chase-sets/chase-sets/rulesets/17097957`, preserve the existing ruleset payload, and `PUT /repos/chase-sets/chase-sets/rulesets/17097957` with the `merge_queue` rule parameters `max_entries_to_merge: 2` and `max_entries_to_build: 2`; keep `min_entries_to_merge: 1`, `grouping_strategy: "ALLGREEN"`, `merge_method: "SQUASH"`, and `check_response_timeout_minutes: 60`.

Current repository evidence from June 1, 2026:

- `main` has branch protection with strict required status checks, `PR Required`, required conversation resolution, required linear history, and admin enforcement.
- Repository rulesets currently include `Protect production deployed marker` for `refs/heads/production`, blocking deletion and non-fast-forward updates.
- Repository ruleset `17097957`, `Require merge queue for main`, is active for `refs/heads/main` in `chase-sets/chase-sets`.
- The active `main` ruleset requires `PR Required`, required linear history, no non-fast-forward updates, and GitHub native merge queue with the settings above.
- `PR Required` runs on `merge_group` events, so Chase Sets validates merge queue synthetic commits before they land.
- Repository auto-merge is currently disabled; leave it disabled unless merge queue policy deliberately adopts it.

Emergency release behavior:

- Use one path for production recovery: revert or fix-forward, merge through the fastest approved emergency mechanism, deploy, verify, and record the evidence reference.
- Emergency release bypass may skip a release lock only when `emergency_release=true` and `emergency_reference` points to an incident, revert, fix-forward PR, or rollback evidence record.
- Emergency releases still deploy the immutable release commit through staging and production unless the incident owner explicitly documents why the normal staging path would worsen recovery.

## Risk Review Advisory Rollout

`Risk Review Advisory` is currently a separate, non-enforcing workflow. It publishes risk classification and current-head approval state, but it is not a required status check, is not consumed by `PR Required`, and is not present in the checked-in or live `main` ruleset posture. Enforcement is a future operator action only after the calibration and reviewer-independence gates below pass.

The versioned source of truth is `scripts/lib/risk-policy-v1.mjs`. Both `scripts/change-scope.mjs` and `.github/workflows/platform-risk-review.yml` consume that module; do not add a second path or category list in workflow YAML. High risk covers money movement, cross-context public contracts/events/subscriptions, migrations/backfills/destructive retention work, authentication/authorization/security policy, deployment/infrastructure/secret/configuration/emergency controls, existing integration-risk surfaces, and the approved `risk:high` label. Documentation and tests alone remain low risk unless they are executable migration/deployment fixtures, modify the risk-review safety policy, or are inside a pre-existing integration-risk runtime-composition surface. The advisory classifier can cover more territory than `integration_risk_required`; the latter retains its production path corpus and reasons because it gates the DB/E2E battery. Renames scan old and new paths for advisory review, while the battery projection retains the current-path semantics of the production change-scope input. Deletions scan the deleted path, and generated metadata is coupled when a high-risk source changes.

The workflow runs for pull-request changes, submitted or dismissed reviews, merge groups, and manual recovery. Review-event execution reads the evaluator, eligibility configuration, and policy from the trusted default branch through the GitHub Contents API. It never checks out or executes pull-request head code. This keeps forks and head-authored workflow changes outside the elevated `pull_request_target`/review trust boundary. GitHub file and review APIs are paginated, and pull-request files are reconciled against the authoritative `changed_files` count. A count mismatch or the 3,000-file provider cap produces bounded `unknown`, never a low-risk qualification. Malformed projections, unsafe pagination links, permission drift, or partial API results also produce bounded `unknown`. Logs and summaries contain only safe status codes, never exception messages, tokens, review bodies, or raw API bodies.

Eligibility is closed-schema configuration in `scripts/risk-review-eligibility-v1.json`. It is intentionally empty in the advisory implementation. Before any enforcement change, Todd must configure at least two genuinely independent eligible principals or one eligible team. A principal is matched by the exact GitHub login returned by the API; the pull-request author never counts. A bot counts only when that exact principal is configured with `allowBot: true`. Team membership must be confirmed through the GitHub API for the configured organization/team; an unreadable membership is `unknown`, not ineligible. Do not simulate independence with the author's account.

Approval lifecycle and total ordering:

| State | Meaning | Transition or steady state |
| --- | --- | --- |
| `low-risk` | No canonical risk finding | Remains low on routine re-evaluation; a risky file/label transitions to configuration or approval evaluation. |
| `configuration-required` | High risk with no eligible principal/team configured | Remains advisory and visible until operator configuration changes. |
| `approval-required` | High risk without a qualifying current-head decision | A current-head eligible approval transitions to `approved`. |
| `approved` | The latest decisive eligible current-head review is `APPROVED` | Routine day-after evaluation remains approved; a commit/head change resets to `approval-required`; dismissal removes that approval; a later eligible `CHANGES_REQUESTED` transitions to `approval-required`. |
| `unknown` | API, pagination, schema, or eligibility authority was incomplete | A later complete evaluation replaces it; advisory workflow and `PR Required` remain green. |

Submitted reviews are ordered totally by `submitted_at`, numeric review `id`, then actor login. Only reviews whose `commit_id` exactly equals the pull request's current head participate. `PENDING`, `COMMENTED`, and `DISMISSED` records are not decisive. Across eligible independent actors, the latest current-head `APPROVED` or `CHANGES_REQUESTED` decision wins, so a later approval can resolve an earlier request and a later request invalidates an earlier approval. This state is recomputed from current GitHub truth on every event; no retained approval can falsely satisfy a new head or permanently block a later valid state.

Merge-group evaluation never asks for review of the synthetic merge commit. It resolves constituent pull requests from the synthetic commit association, requiring the exact merge SHA and base branch; its compare fallback accepts only pull requests whose current head SHA is an exact constituent commit. Each constituent is then classified and reviewed independently. Missing, incomplete, or unrelated associations yield `unknown` rather than borrowing another pull request's approval.

One pull-request comment is maintained by the hidden `chase-sets:risk-review:v1` marker. Re-evaluation updates that comment instead of posting another; low-risk evaluation updates an existing marker but does not create a new comment. The job summary reports classification, evaluation, and scanned/total surface. Neither surface includes raw exception or review content.

Operator gates before enforcement:

1. Configure the independent reviewer principals/team above and verify normal absence coverage.
2. Run advisory classification for at least 7 days and at least 50 pull requests, covering each observed high-risk category.
3. Disposition false positives and false negatives; record review demand and incremental high-risk latency, and confirm median low-risk lead time regresses by no more than 2 minutes.
4. Decide the emergency-override authority and audit contract. The future override must require an authorized actor, reason, linked incident, and current head; it expires on the next commit and never bypasses `PR Required`. No override is implemented in advisory mode.
5. Only then make a separate reviewed change that adds `Risk Review` to the ruleset policy/posture and live ruleset. Do not describe that future capability as active before the live mutation is complete.

## PR Scope Advisory Rollout

`PR Scope Advisory` reports raw and normalized PR size and is, like `Risk Review Advisory`, non-enforcing today: it is not a required status check and does not mutate the live `main` ruleset. The versioned source of truth is `scripts/lib/pr-scope-policy-v1.mjs` (`pr-scope-policy/v1`), which reuses `scripts/lib/risk-policy-v1.mjs`'s canonical risk categories and generated/test/fixture path vocabulary rather than defining a second one. The trusted-base fetch, pagination-completeness reconciliation against `changed_files`, the 3,000-file provider cap, and the bounded-`unknown`/safe-code error contract are the exact same contracts `scripts/platform-risk-review.mjs` established for #5503; `scripts/platform-pr-scope.mjs` imports them directly instead of re-deriving a divergent evaluator.

Normalized scope excludes lockfile-only churn, generated registries/metadata under a `generated/`/`__generated__/` path, snapshots (`.snap`/`__snapshots__/`), vendored/binary files (GitHub reports zero additions and zero deletions with no patch — the only diff-metadata-provable binary signal, so an oversized text diff with an omitted patch is never mistaken for binary and its raw size is never hidden), and formatting-only changes (proven only when the patch's counted `+`/`-` lines exactly match the reported additions/deletions, so a truncated patch is never treated as proven). Tests, migrations, workflows, and handwritten generator sources always count. Thresholds are exact and inclusive of the boundary itself: advisory at normalized lines > 1,000 or files > 20; large at normalized lines > 2,500 or files > 35.

One pull-request comment is maintained by the hidden `chase-sets:pr-scope:v1` marker, reusing the same actor/type-gated upsert `platform-risk-review.mjs` uses (so an actor-spoofed marker cannot hijack the comment). Rollout mode is closed-schema configuration in `scripts/pr-scope-rollout-v1.json` (`pr-scope-rollout/v1`), currently `"advisory"`. In advisory mode the `Scope Policy Check` job always exits `0` regardless of computed scope — enforcement failure is never silently enabled. Enforcement mode is implemented and tested (`scripts/platform-pr-scope.test.mjs`) but not active: once an operator sets rollout mode to `"enforcing"`, a large PR without a `## Large-change rationale` section fails only the lightweight, read-only `Scope Policy Check` job (no label/comment mutation, no expensive battery run), and a large PR is given the existing `full-ci` full-battery label — removed automatically only when this automation's own prior `labeled` event added it, never a human-applied label. The mechanical-migration escape (`scope:mechanical-migration-reviewed` label, configured in the same rollout file) drops only the rationale requirement; it never hides raw scope or skips full CI.

Operator gates before enforcement:

1. Run advisory PR-scope reporting for the stated 14-day calibration period and compare normalized thresholds against actual failure/lead-time data (delivery-health's `windows.*.prs.prScope`, fed by the same production collector, not a fixture).
2. Fix any false exclusions found during calibration.
3. Only then change `scripts/pr-scope-rollout-v1.json`'s `mode` to `"enforcing"` in a separate reviewed change, and only then wire `Scope Policy Check` into any required-status ruleset — that ruleset mutation is not part of this rollout.

## Release Locks

`PRODUCTION_RELEASE_LOCKED=true` pauses production promotion. The production deployment workflow evaluates the lock before production configuration validation, Terraform planning, or DOKS deployment.

Required production GitHub Environment variables:

| Variable | Purpose |
| --- | --- |
| `PRODUCTION_RELEASE_LOCKED` | `true` blocks normal production promotion; omit or set `false` for the normal release path. |
| `PRODUCTION_RELEASE_LOCK_REASON` | Required when locked; explain the incident, maintenance, or unsafe condition. |
| `PRODUCTION_RELEASE_LOCK_REFERENCE` | Optional but expected; point to an incident, maintenance ticket, or production evidence record. |

Manual emergency dispatch inputs:

| Input | Purpose |
| --- | --- |
| `emergency_release` | Set `true` only for an audited fix-forward or revert that must pass an active production release lock. |
| `emergency_reference` | Required when `emergency_release=true`; point to the incident, PR, or rollback evidence record. |

Unlock only after the incident owner confirms production is ready for normal promotion, current `main` is safe to deploy, and any queued release has a clear owner.

Generate the exact GitHub Environment commands from the repo root:

```powershell
pnpm run ops release-lock:commands --action lock --environment production --reason "Payment provider incident" --reference "INC-2026-05-31-001"
pnpm run ops release-lock:commands --action unlock --environment production
```

The generator reads the current production lock inputs, validates lock reason requirements, and produces the `gh variable set` shape to run against the production GitHub Environment. Release locks are GitHub Environment state operated from CI and `scripts/`; the application does not host a release-lock console.

## Post-Deploy Production Verification

The platform ships through the DOKS Helm release, with optional Argo Rollouts proportional exposure when the protected environment enables it. After workloads become ready, the workflow runs synthetic, operator-safe post-deploy checks before advancing the `production` marker. When proportional exposure is disabled these checks protect an ordinary rolling update; when it is enabled, AnalysisTemplate evidence and rollout state add the traffic-split gate.

The post-deploy checks are:

- Stage 1 production URL smoke: landing host HEAD probe, admin host HEAD probe, and (only when public marketplace is enabled) marketplace host HEAD probe;
- with proof mode enabled, the authenticated proof-mode [Buy Now Freshness Probe](./guest-buy-now-freshness-probe.md) and the Settlement provider-health probe against the gated proof topology;
- the immutable release commit and production workflow run recorded in `release-health/v1`.

These checks are post-deploy verification, not random public traffic splitting. They run against the single rolled-out release. Unsafe outcomes (a host that fails its HEAD probe, or a freshness probe in a customer-failure state) block the production marker and leave the workflow evidence behind for fix-forward or rollback readiness. The SLO clause of the Buy Now freshness probe is advisory/warn-mode (issue #1323) until the #1237 numeric SLO/load proof ratifies the budget; see the probe runbook for the warn-versus-gate contract.

Post-deploy verification runs only when:

- the staging job deployed the same immutable commit image and passed smoke, critical-flow, and money-smoke gates;
- the release-health record names the release commit, workflow run, start, completion, and the recorded decision;
- no active release lock is set unless this is an emergency release.

When a check fails, recover by fix-forward or by rolling back to the last smoke-verified production release through the emergency-recovery and rollback-readiness workflows, and preserve the release-health record for investigation. Wider capability exposure stays governed by the deterministic rollout controls below, not by a deployment-time traffic split.

## Rolling Delivery Health SLIs

`.github/workflows/platform-delivery-health.yml` publishes the canonical `delivery-health/v1` record hourly and a distinct daily trend at 08:43 UTC. Every record includes rolling 24-hour, rolling 7-day, and last-20 views, so operators do not need to join separate artifacts. Records and Markdown summaries are retained for 30 days. The weekly flake and review-cadence digests link this record instead of calculating competing delivery rates.

Run the collector locally with read access to Actions, pull requests, and issues:

```powershell
pnpm run ops -- release-health:delivery-health `
  --repository chase-sets/chase-sets `
  --publication-mode hourly `
  --out .\artifacts\release-health\delivery-health\delivery-health.json `
  --markdown-out .\artifacts\release-health\delivery-health\delivery-health.md
```

The workflow-source mapping and every target/minimum sample live in `scripts/release-health-delivery-health-policy.json`. `Platform Release Candidate Dispatch` runs measure automatic main-push dispatch, while `Platform Deploy` runs measure explicit release decisions. Release-stage job and `release-health/v1` evidence still exclude the read-only cutover-plan entry point from actual-release denominators. The two public workflow identities keep dispatch and release outcomes separate without event heuristics.

The dispatcher rolling metrics have a deliberate epoch at the workflow split: dispatcher windows include only `Platform Release Candidate Dispatch` runs and do not union pre-split `Platform Deploy` push history. Expect dispatcher sample counts and rolling rates to reset when the split lands, then refill naturally over the 24-hour, 7-day, and last-20 windows.

Intentional superseding, coalescing, newer-candidate cancellation, and not-eligible skips stay visible as capacity/churn but are excluded from pass/fail denominators. Unknown cancellations are not silently excluded as intentional success. Stage outcomes prefer existing `release-health/v1` artifacts and fall back to stable Actions job identities; root-cause and recovery metrics consume existing `delivery-failure-signature/v1` issue markers and never reclassify raw logs.

Every collection records query bounds, source run IDs, API pagination/rate-limit status, artifact gaps, and overall completeness. A truncated API response, failed artifact read, missing successful-release artifact, or sample below policy minimum produces `insufficient-data`; it does not open or close a breach. Active breaches update one canonical issue per SLI using a hidden `delivery-health-sli/v1` marker. A complete recovery closes that same issue. P0 posture (0% eligible ephemeral verification, actual release below the P0 policy floor, or an open staging/production mutation circuit) also fails the scheduled publication after its canonical issue is updated.

For recovery, start with the root failure job/signature in the artifact. Use the existing delivery-circuit issue and the [deployment recovery procedure](./digitalocean-platform-deployment.md) for held staging/production lanes; use the flake digest for retry-pass evidence. Do not retry deterministic failures or clear a circuit merely to improve a headline rate.

## Release Health Metrics

Every deployable release attempt should produce a structured release-health record keyed by release commit and workflow run. Production releases write `production-release.json`; staging failures, cancellations, and stale automatic skips write `staging-release.json` before production starts.

PRs get a lightweight Release Status summary after `PR Required` evaluates. The summary explains whether the change is deployable, whether preview was required, whether exposure posture changed, and whether GitHub merge queue is ready. This is informational only; GitHub native merge queue remains the admission and ordering mechanism.

Minimum schema:

```json
{
  "schemaVersion": "release-health/v1",
  "releaseCommit": "<40-char-sha>",
  "workflowRunId": "<github-run-id>",
  "dispatch": { "source": "automatic|manual|recovery|emergency", "runId": "<dispatcher-run-id|null>", "attempt": "<dispatcher-attempt|null>", "reason": "<audited-reason|null>" },
  "releaseMode": "normal|emergency",
  "deploymentRequired": true,
  "pullRequest": { "openedAt": "<iso|null>", "readyForReviewAt": "<iso|null>", "approvedAt": "<iso|null>" },
  "mainToProductionDrift": { "commits": 0, "seconds": 0 },
  "queue": {
    "batchSize": 1,
    "queuedAt": "<iso|null>",
    "mergeGroupStartedAt": "<iso|null>",
    "mergedAt": "<iso|null>",
    "dequeuedAt": "<iso|null>",
    "failureReason": "<string|null>",
    "mergeSha": "<40-char-sha|null>"
  },
  "releaseCategory": {
    "primary": "ordinary-deploy|exposure-posture-change|emergency-recovery",
    "exposurePostureCategories": ["live-money-provider"]
  },
  "runtimeProfile": {
    "productionMode": "landing|proof|public|null",
    "apiProfile": "landing|proof|public|null",
    "workerProfile": "landing|proof|public|null",
    "provisionedContextCount": 0,
    "activeRuntimeContextCount": 0,
    "exposedRouteContextCount": 0
  },
  "staging": { "startedAt": "<iso>", "completedAt": "<iso>", "result": "success|failure|skipped" },
  "canary": {
    "startedAt": "<iso|null>",
    "completedAt": "<iso|null>",
    "result": "success|failure|skipped",
    "skippedReason": "<string|null>",
    "cohort": { "subjectType": "operator|account|membership|anonymous|null", "size": 0 },
    "promotionDecision": "promote|abort|hold|skipped|null"
  },
  "production": { "startedAt": "<iso>", "completedAt": "<iso>", "result": "success|failure|skipped" },
  "attempt": {
    "result": "success|failure|cancelled|skipped|unknown",
    "phase": "queue|staging|canary|production|review",
    "reason": "<string|null>",
    "workflowUrl": "<github-actions-run-url|null>"
  },
  "ci": {
    "retryCount": 0,
    "flakyFailureCount": 0,
    "topFlakyJobs": [{ "name": "verify:static", "retryCount": 0, "flakyFailureCount": 0 }]
  },
  "releaseLock": { "locked": false, "bypassed": false, "reference": null },
  "verification": {
    "platformSmoke": "success|failure|skipped",
    "criticalFlows": "success|failure|skipped",
    "moneySmoke": "success|failure|skipped"
  },
  "recovery": {
    "mode": "none|readiness|rollback|fix-forward",
    "reference": "<incident-or-evidence-reference|null>",
    "targetCommit": "<40-char-sha|null>",
    "rollbackReadinessResult": "success|failure|skipped|unknown"
  }
}
```

Track these measures from the records:

- PR opened to `PR Required`
- ready/queued to merge
- merge to staging deploy start
- staging deploy, smoke, critical-flow, and money-smoke duration
- production deploy and smoke duration
- merge to `production` marker update
- main-to-production drift in commits and time
- release batch size
- release lock active time
- emergency release count and recovery time
- flaky or retried CI jobs
- preview deploy count, duration, and failure rate
- canary duration, abort rate, and promotion rate

Use GitHub Actions summaries and artifacts first. Emit the same events to observability after production telemetry has stable cardinality limits.

Release-health metadata is resolved from GitHub API evidence. The production workflow records the pull request open time, ready-for-review time, last approval time, merge queue entry time, merge-group workflow start time, active merge queue maximum batch size, merge time, dequeue failure when present, and final merge SHA. If GitHub metadata is temporarily unavailable, the workflow writes deterministic fallbacks and leaves unknown fields empty rather than blocking production recovery.

Profile-aware releases should populate `runtimeProfile` from the same topology evidence described in [Deployable Runtime Profiles](../architecture/deployable-runtime-profiles.md). The selected production mode, API profile, worker profile, and provisioned/active/exposed context counts let operators distinguish ordinary code deploys from capability exposure changes and database lifecycle changes.

Staging abort records are release evidence, not production releases. Treat `attempt.phase: "staging"` with `attempt.result: "failure"` or `"cancelled"` as an abort that must be reviewed before queue tuning. The staging record's `applied` field is the authoritative application signal; a false value with a skipped result is a no-op that should not count as a production failure, but repeated no-op skips are a signal that deployment cadence and queue latency need review.

CI retry posture is resolved from GitHub Actions workflow runs for the release commit. `run_attempt > 1` contributes to `ci.retryCount`; retried runs that eventually pass contribute to `ci.flakyFailureCount`. The release-health report lists the top flaky workflow names and blocks batch-size increase when CI retry/flake rate is unhealthy.

Build a Markdown dashboard from release-health artifacts with:

```powershell
pnpm run ops release-health:report --dir .\artifacts\release-health --out .\artifacts\release-health\summary.md
```

Generate read-consistency route-matrix evidence from Prometheus before adding
the artifact to the report:

```powershell
pnpm run ops read-consistency:route-matrix-evidence `
  --prometheus-url https://prometheus.staging.chasesets.com `
  --environment staging `
  --window 30m `
  --out .\artifacts\wake-drills\read-consistency-route-matrix-evidence.json
```

For repeatable staging evidence, dispatch `Platform Staging Route Matrix
Evidence` with confirm value `generate staging route matrix evidence`. The
workflow uses the staging GitHub Environment and requires
`PROMETHEUS_QUERY_TOKEN` to contain the observability stack query token. Keep
`prometheus_url` at `https://prometheus.staging.chasesets.com` unless the
staging observability host changes. The workflow uploads
`read-consistency-route-matrix-evidence.json`; a failure after artifact creation
is still useful coverage evidence when route rows fail for missing samples or
SLO reasons. A failure before artifact creation, such as missing
`PROMETHEUS_QUERY_TOKEN` or HTTP 401, is an evidence-path configuration blocker.

The report classifies mixed artifact directories by `schemaVersion`: `release-health/v1` records drive release counts and queue SLOs, while Buy Now freshness probes, account-cart consistency probes, wake-drill artifacts, route-matrix wake evidence (`read-consistency-route-matrix-evidence/v1`), and Non-Buy-Now Chrome UAT evidence feed the Projection Freshness Evidence section. Probe artifacts in `artifacts/release-health` no longer count as release attempts. Add wake-drill or route-matrix artifacts with repeated `--file` flags when they live under `artifacts/wake-drills`, for example:

```powershell
pnpm run ops release-health:report `
  --dir .\artifacts\release-health `
  --file .\artifacts\wake-drills\staging-wake-drill-load.json `
  --out .\artifacts\release-health\summary.md
```

The freshness section reports only support-safe labels: environment, flow or route template, promotion decision, verdict, and segment summaries. Route-matrix evidence expands one artifact into per-route rows for checkout, cart, Sell List, payout, payment, and listing route templates, plus a coverage row; it reports receipt-backed wake-before-wait sample count, p95/p99, timeout/error rates, post-write missing receipt or target-context counts, fallback counts, target context, and projection names without raw entity identifiers. Plain route reads that hit a freshness route without a post-write receipt are reported separately as `plain-read-missing-receipt` diagnostics, because they are useful noise for operators but are not themselves failed post-write wake-before-wait samples. A route-matrix row passes only when it has at least one receipt-backed observed histogram sample, p95/p99 values, zero timeout/error/fallback/missing-dependency counts, and bounded target/projection labels. A route reported `blocked` (sampler recorded a support-safe blocker with zero in-window samples, for example an operator persona that is not yet available) or `skipped` (an in-flight deploy window) is a documented coverage gap, not an SLO regression, and does not fail the posture on its own; only a route with real in-window samples that breaches a threshold does. It also summarizes the sustained freshness window across included timestamped evidence artifacts, the ready-latency p95 for Buy Now, wake-drill, and route-matrix evidence, and the durable-convergence p95 for wake drills. The target window is 30 days; a shorter artifact span is reported as `short-window` so #2511 reviews can distinguish a green point-in-time drill from sustained evidence. It fails the posture when evidence contains raw URLs, account/cart/session/payment/payout/event identifiers, email addresses, cookies, tokens, or raw `afterWrite` values; fix the source artifact instead of copying private details into the report.

Pass `--gate` (or set `RELEASE_HEALTH_REPORT_GATE=true`) to turn the segment-level projection freshness posture into a regression gate: `release-health:report` exits non-zero when the included Projection Freshness Evidence artifacts — Buy Now, wake drills, account-cart, non-Buy-Now UAT, or route-matrix — are not support-safe or contain a real breach, and exits `0` (with the posture printed) otherwise, including when coverage is merely `blocked`/`skipped` or no freshness evidence was supplied. `Platform Staging Route Matrix Evidence` runs this after generating its own artifacts (`pnpm run ops release-health:report -- --dir artifacts/wake-drills --gate`), so a real segment-level projection lag SLO regression fails that workflow closed instead of only being visible in a report a human has to remember to read. This intentionally stays a separate, on-demand/staging-scoped gate rather than blocking every `platform-production.yml` deploy: the segment SLOs need a live traffic window (default `30m`) that a release only seconds old cannot have yet, the same reason Buy Now and account-cart use synchronous single-observation probes for deploy-time gating instead.

The report includes SLO posture for cautious merge-queue batch tuning. Initial thresholds are deliberately conservative:

| Signal | Hold/increase threshold |
| --- | --- |
| Staging failure rate | `<= 5%` |
| Production smoke failure rate | `<= 2%` |
| Rollback/fix-forward rate | `<= 2%` |
| Main-to-production drift | `<= 3 commits` |
| p95 queue wait | `<= 30m` |
| Canary abort rate | `<= 5%` |
| CI retry or flake rate | `<= 5%` when telemetry is present |

Increase deployable batch size only when all thresholds pass, p95 queue wait is known, and there are at least 10 recent deployable release attempts. The report returns `increase-to-2`, `hold`, or `decrease-or-hold`; do not mutate repository merge queue rules automatically from the report. If any threshold fails, decrease or hold batch size until the cause is understood.

The same report includes a release process review checklist plus the Capacity and Image Review section. Review it weekly during the milestone sweep and after each production deploy batch. Use `release-health/v1` records, projection freshness artifacts, and `push-wake-capacity-evidence/v1`; do not resize staging or split image groups from memory, anecdotes, or one-off local timings.

Generate current checked-in connection-budget evidence before a capacity review:

```powershell
pnpm run ops push-wake:capacity-evidence --out .\artifacts\release-health\push-wake-capacity-evidence.json
pnpm run ops release-health:report `
  --dir .\artifacts\release-health `
  --out .\artifacts\release-health\summary.md
```

Staging capacity tuning is intentionally explicit. The current Terraform knobs are `staging_database_size`, `worker_instance_size_slug`, `worker_instance_count`, `worker_job_concurrency`, and `worker_database_pool_max`; their defaults keep staging representative enough for the shared full-platform environment. Change them only through a PR after the report shows passing production proof, passing projection freshness, passing connection-budget evidence, no staging abort or stale-skip cause under review, and at least 10 deployable release attempts. A healthy report may return `eligible-for-staging-capacity-downsize-review`, which means "open a deliberate PR for the proposed window," not "auto-downsize." If staging or production duration p95 exceeds 20 minutes while proof and budget checks pass, open a follow-up issue in the infrastructure milestone before changing Terraform.

Keep the shared platform image unless release-health data repeatedly shows that one deployable boundary causes disproportionate queue wait, staging duration, production duration, rollback cost, or operator recovery effort. The report keeps image splitting `deferred-shared-image` until at least three pressure signals recur in the reviewed evidence. A split image group must come with its own owner, dashboard, production marker, rollback path, and release-health gate before it reduces risk.

Operators inspect release state from CI evidence, not an in-app dashboard. The `release-health:report` output above combines release-lock state, `main` and `production` marker SHAs, latest PR/deploy result fields, latest release-health summary, and canary decision, with links back to the GitHub Actions runs and the `production` marker. Read GitHub refs and workflow runs directly from the GitHub API or Actions UI; the release-health JSON artifacts in `artifacts/release-health` are the durable fallback when live GitHub metadata is unavailable.

## Feature Rollout Controls

Feature rollout for release-health is a delivery concern owned by CI (`.github/workflows`) and `scripts/`, not by the application. The rollout policy is a deterministic evaluation contract expressed in a release-health policy file and resolved by the deterministic rollout evaluator; the application does not persist, serve, or render that policy. Pre-launch, feature flags were not retained: a guarded capability was exposed by an explicit rollout policy and removed once it shipped. Product-surface flags are now governed separately by [ADR 0019: Feature Flags And Rollout Boundaries](../adr/0019-feature-flags-rollout-boundaries.md): flags may gate surfaces at composition edges, but never domain decisions or event semantics.

Supported primitives:

- Feature Rollout: named capability policy evaluated by environment and subject
- Rollout Subject: account, membership, operator, or anonymous identity
- Account Allowlist: enable a subject outside the percentage cohort
- Account Opt-Out: disable a subject inside the percentage cohort
- Percentage Rollout: deterministic cohort from 0 to 100
- Kill Switch: disable the feature for every subject

A rollout policy is authored as a `feature-policy.json` file under `artifacts/release-health` and resolved by the deterministic rollout evaluator before any exposure widens. Example Stage 2 rollout policy for the first guarded capability:

```json
{
  "environment": "production",
  "featureKey": "pricing.account-repricing",
  "percentage": 0,
  "allowSubjects": ["account:acc_canary"],
  "optOutSubjects": [],
  "killSwitchActive": false,
  "reason": "Stage 2 account canary for pricing.account-repricing",
  "reference": "https://github.com/todd-skelton/chase-sets/pull/<pr>"
}
```

Evaluation order:

1. Kill switch disables the feature for every subject.
2. Account opt-out disables the feature for that subject.
3. Account allowlist enables the feature for that subject.
4. Percentage rollout enables the feature when the deterministic subject bucket is below the percentage.
5. Otherwise the feature remains disabled.

Percentage cohorts must be deterministic and monotonic. Increasing from 10% to 20% keeps the first 10% enabled and only adds subjects.

Initial candidate guarded capabilities:

- `pricing.account-repricing`, currently the first real bounded-context consumer
- production marketplace public checkout by account cohort after launch
- UCP/AP2 agentic write capabilities by account or operator cohort
- live payout actions by operator-controlled seller accounts
- postage provider label purchase by operator-controlled accounts

Abort a rollout by setting `killSwitchActive=true` for the feature policy. Remove a subject by deleting it from `allowSubjects`; opt-out a subject with `optOutSubjects` when the percentage cohort would otherwise include them. Do not expand `percentage` above `0` until release-health evidence is green for the allowlisted account cohort.

Hold any allowlisted account cohort to these policy preconditions before a percentage rollout widens exposure:

- every cohort subject is an `account:<id>` subject
- every cohort subject is explicitly allowlisted
- `percentage` remains `0`
- `killSwitchActive` is false
- no cohort subject is in `optOutSubjects`

Any policy that violates these preconditions must be corrected with the kill switch or allowlist/opt-out controls before exposing more traffic.

## Production Gate Categories

Production gates must block the smallest surface they protect.

| Category | Examples | Blocks every deploy? | Blocks capability enablement or expansion? |
| --- | --- | --- | --- |
| Ordinary deploy health | `PR Required`, staging deploy, staging smoke, production smoke, destructive Terraform check | Yes for deployable releases | Yes |
| One-time or rare launch gates | Marketplace launch evidence, public presence copy audit, policy page review, launch supply measurement | No after posture is unchanged | Yes |
| Provider/live-money gates | Stripe live keys, Stripe money operations evidence, EasyPost production evidence, SES transactional evidence | No for unrelated routine deploys | Yes for enabling or expanding live provider behavior |
| Tax gates | Tax readiness evidence and `TAX_PROVIDER_BACKED_QUOTES_REQUIRED` posture | No for unrelated routine deploys | Yes for public checkout and tax-affecting changes |
| Feature rollout gates | rollout percentage, allowlist, opt-out, kill switch | No | Yes |
| Emergency recovery gates | release lock bypass, emergency reference, rollback owner | Only during lock or emergency | Yes |

Examples:

- Docs-only change: no deployable release; no staging or production promotion.
- UI copy change in deployable web code: normal PR, staging, production smoke, then deploy; launch evidence is not refreshed unless the copy changes public marketplace launch claims.
- Payment provider behavior change: normal deploy health gates plus Payments-owned provider evidence when live-money behavior changes.
- Tax launch posture change: Tax readiness evidence must be current before public checkout exposure expands.
- Emergency revert: release lock may be bypassed only with `emergency_release=true` and a concrete `emergency_reference`; deploy and smoke still record a production marker.

`scripts/change-scope.mjs` classifies exposure-posture changes and emits:

- `exposure_posture_changed`
- `exposure_posture_categories`
- `exposure_posture_categories_json`

Current categories are:

- `public-marketplace-launch`
- `live-money-provider`
- `tax-posture`
- `postage-provider`
- `transactional-email-provider`
- `ucp-signed-write`
- `rollout-policy`

These categories annotate release-health first. They should be used to require targeted evidence before capability exposure changes, while routine deploy health gates continue to protect every deployable release.

Production release-health records include a typed `gates[]` list so operators can distinguish rollout blockers from evidence that should remain visible without forcing unnecessary restore-point forks or rollbacks:

| Severity | Meaning | Promotion behavior |
| --- | --- | --- |
| `blocking` | Canonical-state, money movement, provider idempotency, destructive schema, rollback-unsafe, smoke, or marker safety. | Must pass before production promotion or recovery can complete, unless an audited emergency path explicitly bypasses the named control. |
| `advisory` | Projection freshness, routine PITR recovery posture, or telemetry that informs rollout while source-of-truth safety is intact. | Recorded in release-health and the review report; does not by itself create a restore point or block unrelated deploys. |
| `deferred-proof` | Launch, provider, tax, rollout, or capability-expansion evidence owned outside the routine deploy path. | Blocks capability enablement or expansion when the posture changes; routine deploys may continue when the posture is unchanged. |
| `not-applicable` | Gate is skipped because the release is non-deployable or the protected capability is not in scope. | Recorded as skipped for audit clarity. |

Every gate row includes `id`, `phase`, `owner`, `severity`, `status`, and `reason`. `gateSummary.blockingFailures` identifies production-stopping failures, `gateSummary.advisoryWarnings` identifies visible non-blocking warnings, and `gateSummary.deferredProof` identifies capability-proof rows to review before expanding exposure.

## Rollback And Fix-Forward Readiness

Rollback automation is intentionally advisory first. Operators can validate a recovery target without deploying it:

```powershell
pnpm run rollback:readiness -- --mode rollback --target-commit <40-char-sha> --release-tag <release-tag> --image-ref <registry-image> --image-exists true --smoke-verified true --emergency-reference <incident-or-evidence>
```

The `Platform Rollback Readiness` workflow performs the same validation from GitHub Actions against the production environment. It checks that:

- the target commit is reachable from the smoke-verified `production` marker
- the release tag points to the target commit
- the production image exists in DOCR
- the target has smoke-verified production evidence
- an emergency reference is present
- destructive Terraform changes are explicitly approved before recovery proceeds

The readiness output is a `rollback-readiness/v1` artifact. A passing readiness record does not deploy anything by itself; it gives the incident owner a concrete rollback or fix-forward target and blocker list.

## Current Deferred Work

The repository now contains the release-lock check, release-lock command generator, deterministic rollout evaluator, release-health report generator, merge-queue-enabled PR validation, and production release-health artifact emission with GitHub API-backed queue, staging, production, canary, and drift timing. All of this lives in CI (`.github/workflows`), `scripts/`, and `infrastructure/`; the application does not host release dashboards, release controls, or rollout-policy surfaces. The next implementation steps are:

- tune merge queue batch size only after at least 10 deployable release-health records meet the SLO posture in this runbook
