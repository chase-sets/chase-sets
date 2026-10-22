# DOKS Platform Operations

This runbook is the current runtime-compute operating guide for staging and production.

## State And Names

| Item | Value |
| --- | --- |
| Helm release | `chase-sets-platform` |
| Namespace | `chase-sets-platform` |
| Ingress controller | `ingress-nginx` |
| Runtime secret | `chase-sets-platform-runtime` |
| Bootstrap hook | `platform-bootstrap` |

Use the environment-specific kubeconfig output from the DOKS Terraform root. Never reuse staging credentials for production.

## Runtime XL Node Pool

Staging has a separate `runtime-xl` node pool for migrations that need more memory than the default pool. It is untainted, so ordinary platform workloads can schedule there while the pool is enabled. Before removing or resizing it, cordon and drain its nodes, confirm every workload is ready on the default pool, and then apply the Terraform change. Terraform intentionally does not automate this drain because eviction timing and disruption evidence require an operator decision.

## Preview Node Pool

PR previews use the staging cluster's dedicated preview pool. Nodes carry the `chase-sets.com/preview-only=true:NoSchedule` taint, and preview workloads supply the matching toleration plus the `chase-sets.com/pool=preview` nodeSelector. The pool uses `min_nodes = 0`, so it scales to zero when no preview pods are pending. Staging runtime workloads must never tolerate the preview-only taint.

### Idle Draft Retirement (#9964)

Every live preview reserves pool memory until its namespace is deleted, so an idle draft preview holds a pool slot. `Platform Preview Cleanup` retires idle drafts; open non-draft previews are never retired because reviewers may use their URLs.

- **Idle draft (D1).** A `chase-sets-pr-<n>` namespace is an idle draft when PR n is open and draft and the namespace `creationTimestamp` is at least 24h old. Every PR deploy deletes and recreates the namespace, so that timestamp is the last deploy. Retiring loses only the browsable URL; the next push rebuilds the preview.
- **Selection (D2).** `node ./scripts/digitalocean-preview-cleanup-sweep.mjs discover-idle-drafts` lists namespaces once (`kubectl get namespaces -o json --request-timeout=60s`) and open PRs once (`GET /repos/{repo}/pulls?state=open&per_page=100`, every page until one returns fewer than 100 items, 30 s per request). Any failed, malformed or unbounded listing fails closed: nothing is dispatched and the record's `result` is `failure`. Each namespace gets one decision: `idle-draft`, `recent-draft`, `open-ready`, or `not-open`; `not-open` is left to the closed-PR sweep. A run selects at most 10 idle drafts, oldest first, and records the rest as `deferred`. The record is `platform-preview-idle-drafts/v1`, uploaded as the `platform-preview-idle-drafts-<run>-<attempt>` artifact.
- **Scheduled job (D3).** `retire-idle-draft-previews` runs on both schedules, `17 10 * * *` and `47 */3 * * *`, in the `preview` environment. It is the only job with `actions: write`. For each selected PR it dispatches the existing per-PR destroy path with `idle_draft_recheck=true`. With the 3-hour cadence, an idle draft holds its slot for at most about 27h after its last deploy. It does not depend on the daily `Discover Preview Cleanup` job.
- **Re-check (D4).** With `idle_draft_recheck` true, `Discover Preview Cleanup` runs `discover-idle-drafts --pr-number <n>`. It emits the single-PR matrix only if D1 still holds; otherwise `target_count=0` and the step log and re-check artifact give the reason. The matrix drives the unchanged `destroy-preview` job. Dispatched runs never dispatch again. With the input false (the default), manual dispatch destroys PR n unconditionally, as before.
- **Remaining race (D5).** The deploy concurrency group `platform-pr-<n>` and the destroy group `platform-preview-pr-<n>` differ. A push that lands between the re-check and the teardown can lose its fresh namespace and fail once; a rerun or the next push recovers.

Re-check and retire one PR by hand (destroys only if it is still an idle draft):

```sh
gh workflow run platform-preview-cleanup.yml --ref main -f pr_number=<n> -f idle_draft_recheck=true
```

## Deploy And Status

Routine deploys run through Platform Deploy. For local read-only inspection:

```bash
helm status chase-sets-platform --namespace chase-sets-platform
kubectl --namespace chase-sets-platform get deployments,rollouts,pods,ingress
kubectl --namespace chase-sets-platform get events --sort-by=.lastTimestamp
```

The deploy helper renders the checked-in runtime contract, applies the environment Secret, runs the Helm upgrade, waits for bootstrap and workload readiness, verifies ingress, and emits release-health evidence. Do not hand-edit generated values or live Deployments.

### Admission-Webhook Transient Retry (#9662)

The DOKS control plane can briefly lose its konnectivity bridge to an admission webhook in the middle of a production `helm upgrade --atomic`. Helm then reports `UPGRADE FAILED` with a Certificate patch whose `webhook.cert-manager.io` call ends `No agent available`, and its atomic rollback usually fails the same way. Production retries that one cause once, in the same job:

