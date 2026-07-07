# DOKS Platform Operations

This runbook is the operator reference for the DOKS runtime accepted by [ADR 0018](../adr/0018-doks-compute-runtime.md). It covers the Kubernetes equivalents for the App Platform actions in [DigitalOcean Platform Deployment](./digitalocean-platform-deployment.md): deploy inspection, rollout status, rollback, logs, ingress/certificates, runtime Secret rotation, and cutover recovery.

Use this runbook only after the target DOKS cluster exists through `infrastructure/digitalocean/doks` and the platform Helm chart exists through `infrastructure/helm/platform`. Until staging cutover completes, App Platform remains the live serving path.

## State And Names

| Surface | Staging | Production |
| --- | --- | --- |
| DOKS Terraform state | `doks/staging.tfstate` | `doks/production.tfstate` |
| Runtime Terraform state | `landing/staging.tfstate` | `landing/production.tfstate` |
| Environment DNS state | `environment-dns/staging.tfstate` | production DNS stays in platform/runtime roots until cutover |
| Helm release | `chase-sets-platform` | `chase-sets-platform` |
| Namespace | `chase-sets-platform` | `chase-sets-platform` |
| Runtime Secret | `chase-sets-platform-runtime` | `chase-sets-platform-runtime` |

The chart renders these runtime Deployments when their component is enabled:

- `public-web`
- `marketplace`
- `admin-web`
- `platform-api`
- `platform-worker`

`platform-bootstrap` is a Helm pre-install/pre-upgrade Job. It quiesces worker Deployments before bootstrap and restores them when bootstrap fails. Keep the release-time timeout budget ordered as: bootstrap command timeout `780s` < hook active deadline `890s` < Helm rollout timeout `15m` < app schema-lock retry budget `30m`. The worker drain/restore wait is capped at `45s` so a timed-out bootstrap command can still restore replicas and fail the Job before Helm's 900-second rollout window expires.

## Operator Shell Setup

Initialize the DOKS Terraform root for the target environment and export a temporary kubeconfig. Do not commit kubeconfig files, Terraform state, or command output that contains secrets.

```bash
environment=staging
terraform -chdir=infrastructure/digitalocean/doks init \
  -backend-config=bucket=chase-sets-terraform-state \
  -backend-config=key=doks/${environment}.tfstate \
  -backend-config=region=us-east-1 \
  -backend-config='endpoints={s3="https://nyc3.digitaloceanspaces.com"}' \
  -backend-config=skip_credentials_validation=true \
  -backend-config=skip_metadata_api_check=true \
  -backend-config=skip_region_validation=true \
  -backend-config=skip_requesting_account_id=true \
  -backend-config=use_path_style=true \
  -backend-config=use_lockfile=true
kubeconfig="$(mktemp)"
terraform -chdir=infrastructure/digitalocean/doks output -raw kubeconfig > "$kubeconfig"
chmod 600 "$kubeconfig"
export KUBECONFIG="$kubeconfig"
kubectl config current-context
```

Use the GitHub Actions workflows for normal deploys and evidence. Use `Platform Staging Helm Recovery` (`.github/workflows/platform-staging-helm-recovery.yml`) for owner-approved staging Helm rollback recovery when a DOKS release is stuck or a staging deploy cannot progress. Use a local operator shell only for incident investigation, cutover rehearsal, or an owner-approved emergency recovery that cannot be completed through a workflow.

Use `Platform Staging Bootstrap Hook Drill` (`.github/workflows/platform-staging-bootstrap-hook-drill.yml`) for the staging-only bootstrap hook acceptance drill. Dispatch requires the exact confirmation phrase `run staging bootstrap hook drill`. The workflow uses the current staging DOKS release `chase-sets-platform` and namespace `chase-sets-platform`, captures redacted Helm/Kubernetes/smoke artifacts, injects a live held lock on the Catalog `bounded_context_schema_migrations` relation through an existing ready `platform-worker` pod, runs a successful Helm upgrade that must quiesce the worker and release the lock before bootstrap proceeds, then runs a controlled failed-bootstrap upgrade with non-secret values and verifies Helm atomic rollback plus smoke. `held-lock-evidence.json` proves #4048/#4463/#4464 only when `result` is `released`, `lockRelease.status` is `observed`, `lockRelease.releasedDuring` is `successful-bootstrap-upgrade`, and the drill record is `success`. If held-lock setup fails, the workflow stops before Helm upgrade and reports a support-safe `setup-failed` blocker without database URLs, credentials, raw pod names, customer data, or provider data.

