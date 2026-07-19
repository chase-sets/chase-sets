# DOKS Platform Operations

This runbook is the current runtime-compute operating guide for staging and production.

## State And Names

| Item | Value |
| --- | --- |
| Helm release | `chase-sets-platform` |
| Namespace | `chase-sets-platform` |
| Ingress controller | `ingress-nginx` |
| Runtime secret | `chase-sets-runtime` |
| Bootstrap hook | `platform-bootstrap` |

Use the environment-specific kubeconfig output from the DOKS Terraform root. Never reuse staging credentials for production.

## Runtime XL Node Pool

Staging has a separate `runtime-xl` node pool for migrations that need more memory than the default pool. It is untainted, so ordinary platform workloads can schedule there while the pool is enabled. Before removing or resizing it, cordon and drain its nodes, confirm every workload is ready on the default pool, and then apply the Terraform change. Terraform intentionally does not automate this drain because eviction timing and disruption evidence require an operator decision.

## Preview Node Pool

PR previews use the staging cluster's dedicated preview pool. Nodes carry the `chase-sets.com/preview-only=true:NoSchedule` taint, and preview workloads supply the matching toleration plus the `chase-sets.com/pool=preview` nodeSelector. The pool uses `min_nodes = 0`, so it scales to zero when no preview pods are pending. Staging runtime workloads must never tolerate the preview-only taint.

## Deploy And Status

Routine deploys run through Platform Deploy. For local read-only inspection:

```bash
helm status chase-sets-platform --namespace chase-sets-platform
kubectl --namespace chase-sets-platform get deployments,rollouts,pods,ingress
kubectl --namespace chase-sets-platform get events --sort-by=.lastTimestamp
```

The deploy helper renders the checked-in runtime contract, applies the environment Secret, runs the Helm upgrade, waits for bootstrap and workload readiness, verifies ingress, and emits release-health evidence. Do not hand-edit generated values or live Deployments.

## Diagnostics

Start with the workflow summary and uploaded deployment diagnostics. Then inspect:

```bash
kubectl --namespace chase-sets-platform describe ingress chase-sets-platform
kubectl --namespace chase-sets-platform logs deployment/platform-api --tail=200
kubectl --namespace chase-sets-platform logs deployment/platform-worker --tail=200
kubectl --namespace chase-sets-platform get certificate,certificaterequest,challenge
```

Diagnostic `doks.*` DNS names may confirm load-balancer reachability, but they are not release gates and are not present in the platform Ingress certificate. Smoke the live apex, `www`, `admin`, and an approved marketplace host.

## Rollback

Use the immutable release reference and rollback target recorded by the workflow. A Helm rollback does not alter managed Postgres or DNS. After rollback, rerun workload readiness, ingress, projection-readiness, admin-shell, and money-path smoke before moving the production marker.

If bootstrap failed, distinguish an advisory-lock wait from a migration error. Never run a second bootstrap writer manually against the same environment.

## Platform Staging Bootstrap Hook Drill

Run the **Platform Staging Bootstrap Hook Drill** workflow and choose `run staging bootstrap hook drill`. It verifies both the held-lock failure posture and a normal Helm upgrade without mutating production.

Required evidence includes:

- `held-lock-evidence.json`, proving the hook waits or fails closed while another session owns the advisory lock; and
- `successful-bootstrap-upgrade`, proving the next reviewed upgrade completes after the lock is released.

Keep those artifacts with the issue or PR that requested the drill.

## Runtime Secret Rotation

Rotate provider credentials in the protected GitHub Environment first, then run Platform Deploy so the Secret exporter and workloads move atomically. Verify the Secret checksum changed and all workloads rolled. Do not patch the Kubernetes Secret directly except under an active incident, and reconcile any emergency patch through the workflow immediately.

## Ingress, Certificates, And Load Balancer

Cluster-scoped ingress-nginx, cert-manager, issuers, Argo Rollouts, and preview wildcard resources are managed by `scripts/doks-cluster-addons.mjs`. Application Ingress resources live in the platform chart.

```bash
node scripts/doks-cluster-addons.mjs --environment staging --dry-run
kubectl --namespace ingress-nginx get service ingress-nginx-controller
kubectl --namespace chase-sets-platform get ingress
```

The environment DNS target must equal the ingress-nginx LoadBalancer IPv4 address. A target mismatch fails Terraform checks. Production live-host certificates use DNS-01; staging live hosts use HTTP-01. Preview namespaces copy the shared wildcard Secret rather than issuing per-preview certificates.

## Argo Rollouts

Argo exposure is environment-gated. Before enabling it, verify ingress, AnalysisTemplate dependencies, stable/canary Services, metric credentials, and rollback evidence. Rendering rejects rollout activation without DOKS ingress.

## Evidence Rules

- Use immutable Git SHAs and image digests.
- Keep saved Terraform plans and JSON beside their workflow run.
- Treat remote-state plans as sensitive because values may be present even when marked sensitive.
- Record exact resource addresses for every destructive plan.
- Do not apply a production destructive plan without a matching checked-in owner approval.

See [DigitalOcean Platform Deployment](./digitalocean-platform-deployment.md) for Terraform ownership, state recovery, decommission approval, and CI gates.