1. The production deploy step always writes `artifacts/release-health/production-kubernetes-deploy-attempts.json` (`platform-kubernetes-deploy-attempts/v1`). The record holds one terminal result, the attempts, the probe outcomes, the recovery revisions, and the history observed before the retry. That history keeps each revision's number and status and only a SHA-256 fingerprint of its Helm description, because a retained description can carry earlier error text. The record's only text is Helm's bounded, redacted `UPGRADE FAILED` line, at most 500 characters. A failed attempt whose complete original error was recognized also carries `admissionWebhookTransientCode: doks-admission-webhook-unreachable`; every other attempt carries neither the line nor the code. The record never carries Helm arguments, values, runtime env overrides, or history descriptions.
2. The retry is offered only when the workflow rollback itself would run: rollback readiness is `success` and `agent-grant-revocation-release.mjs check-rollback` passes for the last-known-good commit. Staging and previews never retry.
3. The retry is refused, and the original error stands, for any other error and for any unexpected Helm history: a pending revision, an extra or different revision, a missing source, an interior gap, or a changed retained revision. Helm's history limit may prune only the oldest revisions before the captured source.
4. The deploy runs `kubectl annotate certificate/chase-sets-platform-doks-tls --dry-run=server` in the deploy namespace every 10 seconds. It needs two consecutive successes inside one fixed 180-second window. A probe still running when the window ends is killed and counts as a timeout.
5. The deploy restores the captured source with the exact workflow rollback, unless Helm's atomic rollback already left a deployed `Rollback to <source>`. It confirms that no Helm hook operation is active, then runs the byte-identical upgrade, `--atomic` included, exactly once.

After a recovered retry, `verify-deployment-transition --deploy-attempts` checks the whole chain from the original rollback target. It rebuilds each recorded description from the observed Helm history, or from the rollback target for a revision pruned since, and refuses any whose fingerprint differs. It then emits the ordinary transition for the final hop, from the recorded pre-retry head to the new deployed revision, so marker recovery is unchanged.

If both attempts fail with this transient, or the transient retry was refused, the incident is classified `doks-admission-webhook-unreachable`. The classifier reads the last attempt's recorded code, not its line, because the 500-character line can end before `No agent available`. A retry that fails with any other error, or that succeeds, does not get this classification. The workflow rollback restores the captured source as for any production failure. Confirm that the cert-manager webhook answers the same server dry-run from the production context, then rerun the failed Platform Deploy run. Never raise the timeout or bypass `--atomic` to get past this failure.

### Agent Grant Revocation Activation (#10235)

Agent Grant revocation support ships dormant. The Platform Deploy input `agent_grant_revocation_activation` selects which deploy job activates it:

- `none` (default): both jobs deploy normally.
- `staging`: staging activates after its release passes every staging gate. Production then deploys normally, or fails at its release lock.
- `production`: production activates after the production marker and promoted handoff. Staging only prepares.

Activation needs a deploy. When the target commit is already serving, dispatch with `force_deploy=true` and `emergency_release=false`. Never use `emergency_release` for an activation. `resolve-release` refuses with `revocation_activation_not_deployed` when the deploy scope is empty. An automatic release that would be coalesced refuses with the same code.

Every staging and production deploy runs `agent-grant-revocation-release.mjs prepare` before its Helm upgrade. While the environment is dormant, `prepare` changes nothing except to remove a fence left by an unfinished activation. After activation it appends the new image digest to the admission floor, and it refuses any release that does not descend from the floor's minimum commit. Production also runs `check-rollback` before the admission retry, the Argo abort and the workflow rollback. Staging has no captured rollback commit. Its Argo abort and Helm `--atomic` rollback therefore rely on the admission floor alone, and the floor admits only its listed digests. The operator rollback workflows also skip `check-rollback`: the staging rollback drill, staging Helm recovery and production stale-Helm recovery. After activation, give them a target revision that was deployed after activation, because the floor denies the pods of an older one.

The activation step runs `activate` twice at the same commit and digest:

1. The first call freezes admission, captures every serving API and worker pod, and appends the activation once.
2. The second call is an in-run replay. It writes `{"replay": true}` and reinstalls the unfrozen floor, and it appends no event.

A refusal prints one `revocation_*` code and fails the run. It never aborts or rolls back the healthy release. The incident is classified `agent-grant-revocation-activation-refused`. A real deploy failure before activation keeps the floor-checked abort and rollback.

Each `prepare` and `activate` writes a post-command status record. The deploy job uploads the records as the `agent-grant-revocation-status-<environment>` artifact. When activation ran, the artifact also holds `activation.json` and `replay.json`. Each record contains:

- the refusal code, if any;
- the floor's minimum commit, its image digests and its frozen flag;
- Identity's state, the activation event's identity and version, and the nonterminal count and oldest age;
- a summary of the last 5 minutes of API and worker logs, read with `kubectl logs --since=5m --tail=200` for each pod. The summary keeps line counts, truncation, error counts, and the first and last `auth.agent-grant-revocation-recovery` cycle. It never keeps raw log lines.