## Deploy And Rollout Status

Normal DOKS deploys should use the rollout helper so Helm arguments, workload names, and evidence stay source-owned:

```bash
pnpm run platform:kubernetes-deployment -- deploy \
  --release chase-sets-platform \
  --namespace chase-sets-platform \
  --image registry.digitalocean.com/chase-sets/chase-sets-platform:<release-commit> \
  --timeout 15m
```

Quick inspection commands:

```bash
helm status chase-sets-platform --namespace chase-sets-platform
helm history chase-sets-platform --namespace chase-sets-platform
kubectl rollout status deployment/chase-sets-platform-chase-sets-platform-platform-api --namespace chase-sets-platform --timeout=15m
kubectl get deployments,jobs,pods,events --namespace chase-sets-platform --sort-by=.metadata.creationTimestamp
```

If `platform-bootstrap` fails, inspect the hook Job before retrying:

```bash
kubectl get jobs --namespace chase-sets-platform
kubectl describe job --namespace chase-sets-platform -l app.kubernetes.io/component=platform-bootstrap
kubectl logs --namespace chase-sets-platform -l app.kubernetes.io/component=platform-bootstrap --all-containers --tail=300
```

Do not scale runtime Deployments by hand during a normal release. The bootstrap hook owns worker quiesce for release-time schema/seed work, and Helm owns runtime replica convergence.

## Diagnostics

Use the source-owned diagnostics command first:

```bash
pnpm run platform:kubernetes-deployment -- diagnostics \
  --release chase-sets-platform \
  --namespace chase-sets-platform
```

Manual equivalents:

```bash
kubectl describe deployment --namespace chase-sets-platform -l app.kubernetes.io/instance=chase-sets-platform
kubectl get pods --namespace chase-sets-platform -o wide
kubectl logs --namespace chase-sets-platform -l app.kubernetes.io/component=platform-api --all-containers --tail=300
kubectl logs --namespace chase-sets-platform -l app.kubernetes.io/component=platform-worker --all-containers --tail=300
kubectl describe ingress --namespace chase-sets-platform
kubectl get certificates,certificaterequests,orders,challenges --namespace chase-sets-platform
```

For node issues:

```bash
kubectl get nodes -o wide
kubectl describe node <node-name>
kubectl top nodes
kubectl top pods --namespace chase-sets-platform
```

If a node is NotReady, first confirm DigitalOcean maintenance or DOKS node-pool events in the DigitalOcean console or `doctl kubernetes cluster node-pool list <cluster-id>`. Do not drain or delete nodes during a deploy unless the release owner confirms Helm is idle and there is enough remaining capacity for the live replica set.

## Rollback

Rollback uses Helm release history, not App Platform image mutation. The automated production path should call the helper:

```bash
pnpm run platform:kubernetes-deployment -- rollback \
  --release chase-sets-platform \
  --namespace chase-sets-platform \
  --timeout 15m
```

For staging DOKS release-lane recovery, dispatch `Platform Staging Helm Recovery` with the exact confirmation phrase `recover staging helm release`, a recovery reference, and an optional Helm revision. The workflow shares the staging deploy concurrency group, configures the staging DOKS kubeconfig from Terraform state, captures Helm status/history plus source-owned diagnostics before and after rollback, runs the same `platform:kubernetes-deployment -- rollback` helper for release `chase-sets-platform` in namespace `chase-sets-platform`, and uploads `platform-staging-helm-recovery-<run>-<attempt>` evidence.

To roll back to a specific revision:

```bash
pnpm run platform:kubernetes-deployment -- rollback \
  --release chase-sets-platform \
  --namespace chase-sets-platform \
  --revision <revision> \
  --timeout 15m
```

After rollback:

