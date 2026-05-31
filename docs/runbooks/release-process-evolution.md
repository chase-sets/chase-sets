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

Current repository evidence from May 31, 2026:

- `main` has branch protection with strict required status checks, `PR Required`, required conversation resolution, required linear history, and admin enforcement.
- Repository rulesets currently include `Protect production deployed marker` for `refs/heads/production`, blocking deletion and non-fast-forward updates.
- Native merge queue is not yet visible in the current branch protection or repository ruleset evidence. Enable it for `main` before increasing release batch size beyond one.
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

Operators can also prepare these commands in the admin console at `/operations/release-controls`. The console reads the current production lock variables, validates lock reason requirements, and produces the same `gh variable set` shape without mutating GitHub from the browser.

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

| Signal | Owner | Early threshold |
| --- | --- | --- |
| Component readiness and App Platform deployment phase | Infrastructure / deployment workflow | All canary components ready and deployment `ACTIVE`. |
| Public/admin/marketplace route error rate | Platform runtime / owning route context | No sustained increase above baseline during observation. |
| Route latency | Platform runtime / owning route context | No sustained p95 increase above baseline for canary routes. |
| Worker health and durable job backlog | Platform Operations / infrastructure runtime | No new sustained backlog or runner failure. |
| Projection lag and poison events | Owning bounded contexts / Platform Operations | No new degraded projection group caused by the canary release. |
| Checkout/order/payment errors | Checkout, Ordering, Payments | No increase in command failures or provider-health failures. |
| Settlement/payout errors | Settlement | No increase in payout setup, payout readiness, or provider reconciliation failures. |
| Fulfillment/postage callback errors | Fulfillment | No new provider callback signature, parse, or reconciliation failures. |
| Transactional email callback errors | Notifications | No new SES/SNS callback or outbox delivery failure spike. |
| Database pool pressure | Infrastructure runtime | No connection exhaustion, pool saturation, or bootstrap migration pressure. |
| UCP discovery and signed-write health | UCP facade owners | Discovery stays healthy and signed-write rejects do not spike when UCP is enabled. |

The first canary implementation may use smoke probes and workflow-collected health summaries while observability baselines mature. Automatic full promotion should wait until each required signal has an explicit data source and owner.

Evaluate a canary evidence file with:

```powershell
pnpm run canary:analysis -- --file .\artifacts\release-health\canary-analysis.json
```

The input file uses `schemaVersion: "canary-analysis/v1"`, a concrete `releaseCommit`, an `observationWindowSeconds`, and a `signals` array. Each signal needs `name`, `owner`, and either `status: "pass"` or numeric `baseline`, `canary`, and `maxIncrease` values. Required signals fail closed when missing or above threshold; optional signals set `required: false`.

## Release Health Metrics

Every deployable release should produce a structured release-health record keyed by release commit and workflow run.

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

Increase deployable batch size only when all thresholds pass and there are at least 10 recent deployable release records. If any threshold fails, decrease or hold batch size until the cause is understood.

## Feature Rollout Controls

Platform Operations owns feature rollout language and deterministic evaluation rules. Bounded contexts keep owning business behavior and call rollout checks only as exposure guards.

Supported primitives:

- Feature Rollout: named capability policy evaluated by environment and subject
- Rollout Subject: account, membership, operator, or anonymous identity
- Account Allowlist: enable a subject outside the percentage cohort
- Account Opt-Out: disable a subject inside the percentage cohort
- Percentage Rollout: deterministic cohort from 0 to 100
- Kill Switch: disable the feature for every subject

Operators can evaluate a candidate policy and subject in the admin console at `/operations/release-controls`. The console is intentionally deterministic and read-only: it shows the policy decision, reason, and bucket before a context wires the same policy into a capability guard.

Evaluation order:

1. Kill switch disables the feature for every subject.
2. Account opt-out disables the feature for that subject.
3. Account allowlist enables the feature for that subject.
4. Percentage rollout enables the feature when the deterministic subject bucket is below the percentage.
5. Otherwise the feature remains disabled.

Percentage cohorts must be deterministic and monotonic. Increasing from 10% to 20% keeps the first 10% enabled and only adds subjects.

Initial candidate guarded capabilities:

- production marketplace public checkout by account cohort after launch
- UCP/AP2 agentic write capabilities by account or operator cohort
- live payout actions by operator-controlled seller accounts
- postage provider label purchase by operator-controlled accounts
- pricing recommendation apply flows by account cohort

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

The repository now contains the release-lock check, release-lock command generator, deterministic rollout evaluator, operator release-controls console, canary-analysis gate, release-health report generator, and production release-health artifact emission with queue, staging, production, and drift timing. The next implementation steps are:

- configure GitHub native merge queue for `main` with the policy above
- persist PR review/ready timestamps from GitHub API once merge queue is enabled
- replace Stage 1 synthetic canary with telemetry-backed canary evidence once observability data sources are ready
- persist release-lock and rollout policy changes through an audited Platform Operations API instead of command generation once the policy store is introduced