Identity reads its status in a read-only transaction and never calls `pending()`. The oldest age runs from the admission of the lowest-position nonterminal operation. When recovery has not adopted that operation yet, it runs from activation instead. A lease rewrite of `next_attempt_at` never resets it. Any section that cannot be read is recorded as `state: unknown` with a code. An unknown section, a truncated log, or an unobserved recovery cycle is never a pass.

For the day-after check, read `prepare-status.json` from the first routine deploy at least 24 hours after activation. It passes only when all of these hold:

- the nonterminal count is zero, or the oldest age is within one observed recovery cycle;
- the log summary is complete;
- the logs show no repeated recovery failures.

Recovery:

- **Refusal.** `revocation_membership_changed` means the serving set changed during capture. Dispatch again once, at a quiet moment. For any other code, report the code with the status artifact and do not retry until it is resolved.
- **Frozen fence.** If an activation lost its reply after Identity committed, the fence stays frozen and denies every runtime pod change while Identity reports `activated`. The next deploy's `prepare`, or a replay at the same release, reinstalls the unfrozen floor. If Identity reports `dormant`, `prepare`, `check-rollback` or the failed activation itself removes the fence.
- **Floor loss.** If the admission policy is deleted, `prepare` rebuilds it from Identity's activation proof, and `check-rollback` checks against the same rebuilt floor. The rebuilt floor keeps only the activation digest and the new digest, not intermediate digests (N18). An abort or rollback to an intermediate release can therefore be denied, so redeploy forward instead.
- **Ancestry.** `git merge-base --is-ancestor <floor minimum commit> <commit>` exits nonzero for any commit older than the activation commit. That commit is not a compatible rollback target.

The staging activation is the live rehearsal. Production activation is a separate host-run dispatch after the production release lock lifts. Passing tests are not evidence of a live activation.

## Managed Registry Pull Authority

DigitalOcean's DOKS/DOCR integration is the sole owner of platform image-pull credentials. It owns the source Secret in `kube-system`, reconciles a namespace-local Secret named `chase-sets`, and adds that name to each namespace's default ServiceAccount. GitHub Actions and the platform chart select the stable name `chase-sets`; they never generate, refresh, or select a parallel Docker-config Secret. DigitalOcean owns credential refresh and distribution timing. If that contract stops reconciling, fail closed and escalate to DigitalOcean support instead of creating a fallback credential or extending a credential TTL.

Chart-created ServiceAccounts do not inherit the namespace default ServiceAccount. The platform ServiceAccount, bootstrap-quiesce ServiceAccount, every private-image workload, and both quiescing and non-quiescing scenario-seed Jobs therefore carry `imagePullSecrets: [{name: chase-sets}]` explicitly. Public preview Postgres and observability images do not require DOCR authority.

Disposable preview, merge-gate, and ephemeral-verification workflows create their namespace first, then run `scripts/managed-registry-readiness.mjs` with a 120-second deadline. The named checks wait for both `secret/chase-sets` and the default ServiceAccount's `chase-sets` reference. A missing Secret, missing default ServiceAccount, missing reference, or expired deadline stops the deploy; there is no generated credential fallback or unbounded retry.

For a cold-pull incident, recover in this order:

1. If staging reports `CPBridgeReady` failure or the provider-managed taint remains, DigitalOcean support must restore the control-plane bridge first; then verify CoreDNS and scheduling.
2. Prove the namespace-local managed Secret name and default ServiceAccount reference through the bounded readiness helper. Do not refresh or select an obsolete parallel Secret.
3. Deploy a reviewed exact head that explicitly selects `chase-sets`, then recreate or roll out every private-image workload so the new Pod specs carry that name.
4. Prove the bootstrap Job and all application workloads Ready, then run the normal smoke/canary gates and an authorized cold-node or image-eviction pull discriminator.
5. Delete an obsolete parallel registry Secret only after exact-deploy evidence proves no workload references it. Repository repair alone is not deploy evidence.

The registry redaction boundary is strict: never request or retain Secret payloads, Docker config, complete Secret YAML/JSON, map-valued metadata, annotations, or credential-bearing command output. Support-safe verification is limited to the exact Secret resource name and the default ServiceAccount's referenced pull-secret names. Do not use `kubectl describe secret` or broad metadata queries. Record only workflow URLs, immutable Git/image identities, named readiness outcomes, workload readiness, and redacted provider support references.

## Diagnostics

Start with the workflow summary and uploaded deployment diagnostics. Then inspect:

```bash
kubectl --namespace chase-sets-platform describe ingress chase-sets-platform
kubectl --namespace chase-sets-platform logs deployment/platform-api --tail=200
kubectl --namespace chase-sets-platform logs deployment/platform-worker --tail=200
kubectl --namespace chase-sets-platform get certificate,certificaterequest,challenge
```

Diagnostic `doks.*` DNS names may confirm load-balancer reachability, but they are not release gates and are not present in the platform Ingress certificate. Smoke the live apex, `www`, `admin`, and an approved marketplace host.