1. Run `helm status` and `kubectl rollout status` for each runtime Deployment.
2. Run the environment smoke workflow or `pnpm run smoke:platform` against the live domains.
3. Preserve the workflow URL, Helm revision, image reference, and smoke result in the owning incident or issue.
4. Prefer fix-forward when the failed release changed durable schema, bootstrap policy, or provider behavior that cannot be safely reversed by image rollback alone.

## Runtime Secret Rotation

Runtime Secrets are Kubernetes-owned and are not rendered by the chart. The source-owned helper derives required keys from the chart and applies a Kubernetes Secret without printing values:

```bash
node ./scripts/platform-kubernetes-secret.mjs --namespace chase-sets-platform
```

Use dry run to confirm key shape:

```bash
node ./scripts/platform-kubernetes-secret.mjs --dry-run --namespace chase-sets-platform
```

Rotation sequence:

1. Update the GitHub Environment secret or operator shell environment.
2. Apply the Secret with `platform-kubernetes-secret.mjs`.
3. Run a Helm deploy or restart the affected Deployments so pods read the new environment values.
4. Verify readiness and smoke before revoking the old provider credential.

Manual `kubectl edit secret` is an emergency-only action. If used, immediately follow with the source-owned helper so the next deployment does not unintentionally revert the key set.

## Ingress, Certificates, And DNS Cutover

Ingress stays disabled until the ingress controller, cert-manager issuer, and DOKS load balancer target are known. The Helm chart owns application Ingress objects only after this cutover gate.

Ingress inspection:

```bash
kubectl get ingress --namespace chase-sets-platform
kubectl describe ingress --namespace chase-sets-platform
kubectl get service --all-namespaces | grep -i loadbalancer
kubectl get certificates,orders,challenges --namespace chase-sets-platform
```

DNS cutover sequence:

1. Confirm the DOKS Ingress load balancer has a stable IPv4 address.
2. Enable the matching `infrastructure/digitalocean/environment-dns` DOKS records for staging with the target address and low TTL.
3. Wait for `scripts/platform-ingress-wait.mjs` or equivalent HTTPS probes to pass for landing, marketplace, admin, and `/api/health/ready`.
4. Keep the App Platform rollback path available until the full staging UAT battery passes.
5. Raise TTL only after rollback confidence and smoke evidence are recorded.

Certificate incidents:

- If `Certificate` is pending, inspect cert-manager `Order` and `Challenge` resources before changing DNS.
- If HTTP-01 challenges fail, confirm the Ingress class, host, DNS target, and any redirect middleware.
- If production cert issuance fails during cutover, pause DNS promotion and keep App Platform serving until certificate evidence is green.

## App Platform To DOKS Action Map

| Old App Platform action | DOKS equivalent |
| --- | --- |
| `doctl apps get <app-id>` | `helm status <release> --namespace <namespace>` plus `kubectl get deployments,pods,ingress` |
| Wait for active deployment | `pnpm run platform:kubernetes-deployment -- deploy ...` or `kubectl rollout status deployment/<name>` |
| Force App Platform deployment | Helm upgrade with the same immutable image tag |
| App deployment diagnostics | `pnpm run platform:kubernetes-deployment -- diagnostics ...` |
| App image rollback | `pnpm run platform:kubernetes-deployment -- rollback ...` |
| App domain wait | `scripts/platform-ingress-wait.mjs` and HTTPS smoke against Ingress hosts |
| App spec environment variable update | `platform-kubernetes-secret.mjs` followed by Helm upgrade or Deployment restart |
| App Platform component logs | `kubectl logs --selector app.kubernetes.io/component=<component>` |
| App Platform worker scale | Helm values or HPA/KEDA policy; manual `kubectl scale` only during an incident with owner approval |

## Evidence Rules

- Do not paste kubeconfigs, Terraform state, Secret manifests, provider tokens, database URLs, cookies, or raw pod environment output into GitHub.
- Prefer workflow artifacts and summaries for deploy, rollback, restore, and cutover proof.
- When local commands are necessary, capture support-safe summaries: release, namespace, image tag or digest, Helm revision, rollout result, smoke URLs without credentials, and redacted error messages.
- File a new issue in milestone #103 when an operator action cannot be completed through a source-owned workflow or helper.
