# Release Process Evolution

This runbook defines the Chase Sets release model that evolves the current GitHub Actions and DigitalOcean deployment process toward smaller, safer, observable releases.

The operating goals are:

- `main` stays green and close to the smoke-verified `production` marker.
- Production deploys stay automatic for routine deployable changes after required checks pass.
- Launch, live-money, provider, and tax gates block only the capability exposure they protect.
- Operators can lock production promotion during incidents and use one audited emergency path for fix-forward or revert.
- Capability exposure moves from broad environment switches toward deterministic account-level rollout controls and canary analysis.

## Release Queue Policy

Use GitHub native merge queue as the default queue implementation for `main`. Do not build custom `/shipit` tooling unless native merge queue cannot enforce the policy below.

Queue admission requires:

- pull request approval according to repository rules
- a successful `PR Required` check from `.github/workflows/platform-pr.yml`
- no unresolved destructive production infrastructure approval questions
- current branch state rebased or mergeable through the queue's synthetic merge group
- no active production release lock unless the pull request is the audited emergency release

Queue behavior:

- Start with a maximum batch size of one deployable pull request per merge group.
- Documentation-only and non-deployable changes may batch when the merge queue can still prove `PR Required`.
- Increase batch size only when release-health metrics show low staging failure, low production smoke failure, low rollback/fix-forward rate, low canary abort rate, low queue wait, and low main-to-production drift.
- Keep stale release behavior from the deployment workflow: if a queued automatic deployment starts after a newer `origin/main` exists, skip that stale deployment and let the newest release proceed.
- Keep direct pushes disabled for normal work. Emergency release bypass must be explicit and audited.

Active GitHub native merge queue settings for `main`:

| Setting | Value |
| --- | --- |
| Merge method | `SQUASH` |
| Grouping strategy | `ALLGREEN` |
| Minimum pull requests to merge | `1` |
| Maximum pull requests to merge | `1` |
| Maximum pull requests to build | `1` |
| Required check | `PR Required` |
| Check response timeout | `60 minutes` |

`.github/workflows/platform-pr.yml` must run on `pull_request`, `merge_group`, and `push` to `main` so `PR Required` is evaluated for both pull request heads and merge queue synthetic commits.

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

## Release Locks