### Preview-pool census (read-only)

Dispatch `.github/workflows/platform-preview-pool-census.yml` in the `preview` environment. Use `snapshot` for one bounded inventory or `sample` for a lifecycle window; `sample` accepts 1-60 minutes and a 5-60 second interval (the default is 45 minutes at 10 seconds). The workflow writes a `preview-pool-census/v1` artifact containing preview-node allocatable CPU and memory, non-preview requests, preview namespace kind and creation time, each container's request/limit, node, phase, termination/eviction reason, sampled maximum working set, sample count and first/last seen, deduplicated scheduling/eviction events, autoscaler status, sizing arithmetic, thin-sample warnings and any read errors. The seven expected workload components are `public-web`, `marketplace`, `admin-web`, `platform-api`, `platform-worker`, `preview-postgres`, and `platform-bootstrap`.

The census is strictly read-only: its script permits only `kubectl get` and kubelet `get --raw .../stats/summary`; it never writes pod specs, secrets, environment values or logs. A failed read produces `result: partial`, not a pass. A sampled peak is a lower bound and the artifact records the interval; containers observed fewer than three times are listed in `thinSamples`.

## Rollback

Use the immutable release reference and rollback target recorded by the workflow. A Helm rollback does not alter managed Postgres or DNS. After rollback, rerun workload readiness, ingress, projection-readiness, admin-shell, and money-path smoke before moving the production marker.

If bootstrap failed, distinguish an advisory-lock wait from a migration error. Never run a second bootstrap writer manually against the same environment.

## Catastrophe Recovery Contract

App Platform is retired and is not a compute fallback. Production recovery has two independent lanes:

- restore application compute with the DOKS Helm release while leaving healthy managed Postgres and DNS unchanged; or
- restore database integrity into a new managed-Postgres fork, move the DOKS runtime Secret to that fork under an active incident lock, then reconcile the recovered cluster through a reviewed fix-forward.

Do not combine the lanes unless evidence shows both compute and database failure. Never delete the source database or a recovery fork during the incident, never move the `production` marker before all recovery probes pass, and never let a routine Platform Deploy run while an emergency database Secret override is active.

### 1. Open The Incident And Freeze Promotion

Record an incident URL as `INCIDENT_REFERENCE`, record the current production marker with `git rev-parse origin/production`, and preserve the failing workflow URL and its `production-release-health` artifact. Generate and execute the repository-owned production lock command before making a recovery mutation:

```powershell
pnpm run ops release-lock:commands --action lock --environment production --reason "DOKS catastrophe recovery" --reference $env:INCIDENT_REFERENCE
```

Capture the production Environment's pre-incident lock values first so they can be restored exactly. Leave the lock active until the recovered topology is reconciled and the incident owner authorizes normal promotion. An audited emergency Platform Deploy may bypass the lock only with `emergency_release=true` and this same incident reference.

Configure the production cluster context in an approved operator shell. The default Terraform name is `chase-sets-production-doks`; if the live cluster has an override, use the `cluster_name` output from `doks/production.tfstate` instead.

```bash
export KUBECONFIG="$(mktemp)"
chmod 600 "$KUBECONFIG"
doctl kubernetes cluster kubeconfig show chase-sets-production-doks > "$KUBECONFIG"
kubectl config current-context
kubectl --namespace chase-sets-platform get deployments,rollouts,pods,ingress
```

### 2. Choose The Database Recovery Lane

If database integrity is not implicated, skip to the Helm rollback procedure. If it is implicated, stop application writers before choosing a recovery point:

```bash
mkdir -p artifacts/recovery
kubectl --namespace chase-sets-platform get deployments,rollouts \
  --selector app.kubernetes.io/instance=chase-sets-platform \
  --output json > artifacts/recovery/pre-recovery-workloads.json
kubectl --namespace chase-sets-platform scale deployments,rollouts \
  --selector app.kubernetes.io/instance=chase-sets-platform \
  --replicas=0
```

Use exactly one source:

1. **Retained pre-migrate restore point.** Download `production-release-health` from the affected Platform Deploy and inspect `production-db-restore-point.json`. Use its `restorePoint.clusterId` only when `type` is `digitalocean-database-fork`, `status` is `online`, and `preMigrateState.key` identifies the last known-good production marker. The fork name begins `cs-prod-rp-`. Add that exact name to the production Environment variable `PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES` before its six-hour cleanup window; preserve any existing comma-separated holds.
2. **Managed-Postgres PITR.** Use this when there is no matching online restore-point fork or when the required recovery time predates it. DigitalOcean supports a point-in-time fork within its managed restoration window. Choose the last known-good UTC timestamp before the corrupting write or migration, not the incident-detection time.

Inventory both the Terraform-owned source and any retained restore points without printing connection URIs:

```bash
SOURCE_CLUSTER_ID="$(doctl databases list --format ID,Name --no-header | awk '$2 == "chase-sets-postgres" { print $1; exit }')"
test -n "$SOURCE_CLUSTER_ID"
doctl databases get "$SOURCE_CLUSTER_ID" --format ID,Name,Status,Created --no-header
doctl databases backups "$SOURCE_CLUSTER_ID"
doctl databases list --format ID,Name,Status,Created --no-header | grep 'cs-prod-rp-' || true
```

