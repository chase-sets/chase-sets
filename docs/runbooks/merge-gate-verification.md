# Merge-Gate Verification

`Platform Merge Gate Verification` (issue #5838, epic #5496) is the cancellation-safe merge-gate verification environment: it deploys ONE exact immutable image digest to a uniquely labeled `chase-sets-gate-<run>-<attempt>` namespace on the staging DOKS cluster, provisions disposable in-cluster Postgres, loads representative commerce state, runs platform and Stripe test-mode smoke (delivered webhooks required), persists a durable `release-qualification/v1` record, and guarantees teardown on success, failure, timeout, and cancellation. It never connects to persistent staging or production databases, is not a required check, and never validates migrations against long-lived state.

- Workflow: `.github/workflows/platform-merge-gate-verification.yml` (reusable via `workflow_call`; manual `workflow_dispatch`)
- Lifecycle support and preflight: `scripts/merge-gate-verification.mjs` + `scripts/merge-gate-verification-config.json`
- Namespace contract (shared parser, gate kind): `scripts/ephemeral-verification-namespace.mjs`
- Scheduled backstop: gate sweep jobs in `.github/workflows/platform-preview-cleanup.yml`
- Durable evidence: [Release Qualification Evidence](./release-qualification-evidence.md)

## Terminal paths and their deleters

| Terminal path | Deleter |
| --- | --- |
| Success | `Delete gate provider webhooks` + `Delete gate Kubernetes namespace` (`if: always()`) plus absence probe |
| Failure (any step) | Same `always()` finalizers; `teardown` throws if the namespace survives |
| Cancellation | Job-level `always()` keeps the finalizers reachable through cancel (#5830 pattern) |
| Timeout | Job `timeout-minutes` cancels the job; same `always()` finalizers run |
| Runner loss | Nothing on the runner can run; the scheduled gate sweep deletes at the cleanup deadline |
| Preflight skip | Preflight fails before ANY provider mutation; nothing exists to delete |

The namespace is created atomically with its labels and annotations (repository, run id/attempt, candidate SHA/tree, image digest, creation time, cleanup deadline), so the label-scoped sweeper has no create-then-label gap.

## Manual dispatch

1. Actions → `Platform Merge Gate Verification` → Run workflow.
2. `image_digest`: the immutable `sha256:` digest to qualify (from a merge-group image push or `docker buildx imagetools inspect`). Leave empty to resolve the candidate's boot-smoked `tree-<treesha>` tag and pin its digest.
3. `candidate_ref`: commit or ref being qualified (defaults to `main`). The representative-state guard accepts gate namespaces only for images built at or after #5838, so qualify candidates that contain this change.
4. Evidence: the `merge-gate-verification-*` artifact (redacted run record, preflight record, representative-state evidence) plus the absence probe in the `Probe gate namespace absence` step log.

## Safe rerun

Rerunning a run reuses the run id with a new attempt, so the namespace (`chase-sets-gate-<run>-<attempt>`) and Helm release (`csg-<run>-<attempt>`) are always fresh; `kubectl create` refuses to adopt an existing namespace. Never rerun to "resume" a partially torn-down namespace — foreground teardown or the sweep must finish first (they are idempotent; a rerun is always safe after either completes).

## Cleanup escalation and orphan SLO

Orphan SLO: no gate resource lives longer than 6 hours. Namespaces carry a 2-hour cleanup deadline; the gate sweep runs every 3 hours (plus the daily full sweep), so worst-case orphan age stays inside the SLO even after runner loss.

1. If a run's teardown step failed, the run is red — check the step log; teardown throws rather than reporting green on a surviving namespace (#4778 lesson).
2. The sweep (`Discover Stale Gate Namespaces` → `Destroy Stale Gate Namespace` in Platform Preview Cleanup) selects by strict label (`chasesets.com/purpose=merge-gate-verification`) plus bounded naming and past cleanup deadline. It reports scanned/eligible/refused/deleted/failed totals per run.
3. Refused entries (gate-named but unlabeled/foreign) are never auto-deleted: a foreign `chase-sets-gate-*` namespace should not exist — investigate before deleting anything by hand.
4. Manual escalation (only after both mechanisms failed): `pnpm run platform:kubernetes-deployment -- teardown --namespace chase-sets-gate-<run>-<attempt> --release csg-<run>-<attempt> --timeout 5m` against the staging kubeconfig. Never delete namespaces outside the strict gate/verify/pr shapes.

## Credentials and rotation

All secrets are environment-scoped to the `merge-gate` GitHub environment and validated by the fail-before-mutation credential matrix (any missing name fails before a provider call; the Stripe key must be test-mode). Exact names as the workflow references them:

`DIGITALOCEAN_ACCESS_TOKEN`, `SPACES_ACCESS_ID`, `SPACES_SECRET_KEY`, `RELEASE_EVIDENCE_SPACES_ACCESS_ID`, `RELEASE_EVIDENCE_SPACES_SECRET_KEY`, `STRIPE_SECRET_KEY` (test-mode), `STRIPE_PUBLISHABLE_KEY` (test-mode), `EASYPOST_API_KEY` (test-mode), `PLATFORM_INTERNAL_AUTH_SECRET`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `CHASE_SETS_DISCORD_INVITE_URL`. Optional: `UCP_*`, `VOYAGE_API_KEY`, `GOOGLE_SOCIAL_LOGIN_*`, `FACEBOOK_SOCIAL_LOGIN_*`. Variables: `MERGE_GATE_DOKS_CLUSTER` (defaults to `chase-sets-staging-doks`), `STRIPE_CONNECT_ACCOUNTS_API`, `STRIPE_API_BASE_URL`, `EASYPOST_API_BASE_URL`, `EASYPOST_MODE`.

Rotation: rotate each credential at its source (DigitalOcean API/Spaces keys, Stripe test keys, EasyPost test key) and update the `merge-gate` environment copy; the dedicated evidence key rotation procedure lives in [Release Qualification Evidence](./release-qualification-evidence.md). After rotating, dispatch a manual gate run — the credential matrix plus smoke is the rotation proof. The `merge-gate` environment has NO required-reviewer protection (a human approval would deadlock a required merge-queue check); only branch restrictions and scoped secrets apply.

## Capacity limits and cost wager

Preflight fails before provisioning when headroom is insufficient or unknown: available preview-pool capacity (live node allocatable extended by the autoscaler ceiling, minus every live pod request including `chase-sets-pr-*` previews) must cover 1.5× the configured merge-queue concurrency's per-run footprint. `scripts/merge-gate-verification-config.json` is the checked-in wager: unknown cost or a missing/expired `costWager.expiresAt` (or one more than 30 days out) fails preflight, and any capacity exception must itself declare owner, dollar ceiling, and a ≤30-day expiry. No permanent capacity increase is authorized by #5838.

The 10-run proof: each run writes a `merge-gate-verification-run/v1` record (phase timings, preflight+cleanup overhead vs the 2-minute budget, compute requests, observed utilization, provider calls, Actions minutes, estimated incremental cost). Aggregate with:

```sh
node scripts/merge-gate-verification.mjs proof --out proof.json record1.json ... record10.json
```

`status: pass` requires ten successful non-drill runs with p95 preflight+cleanup overhead within 2 minutes.

## Drills

- `drill: induced-failure` — fails immediately after namespace creation; proves failure-path foreground cleanup.
- Cancellation drill — dispatch normally, cancel from the UI after `Create gate namespace`; the `always()` finalizers still tear down.
- `drill: stranded-fixture` — creates a labeled gate namespace with an already-past deadline and deliberately skips foreground cleanup; the next scheduled sweep must delete it (backstop proof).
- `drill: withheld-credential` — withholds the Stripe secret; the run must fail in the credential matrix before any provider mutation.