`PRODUCTION_RELEASE_LOCKED=true` pauses production promotion. The production deployment workflow evaluates the lock before production configuration validation, Terraform planning, or App Platform deployment.

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
pnpm run release-lock:commands -- --action lock --environment production --reason "Payment provider incident" --reference "INC-2026-05-31-001"
pnpm run release-lock:commands -- --action unlock --environment production
```

Operators can also prepare these commands in the admin console at `/platform/release-controls`. The console reads the current production lock variables, validates lock reason requirements, and produces the same `gh variable set` shape without mutating GitHub from the browser.

## Production Canary Path

Canary is an additional production phase after staging, not a staging replacement.

Phase 1 uses synthetic and operator-safe production probes after the production deployment smoke check and before the production marker is advanced:

- landing host HEAD probe
- admin host HEAD probe
- marketplace host HEAD probe only when public marketplace is enabled
- immutable release commit and production workflow run recorded in `release-health/v1`

This phase is intentionally not random public traffic splitting. A failure blocks the production marker and leaves the workflow evidence behind for fix-forward or rollback readiness.

Phase 1 can expand to operator/internal or account-allowlisted production traffic:

- production root/admin proof APIs already used for private provider proof
- production marketplace APIs guarded by account allowlists once marketplace is public
- synthetic production probes with tagged operator accounts

Phase 2 may add small deterministic cohorts for public marketplace accounts after release-health metrics, rollout guards, and canary-analysis signals are reliable.

Phase 3 may add random production traffic only when DigitalOcean routing, observability, and rollback mechanics prove that the traffic split is reversible and cheap to operate.

Canary promotion requires:

- the staging job deployed the same immutable commit image and passed smoke, critical-flow, and money-smoke gates
- the canary topology routes only the intended component or cohort
- the release-health record names the release commit, workflow run, canary start, canary end, and promotion decision
- canary analysis passes for the configured observation window
- no active release lock unless this is an emergency release

Abort canary by returning traffic to the last smoke-verified production release, disabling the rollout or kill-switching the capability, and preserving the canary health record for investigation.

## Automated Canary Analysis

Canary analysis compares canary signals to a recent stable baseline and fails closed during early rollout when data is missing or ambiguous.

Initial required signals:

| Signal | Owner | Data source | Current state | Early threshold |
| --- | --- | --- | --- | --- |
| App Platform deployment phase | Infrastructure / deployment workflow | DigitalOcean App Platform deployment phase | Available now | All canary components ready and deployment `ACTIVE`. |
| Route error rate | Platform runtime / owning route context | HTTP telemetry by route and host | Needs instrumentation | No sustained increase above baseline during observation. |
| Route latency p95 | Platform runtime / owning route context | HTTP latency histogram by route and host | Needs instrumentation | No sustained p95 increase above baseline for canary routes. |
| Worker health and durable job backlog | Platform Operations / infrastructure runtime | Worker heartbeat and durable job backlog telemetry | Needs instrumentation | No new sustained backlog or runner failure. |
| Projection lag and poison events | Owning bounded contexts / Platform Operations | Projection operation snapshots and poison-event telemetry | Available now | No new degraded projection group caused by the canary release. |
| Checkout/order/payment errors | Checkout, Ordering, Payments | Checkout, order, payment, and provider-health telemetry | Needs instrumentation | No increase in command failures or provider-health failures. |
| Settlement/payout errors | Settlement | Settlement operation telemetry for payout setup, readiness, and provider reconciliation | Available now | No increase in payout setup session failures, payout readiness refresh failures, setup-blocked payout requests, or provider reconciliation failures. |
| Fulfillment/postage callback errors | Fulfillment | Postage provider callback telemetry | Needs instrumentation | No new provider callback signature, parse, or reconciliation failures. |
| Transactional email callback errors | Notifications | SES/SNS callback and outbox telemetry | Needs instrumentation | No new SES/SNS callback or outbox delivery failure spike. |
| Database pool pressure | Infrastructure runtime | Database pool and migration telemetry | Needs instrumentation | No connection exhaustion, pool saturation, or bootstrap migration pressure. |
| UCP discovery and signed-write health | UCP facade owners | UCP discovery and signed-write telemetry | Deferred | Discovery stays healthy and signed-write rejects do not spike when UCP is enabled. |

The first canary implementation may use smoke probes and workflow-collected health summaries while observability baselines mature. Automatic full promotion should wait until each required signal has an explicit data source and owner.

Evaluate a canary evidence file with:

```powershell
pnpm run canary:analysis -- --file .\artifacts\release-health\canary-analysis.json
```

Generate canary evidence from telemetry snapshots with:

```powershell
pnpm run canary:evidence -- --release-commit <40-char-sha> --observation-window-seconds 300 --source-file .\artifacts\release-health\telemetry.json --out .\artifacts\release-health\canary-analysis.json
```

Generate canary evidence from production Prometheus snapshots with:

```powershell
pnpm run canary:evidence -- --release-commit <40-char-sha> --observation-window-seconds 300 --prometheus-base-url https://<prometheus-host> --prometheus-query-file .\bounded-contexts\platform-operations\features\release-dashboard\read-model\canary-prometheus-queries.json --out .\artifacts\release-health\canary-analysis.json
```

The production deployment workflow runs the same collector before advancing the `production` marker when `CANARY_PROMETHEUS_URL` and `CANARY_PROMETHEUS_QUERY_FILE` repository variables are configured. The query file maps canary signal names to `baselineQuery`, `canaryQuery`, `owner`, and `maxIncrease`. Keep the workflow variables unset until production telemetry sources exist for every required signal that should gate promotion.

The collector writes `schemaVersion: "canary-analysis/v1"`, a concrete `releaseCommit`, an `observationWindowSeconds`, and a `signals` array. Each signal includes `name`, `owner`, `source`, `currentState`, and either `status: "pass"` or numeric `baseline`, `canary`, and `maxIncrease` values. Required signals fail closed when telemetry is missing or above threshold; optional signals set `required: false`. Unsupported sources must be recorded as `status: "missing"`, never as pass.

The Platform Operations-owned Prometheus query contract is `bounded-contexts/platform-operations/features/release-dashboard/read-model/canary-prometheus-queries.json`. Do not point `CANARY_PROMETHEUS_QUERY_FILE` at a different path unless the replacement includes the same owner, source, baseline query, canary query, and threshold metadata for every required signal.

Canary ownership starts with this matrix:

| Signal | Owner | Source | Failure action |
| --- | --- | --- | --- |
| `app-platform-deployment-phase` | `infrastructure/deployment-workflow` | DigitalOcean App Platform deployment phase gauge | Abort promotion and inspect the App Platform deployment. |
| `route-error-rate` | `platform-runtime/route-owner` | HTTP 5xx rate by route, host, and release cohort | Abort promotion and compare route-level errors against the stable cohort. |
| `route-latency-p95` | `platform-runtime/route-owner` | HTTP latency histogram by route, host, and release cohort | Hold promotion until latency source and threshold are understood. |
| `checkout-order-payment-errors` | `checkout/ordering/payments` | Checkout command, order, payment, and provider-health counters | Abort promotion and page the owning bounded context before exposing traffic. |
| `settlement-payout-errors` | `settlement` | `chase_sets_settlement_operations_total` filtered to payout setup/session/readiness/reconciliation failure kinds | Abort promotion, inspect Payout Operations, and keep the release canary at the current cohort until setup and payout readiness are stable. |

Signals whose `currentState` is `needs-instrumentation` must remain unset in production gating until telemetry is live. They can appear in dry-run canary evidence, but they must fail closed or stay optional; they must not silently pass.

## Release Health Metrics

Every deployable release attempt should produce a structured release-health record keyed by release commit and workflow run. Production releases write `production-release.json`; staging failures, cancellations, and stale automatic skips write `staging-release.json` before production starts.

PRs get a lightweight Release Status summary after `PR Required` evaluates. The summary explains whether the change is deployable, whether preview was required, whether exposure posture changed, and whether GitHub merge queue is ready. This is informational only; GitHub native merge queue remains the admission and ordering mechanism.

Minimum schema:

```json
{
  "schemaVersion": "release-health/v1",
  "releaseCommit": "<40-char-sha>",
  "workflowRunId": "<github-run-id>",
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

Release-health metadata is resolved from GitHub API evidence. The production workflow records the pull request open time, ready-for-review time, last approval time, merge queue entry time, merge-group workflow start time, merge time, dequeue failure when present, and final merge SHA. If GitHub metadata is temporarily unavailable, the workflow writes deterministic fallbacks and leaves unknown fields empty rather than blocking production recovery.

Staging abort records are release evidence, not production releases. Treat `attempt.phase: "staging"` with `attempt.result: "failure"` or `"cancelled"` as an abort that must be reviewed before queue tuning. Treat `attempt.reason: "staging-not-deployed"` as a stale skip; it should not count as a production failure, but repeated stale skips are a signal that deployment cadence and queue latency need review.

CI retry posture is resolved from GitHub Actions workflow runs for the release commit. `run_attempt > 1` contributes to `ci.retryCount`; retried runs that eventually pass contribute to `ci.flakyFailureCount`. The release-health report lists the top flaky workflow names and blocks batch-size increase when CI retry/flake rate is unhealthy.

Build a Markdown dashboard from release-health artifacts with:

```powershell
pnpm run release-health:report -- --dir .\artifacts\release-health --out .\artifacts\release-health\summary.md
```

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

The same report includes a release process review checklist and image group decision inputs. Keep the shared platform image unless release-health data repeatedly shows that one deployable boundary causes disproportionate queue wait, staging duration, production duration, rollback cost, or operator recovery effort. A split image group must come with its own owner, dashboard, production marker, rollback path, and release-health gate before it reduces risk.

Operators can inspect the current read-only release dashboard in the admin console at `/platform/release-dashboard`. The dashboard combines release-lock state, `main` and `production` marker SHAs, latest PR/deploy result fields, latest release-health summary, canary decision, and links to GitHub runs or the production marker. The server runtime reads GitHub refs and workflow runs when `GITHUB_TOKEN` or `RELEASE_DASHBOARD_GITHUB_TOKEN` is available, and falls back to explicit `RELEASE_DASHBOARD_*` environment values and release-health JSON when GitHub is unavailable.

## Feature Rollout Controls

Platform Operations owns feature rollout language and deterministic evaluation rules. Bounded contexts keep owning business behavior and call rollout checks only as exposure guards.

Supported primitives:

- Feature Rollout: named capability policy evaluated by environment and subject
- Rollout Subject: account, membership, operator, or anonymous identity
- Account Allowlist: enable a subject outside the percentage cohort
- Account Opt-Out: disable a subject inside the percentage cohort
- Percentage Rollout: deterministic cohort from 0 to 100
- Kill Switch: disable the feature for every subject

Operators can evaluate a candidate policy and subject in the admin console at `/platform/release-controls`. The console keeps the command-builder path for GitHub Environment release locks, and the Platform Operations API now persists application-level release-control policy events.

Policy API:

- `GET /api/platform/release-controls` lists the active release lock and rollout policies.
- `POST /api/platform/release-controls/release-lock` changes the audited application release lock. Enabling a lock requires `reason`; clearing an active lock requires a concrete `reference`.
- `PUT /api/platform/release-controls/rollouts/:featureKey` changes a rollout policy for one environment. Every change requires `reason` and `reference`.
- `GET /api/platform/release-controls/rollouts/:featureKey/decision` evaluates a single subject decision. Non-platform operators can only read decisions for their own account or operator subject.

Example Stage 2 canary policy for the first guarded capability:

```powershell
$body = @{
  environment = "production"
  percentage = 0
  allowSubjects = @("account:acc_canary")
  optOutSubjects = @()
  killSwitchActive = $false
  reason = "Stage 2 account canary for pricing.account-repricing"
  reference = "https://github.com/todd-skelton/chase-sets/pull/<pr>"
} | ConvertTo-Json

Invoke-RestMethod -Method Put -Uri "https://<platform-api>/api/platform/release-controls/rollouts/pricing.account-repricing" -ContentType "application/json" -Body $body
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

Abort an account canary by setting `killSwitchActive=true` for the feature policy. Remove a canary subject by deleting it from `allowSubjects`; opt-out a subject with `optOutSubjects` when the percentage cohort would otherwise include them. Do not expand `percentage` above `0` until release-health and canary-analysis evidence is green for the allowlisted account cohort.

Generate deterministic account canary evidence before any percentage rollout:

```powershell
pnpm run account-canary:evidence -- --policy-file .\artifacts\release-health\feature-policy.json --feature-key marketplace.public-seller-proof --release-commit <40-char-sha> --account account:acct_canary --out .\artifacts\release-health\account-canary.json
```

The account canary evidence requires:

- every canary subject is an `account:<id>` subject
- every canary subject is explicitly allowlisted
- `percentage` remains `0`
- `killSwitchActive` is false
- no canary subject is in `optOutSubjects`

The output includes `releaseHealth.canaryCohortSubjectType`, `releaseHealth.canaryCohortSize`, and `releaseHealth.canaryPromotionDecision` so the same cohort and decision can be copied into the release-health artifact. Any blocker returns `promotionDecision: "abort"` and should be handled with the kill switch or allowlist/opt-out policy before exposing more traffic.

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

The repository now contains the release-lock check, release-lock command generator, deterministic rollout evaluator, audited Platform Operations release-control policy API, the first Pricing rollout guard, operator release-controls console, release dashboard, canary-analysis gate, telemetry-backed canary evidence collector with optional Prometheus input, release-health report generator, merge-queue-enabled PR validation, and production release-health artifact emission with GitHub API-backed queue, staging, production, canary, and drift timing. The next implementation steps are:

- configure production Prometheus canary query files after every required signal has stable telemetry and an owner-approved threshold
- tune merge queue batch size only after at least 10 deployable release-health records meet the SLO posture in this runbook