For PITR, create a new recovery cluster and wait for it to become online. `RECOVERY_TIMESTAMP` must use DigitalOcean's UTC form, for example `2026-07-19 14:35:00 +0000 UTC`:

```bash
RECOVERY_NAME="cs-prod-recovery-$(date -u +%Y%m%d%H%M%S)"
doctl databases fork "$RECOVERY_NAME" \
  --restore-from-cluster-id "$SOURCE_CLUSTER_ID" \
  --restore-from-timestamp "$RECOVERY_TIMESTAMP" \
  --wait --output json > artifacts/recovery/pitr-fork.json
RECOVERY_CLUSTER_ID="$(doctl databases list --format ID,Name,Status --no-header | awk -v name="$RECOVERY_NAME" '$2 == name && $3 == "online" { print $1; exit }')"
test -n "$RECOVERY_CLUSTER_ID"
```

For a retained restore point, set `RECOVERY_NAME` and `RECOVERY_CLUSTER_ID` from the reviewed artifact, then prove the live inventory matches it:

```bash
doctl databases get "$RECOVERY_CLUSTER_ID" --format ID,Name,Status,Created --no-header
doctl databases db list "$RECOVERY_CLUSTER_ID" --no-header
EXISTING_HOLDS="$(gh variable get PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES --env production 2>/dev/null || true)"
UPDATED_HOLDS="$(printf '%s\n%s\n' "$EXISTING_HOLDS" "$RECOVERY_NAME" | tr ',' '\n' | sed '/^[[:space:]]*$/d' | sort -u | paste -sd, -)"
gh variable set PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES --env production --body "$UPDATED_HOLDS"
```

For either source, compare the complete database inventory and run the repository-owned restore validation against the fork. The connection URI stays only in the child process environment; never print or persist it:

```bash
doctl databases db list "$SOURCE_CLUSTER_ID" --format Name --no-header | sort \
  > artifacts/recovery/source-databases.txt
doctl databases db list "$RECOVERY_CLUSTER_ID" --format Name --no-header | sort \
  > artifacts/recovery/recovered-databases.txt
diff --unified artifacts/recovery/source-databases.txt artifacts/recovery/recovered-databases.txt

RECOVERY_DATABASE_URI="$(doctl databases connection "$RECOVERY_CLUSTER_ID" --format URI --no-header)" \
  node --input-type=module <<'NODE'
import pg from "pg";
import {
  discoverForkDatabaseChecks,
  validateForkDatabases,
} from "./scripts/digitalocean-database-restore-drill.mjs";

const connectionUri = process.env.RECOVERY_DATABASE_URI;
const databaseChecks = await discoverForkDatabaseChecks({ connectionUri, ClientClass: pg.Client });
const validation = await validateForkDatabases({ connectionUri, databaseChecks, ClientClass: pg.Client });
const failures = validation.checks.filter((check) => check.status !== "success");
console.log(JSON.stringify({
  expectedDatabaseCount: validation.expectedDatabaseCount,
  checkedDatabaseCount: validation.checkedDatabaseCount,
  failures: failures.map(({ contextName, errors }) => ({ contextName, errors })),
}, null, 2));
if (failures.length > 0 || validation.checkedDatabaseCount !== validation.expectedDatabaseCount) process.exit(1);
NODE
```

