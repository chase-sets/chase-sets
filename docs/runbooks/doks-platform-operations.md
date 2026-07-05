# DOKS Platform Operations

This runbook is the operator reference for the DOKS runtime accepted by [ADR 0018](../adr/0018-doks-compute-runtime.md). It covers the Kubernetes equivalents for the App Platform actions in [DigitalOcean Platform Deployment](./digitalocean-platform-deployment.md): deploy inspection, rollout status, rollback, logs, ingress/certificates, runtime Secret rotation, and cutover recovery.

Use this runbook only after the target DOKS cluster exists through `infrastructure/digitalocean/doks` and the platform Helm chart exists through `infrastructure/helm/platform`. Until staging cutover completes, App Platform remains the live serving path.

## State And Names

| Surface | Staging | Production |
| --- | --- | --- |
| DOKS Terraform state | `doks/staging.tfstate` | `doks/production.tfstate` |
| Runtime Terraform state | `landing/staging.tfstate` | `landing/production.tfstate` |
| Environment DNS state | `environment-dns/staging.tfstate` | production DNS stays in platform/runtime roots until cutover |
| Helm release | `chase-sets-staging` | `chase-sets-production` |
| Namespace | `staging` | `production` |
| Runtime Secret | `chase-sets-platform-runtime` | `chase-sets-platform-runtime` |

The chart renders these runtime Deployments when their component is enabled:

- `public-web`
- `marketplace`
- `admin-web`
- `platform-api`
- `platform-worker`

`platform-bootstrap` is a Helm pre-install/pre-upgrade Job. It quiesces worker Deployments before bootstrap and restores them when bootstrap fails.

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

Use the GitHub Actions workflows for normal deploys and evidence. Use a local operator shell only for incident investigation, cutover rehearsal, or an owner-approved emergency recovery.

## Deploy And Rollout Status

Normal DOKS deploys should use the rollout helper so Helm arguments, workload names, and evidence stay source-owned:

```bash
pnpm run platform:kubernetes-deployment -- deploy \
  --release chase-sets-staging \
  --namespace staging \
  --image registry.digitalocean.com/chase-sets/chase-sets-platform:<release-commit> \
  --timeout 10m
```

Quick inspection commands:

```bash
helm status chase-sets-staging --namespace staging
helm history chase-sets-staging --namespace staging
kubectl rollout status deployment/chase-sets-staging-chase-sets-platform-platform-api --namespace staging --timeout=10m
kubectl get deployments,jobs,pods,events --namespace staging --sort-by=.metadata.creationTimestamp
```

If `platform-bootstrap` fails, inspect the hook Job before retrying:

```bash
kubectl get jobs --namespace staging
kubectl describe job --namespace staging -l app.kubernetes.io/component=platform-bootstrap
kubectl logs --namespace staging -l app.kubernetes.io/component=platform-bootstrap --all-containers --tail=300
```

Do not scale runtime Deployments by hand during a normal release. The bootstrap hook owns worker quiesce for release-time schema/seed work, and Helm owns runtime replica convergence.

## Diagnostics

Use the source-owned diagnostics command first:

```bash
pnpm run platform:kubernetes-deployment -- diagnostics \
  --release chase-sets-staging \
  --namespace staging
```

Manual equivalents:

```bash
kubectl describe deployment --namespace staging -l app.kubernetes.io/instance=chase-sets-staging
kubectl get pods --namespace staging -o wide
kubectl logs --namespace staging -l app.kubernetes.io/component=platform-api --all-containers --tail=300
kubectl logs --namespace staging -l app.kubernetes.io/component=platform-worker --all-containers --tail=300
kubectl describe ingress --namespace staging
kubectl get certificates,certificaterequests,orders,challenges --namespace staging
```

For node issues:

```bash
kubectl get nodes -o wide
kubectl describe node <node-name>
kubectl top nodes
kubectl top pods --namespace staging
```

If a node is NotReady, first confirm DigitalOcean maintenance or DOKS node-pool events in the DigitalOcean console or `doctl kubernetes cluster node-pool list <cluster-id>`. Do not drain or delete nodes during a deploy unless the release owner confirms Helm is idle and there is enough remaining capacity for the live replica set.

## Rollback

Rollback uses Helm release history, not App Platform image mutation. The automated production path should call the helper:

```bash
pnpm run platform:kubernetes-deployment -- rollback \
  --release chase-sets-production \
  --namespace production \
  --timeout 10m
```

To roll back to a specific revision:

```bash
pnpm run platform:kubernetes-deployment -- rollback \
  --release chase-sets-production \
  --namespace production \
  --revision <revision> \
  --timeout 10m
```

After rollback:

1. Run `helm status` and `kubectl rollout status` for each runtime Deployment.
2. Run the environment smoke workflow or `pnpm run smoke:platform` against the live domains.
3. Preserve the workflow URL, Helm revision, image reference, and smoke result in the owning incident or issue.
4. Prefer fix-forward when the failed release changed durable schema, bootstrap policy, or provider behavior that cannot be safely reversed by image rollback alone.

## Runtime Secret Rotation

Runtime Secrets are Kubernetes-owned and are not rendered by the chart. The source-owned helper derives required keys from the chart and applies a Kubernetes Secret without printing values:

```bash
node ./scripts/platform-kubernetes-secret.mjs --namespace staging
```

Use dry run to confirm key shape:

```bash
node ./scripts/platform-kubernetes-secret.mjs --dry-run --namespace staging
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
kubectl get ingress --namespace staging
kubectl describe ingress --namespace staging
kubectl get service --all-namespaces | grep -i loadbalancer
kubectl get certificates,orders,challenges --namespace staging
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