The official [PostgreSQL fork procedure](https://docs.digitalocean.com/products/databases/postgresql/how-to/fork-clusters/) and [`doctl databases fork` reference](https://docs.digitalocean.com/reference/doctl/reference/databases/fork/) define the provider restoration window and timestamp format. A fork copies the cluster-level databases and users. The monthly **Platform Database Restore Drill** is the supported rehearsal and its artifact is the expected validation shape.

### 3. Move DOKS To A Recovered Database

This is an incident-only bridge. It preserves the existing database names, users, and passwords from the copied cluster and changes only the managed cluster host/port in the runtime Secret. Do not print the Secret, generated URLs, or the temporary files.

```bash
RECOVERY_HOST="$(doctl databases connection "$RECOVERY_CLUSTER_ID" --format Host --no-header)"
RECOVERY_PORT="$(doctl databases connection "$RECOVERY_CLUSTER_ID" --format Port --no-header)"
test -n "$RECOVERY_HOST"
test -n "$RECOVERY_PORT"

umask 077
trap 'rm -f artifacts/recovery/runtime-secret-before.json artifacts/recovery/runtime-secret-recovered.json' EXIT
kubectl --namespace chase-sets-platform get secret chase-sets-platform-runtime --output json \
  > artifacts/recovery/runtime-secret-before.json
jq --arg host "$RECOVERY_HOST" --arg port "$RECOVERY_PORT" '
  .metadata = {name: "chase-sets-platform-runtime", namespace: "chase-sets-platform"}
  | .data |= with_entries(
      if (.key | test("^(BOOTSTRAP_)?DATABASE_URL_|^BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL$|^PLATFORM_(CONTROL|WORK_SIGNAL)_DATABASE_URL$|^WORKER_LISTENER_DATABASE_URL_"))
      then .value = ((.value | @base64d | sub("@[^/]+/"; "@" + $host + ":" + $port + "/")) | @base64)
      else .
      end
    )
' artifacts/recovery/runtime-secret-before.json > artifacts/recovery/runtime-secret-recovered.json
kubectl apply --filename artifacts/recovery/runtime-secret-recovered.json
rm -f artifacts/recovery/runtime-secret-before.json artifacts/recovery/runtime-secret-recovered.json
trap - EXIT
```

The [`doctl databases connection` command](https://docs.digitalocean.com/reference/doctl/reference/databases/connection/) exposes `Host` and `Port` as separate columns. Except for the isolated validation process above, never request its `URI`, `User`, or `Password` columns, and never log any of them.

Restore the captured Helm release manifest to bring workloads back with the recovered Secret. `ORIGINAL_REVISION` is the deployed revision captured before scaling down:

```bash
ORIGINAL_REVISION="$(helm history chase-sets-platform --namespace chase-sets-platform --output json \
  | tee artifacts/recovery/pre-recovery-helm-history.json \
  | jq -r '[.[] | select(.status == "deployed")][-1].revision')"
pnpm run platform:kubernetes-deployment -- rollback \
  --namespace chase-sets-platform \
  --release chase-sets-platform \
  --revision "$ORIGINAL_REVISION" \
  --timeout 15m \
  --runtime-env DEPLOYMENT_ENVIRONMENT=production \
  --out artifacts/recovery/database-recovery-rollout.json
jq -e '.result == "success"' artifacts/recovery/database-recovery-rollout.json >/dev/null
```

Keep the release lock active. The next ordinary Platform Deploy would export URLs from the original Terraform state and overwrite the bridge. Open a reviewed recovery PR that makes the recovered cluster the Terraform-owned production cluster, proves a non-destructive real-state plan, and regenerates the runtime Secret through Platform Deploy. Do not use `terraform state rm`, delete the old cluster, or unlock production as a shortcut.

### 4. DOKS Emergency Helm Rollback

Use this path when managed Postgres and DNS are healthy but application compute is not. First identify the last smoke-verified production commit, its `release-*` tag, immutable registry image, and the Helm revision whose `global.image.digest` matches that image. Capture evidence before mutation:

```bash
mkdir -p artifacts/recovery
git fetch origin production --tags
TARGET_COMMIT="$(git rev-parse origin/production)"
RELEASE_TAG="$(git tag --points-at "$TARGET_COMMIT" --list 'release-*' | sort | tail -n 1)"
REGISTRY_NAME="$(doctl registry get --format Name --no-header | tr -d '[:space:]')"
IMAGE_REF="registry.digitalocean.com/${REGISTRY_NAME}/chase-sets-platform:${RELEASE_TAG}"
doctl registry login --expiry-seconds 3600
TARGET_DIGEST="$(docker buildx imagetools inspect "$IMAGE_REF" --format '{{.Manifest.Digest}}')"
helm history chase-sets-platform --namespace chase-sets-platform --output json \
  | tee artifacts/recovery/pre-rollback-helm-history.json
TARGET_REVISIONS=()
while read -r revision; do
  revision_values="$(helm get values chase-sets-platform --namespace chase-sets-platform \
    --revision "$revision" --all --output json)"
  revision_tag="$(jq -r '.global.image.tag // empty' <<<"$revision_values")"
  revision_digest="$(jq -r '.global.image.digest // empty' <<<"$revision_values")"
  if [ "$revision_tag" = "$TARGET_COMMIT" ] && [ "$revision_digest" = "$TARGET_DIGEST" ]; then
    TARGET_REVISIONS+=("$revision")
  fi
done < <(jq -r '[.[] | select(.status == "deployed" or .status == "superseded")] | sort_by(.revision | tonumber) | .[].revision' artifacts/recovery/pre-rollback-helm-history.json)
test "${#TARGET_REVISIONS[@]}" -eq 1
TARGET_REVISION="${TARGET_REVISIONS[0]}"
helm get values chase-sets-platform --namespace chase-sets-platform \
  --revision "$TARGET_REVISION" --all --output json \
  | jq '{image: .global.image}' > artifacts/recovery/target-revision-image.json
```

The selected revision must match the registry digest for the last green production release. Dispatch the two prerequisite workflows with that immutable evidence. Both must succeed before the Helm command is executed from the approved production context. These workflows guide and validate the operation; they do not mutate Helm.

```bash
gh workflow run platform-emergency-recovery.yml --ref main \
  --field mode=rollback \
  --field emergency_reference="$INCIDENT_REFERENCE" \
  --field target_commit="$TARGET_COMMIT" \
  --field release_tag="$RELEASE_TAG" \
  --field image_ref="$IMAGE_REF" \
  --field rollback_revision="$TARGET_REVISION"

gh workflow run platform-rollback-readiness.yml --ref main \
  --field mode=rollback \
  --field emergency_reference="$INCIDENT_REFERENCE" \
  --field target_commit="$TARGET_COMMIT" \
  --field release_tag="$RELEASE_TAG" \
  --field image_ref="$IMAGE_REF" \
  --field destructive_plan_approved=false
```

Open the emitted run URLs, wait for `Emergency Recovery Guide` and `Rollback Readiness` to pass, and attach both URLs to the incident.

```bash
pnpm run platform:kubernetes-deployment -- rollback \
  --namespace chase-sets-platform \
  --release chase-sets-platform \
  --revision "$TARGET_REVISION" \
  --timeout 15m \
  --runtime-env DEPLOYMENT_ENVIRONMENT=production \
  --out artifacts/recovery/production-rollback.json
jq -e '.result == "success"' artifacts/recovery/production-rollback.json >/dev/null
```

The helper executes `helm rollback chase-sets-platform <revision> --namespace chase-sets-platform --wait --timeout 15m`, rejects failed or missing source revisions, and verifies the resulting history, Helm tag/digest, and every application workload image before returning success. Preserve both histories and the workload image evidence:

```bash
helm history chase-sets-platform --namespace chase-sets-platform --output json \
  > artifacts/recovery/post-rollback-helm-history.json
kubectl --namespace chase-sets-platform get deployments,rollouts,pods \
  --output wide > artifacts/recovery/post-rollback-workloads.txt
kubectl --namespace chase-sets-platform get pods \
  --output jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .status.containerStatuses[*]}{.imageID}{" "}{end}{"\n"}{end}' \
  > artifacts/recovery/post-rollback-image-ids.txt
```

A failed `helm rollback` whose resource patch is rejected (for example the cert-manager webhook refusing a Certificate patch, as in #8104) leaves Helm history with zero deployed revisions: Helm marks the previous head superseded and records the rollback revision as failed with the description `Rollback "chase-sets-platform" failed: <error>`, discarding the target number. The production deploy's `Capture production rollback target` step heals exactly that shape before it captures the rollback target: it identifies the target T from a trailing tail of one to three failed rollback revisions, either from a surviving `Rollback to <T>` description or, for the failure form, as the newest superseded revision before the tail whose `helm get values --all` output equals the failed revision's values (Helm copies T's values into the rollback revision verbatim). It then requires T's image tag to equal the last-known-good commit, every live application workload to already run T's image, no active Helm hook Job or Pod, and an unchanged history across two reads, and only then runs the existing exact `helm rollback chase-sets-platform <T>` once. The capture record carries the heal under `failedRollbackRecovery` and proceeds from the new deployed `Rollback to <T>` head; any other zero-deployed history, any mismatch, or a failed heal stops the deploy with `Failed-rollback recovery to revision <T> failed` or the usual `observed 0` refusal and never runs the upgrade, so the operator steps above remain the fallback.

### 5. Verify, Reconcile, And Unlock

All five application workloads (`public-web`, `marketplace`, `admin-web`, `platform-api`, and `platform-worker`) must be ready. Verify the authoritative live surfaces, then run the production-profile smoke with protected admin credentials already exported:

```bash
kubectl --namespace chase-sets-platform get deployments,rollouts,pods,ingress
curl --fail --silent --show-error --head https://chasesets.com/ >/dev/null
curl --fail --silent --show-error --head https://www.chasesets.com/ >/dev/null
curl --fail --silent --show-error https://admin.chasesets.com/health/ready >/dev/null

export SMOKE_REQUIRE_NATIVE_MCP=false
export SMOKE_WRITE_WAITLIST=false
export SMOKE_REQUIRE_ADMIN=true
export SMOKE_ADMIN_TOPOLOGY=production-platform-disabled
pnpm run smoke:platform -- https://chasesets.com https://admin.chasesets.com
```

If public marketplace is enabled, set `SMOKE_REQUIRE_MARKETPLACE=true`, set the topology to `public-marketplace`, include `https://marketplace.chasesets.com`, and run the approved money-path smoke. Verify projection readiness against the restored event-store head; rebuild only derived read models using [Projection Operations](./projection-operations.md). Never replay provider side effects, outboxes, idempotency ledgers, or other non-derived state.

For a drill, roll forward to the originally captured Helm revision with the same command and repeat every probe; this creates a new Helm revision that restores the original release content. For a real incident, remain on the recovered revision until a reviewed revert or fix-forward passes Platform Deploy. Restore the pre-incident lock values only after the incident owner accepts the recovered database/compute evidence and the production marker accurately names the served commit.

Delete local Secret snapshots and kubeconfig files when evidence capture is complete. Retain only support-safe histories, image digests, workflow URLs, probe results, recovery timestamps, cluster IDs/names, and JSON records.

### Rehearsed Evidence (#4054)

- [Live production DOKS rollback and roll-forward evidence](https://github.com/chase-sets/chase-sets/issues/4054#issuecomment-5016161511): revision `135` was captured, revision `134` was restored as new revision `136`, and rolling forward to captured revision `135` produced healthy revision `137` with the original image digest.
- [Platform Emergency Recovery run 29691068717](https://github.com/chase-sets/chase-sets/actions/runs/29691068717) and [Platform Rollback Readiness run 29691069514](https://github.com/chase-sets/chase-sets/actions/runs/29691069514) are the prerequisite workflow evidence used by that drill.
- [Staging Helm rollback drill 29650032015](https://github.com/chase-sets/chase-sets/actions/runs/29650032015) proved the same rollback, smoke, roll-forward, and restored-smoke sequence: original revision `387`, target revision `385`, rollback revision `388`, and restored revision `389`.
- [Managed-Postgres restore drill 29643965397](https://github.com/chase-sets/chase-sets/actions/runs/29643965397) brought a temporary fork online in 32m 29.644s and validated 20/20 context databases; the [production PITR and restore-point re-proof](https://github.com/chase-sets/chase-sets/issues/4054#issuecomment-5016162432) records why routine DOKS deploys use managed PITR and when a `cs-prod-rp-*` fork is required.

## Platform Staging Bootstrap Hook Drill

Run the **Platform Staging Bootstrap Hook Drill** workflow and choose `run staging bootstrap hook drill`. It verifies both the held-lock failure posture and a normal Helm upgrade without mutating production.

Required evidence includes:

- `held-lock-evidence.json`, proving the hook waits or fails closed while another session owns the advisory lock; and
- `successful-bootstrap-upgrade`, proving the next reviewed upgrade completes after the lock is released.

Keep those artifacts with the issue or PR that requested the drill.

## Runtime Secret Rotation

Rotate provider credentials in the protected GitHub Environment first, then run Platform Deploy so the Secret exporter and workloads move atomically. The daily credential health check and its alert levels are in [Credential Rotation](./credential-rotation.md). Verify the Secret checksum changed and all workloads rolled. Do not patch the Kubernetes Secret directly except under an active incident, and reconcile any emergency patch through the workflow immediately.

## Ingress, Certificates, And Load Balancer

Cluster-scoped ingress-nginx, cert-manager, issuers, Argo Rollouts, and preview wildcard resources are managed by `scripts/doks-cluster-addons.mjs`. Application Ingress resources live in the platform chart.

```bash
node scripts/doks-cluster-addons.mjs --environment staging --dry-run
gh workflow run platform-staging-cluster-addons.yml --ref main -f confirm="apply staging cluster addons" -f release_ref=<main-sha> -f preflight_only=true  # false runs the full staging plan
kubectl --namespace ingress-nginx get service ingress-nginx-controller
kubectl --namespace chase-sets-platform get ingress
```

The environment DNS target must equal the ingress-nginx LoadBalancer IPv4 address. A target mismatch fails Terraform checks. Production live-host certificates use DNS-01; staging live hosts use HTTP-01. Preview namespaces copy the shared wildcard Secret rather than issuing per-preview certificates.

### Preview Wildcard Renewal (#9268)

The shared `cert-manager/preview-wildcard` certificate renews through DNS-01, whose solver reads `cert-manager/digitalocean-dns-token`. Every staging deploy runs `node scripts/preview-wildcard-certificate.mjs converge`, which re-applies that Secret from the current `DIGITALOCEAN_ACCESS_TOKEN` over kubectl stdin. When the certificate is not Ready or expires within 14 days, the same command deletes stale non-Ready CertificateRequests, which cascades to their Orders and Challenges, and sets `Issuing=True` the same way `cmctl renew` does. Near the end of the deploy, `check --min-remaining-days 14 --wait-seconds 600` fails the staging deploy closed if renewal has not finished. Because that guard runs after the staging rollout is promoted, its failure leaves the new staging app live while `Mark staging applied` is skipped, so production promotion stays blocked; restore the certificate with the workflow below, then re-run the staging deploy. Preview deploys run a single read-only `check` that fails when the certificate is not Ready or has expired, and warns once it is inside the 14-day floor.

To restore preview TLS without cutting a release, for example right after rotating the token:

```bash
gh workflow run platform-preview-wildcard-tls.yml --ref main -f confirm="restore preview wildcard tls"
kubectl --namespace cert-manager get certificate,certificaterequest,order,challenge
```

## Argo Rollouts

Argo exposure is environment-gated. Before enabling it, verify ingress, AnalysisTemplate dependencies, stable/canary Services, metric credentials, and rollback evidence. Rendering rejects rollout activation without DOKS ingress.

## Evidence Rules

- Use immutable Git SHAs and image digests.
- Keep saved Terraform plans and JSON beside their workflow run.
- Treat remote-state plans as sensitive because values may be present even when marked sensitive.
- Record exact resource addresses for every destructive plan.
- Do not apply a production destructive plan without a matching checked-in owner approval.

See [DigitalOcean Platform Deployment](./digitalocean-platform-deployment.md) for Terraform ownership, state recovery, decommission approval, and CI gates.
