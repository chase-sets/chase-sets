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

## Runtime XL Node Pool

Staging carries a dedicated `runtime-xl` node pool for rolling-deploy peak capacity. It is a separate `digitalocean_kubernetes_node_pool` resource because changing the default `node_pool` block on `digitalocean_kubernetes_cluster.platform` would replace the whole cluster.

- Staging-only: `runtime_xl_node_pool_enabled` is forced off outside `environment=staging`.
- Capacity: one `s-4vcpu-8gb` node, labeled `chase-sets.com/pool=runtime-xl`.
- Scheduling: the pool has no taints, so platform workloads can schedule there without tolerations or a node selector.
- Migration: after Terraform creates the pool, wait for the new node to become Ready, then cordon and drain the old `chase-sets.com/pool=runtime` node during an owner-approved idle release window. Verify all platform workloads are Ready on the new pool before optionally shrinking the default pool. Terraform intentionally does not automate this drain.
- Evidence: the `runtime_xl_node_pool` Terraform output records the name, size, node count, and pool label.

## Preview Node Pool

The staging cluster carries a dedicated `preview` node pool for PR preview environments so previews and the staging estate never contend for the same node. The pool is defined in `infrastructure/digitalocean/doks` and applies through the Platform DOKS Foundation Apply workflow like the rest of the root:

- Staging-only: `preview_node_pool_enabled` is forced off outside `environment=staging`; production never hosts previews.
- Scale-to-zero: the pool autoscales with `min_nodes = 0`, so it costs nothing while no previews are running. `preview_node_pool_max_nodes` bounds concurrent preview environments.
- Sizing: `preview_node_pool_size` defaults to one node large enough for a full preview platform stack (web, admin, api, worker, bootstrap, in-cluster Postgres), so each preview scales out one node.
- Isolation contract: nodes carry the label `chase-sets.com/pool=preview` and the taint `chase-sets.com/preview-only=true:NoSchedule`. Staging workloads never tolerate the taint, so they cannot schedule onto preview nodes; the preview deploy path pins preview pods to the pool with the matching toleration plus a `chase-sets.com/pool=preview` nodeSelector.
- Evidence: the `preview_node_pool` Terraform output records the pool posture (name, size, autoscale bounds, taint) for foundation-apply evidence.

## Cluster Preview Scoping (#4864)

Not every PR that reaches `preview-deploy-smoke`'s old gate needs a real `chase-sets-pr-<n>` namespace: at merge-velocity bursts (8-10 simultaneous previews), the fixed-size preview node pool above hit Helm pre-install timeouts (#4861), on top of the DO node-pool cost churn every namespace adds. `scripts/change-scope.mjs`'s `cluster_preview` output (consumed by `.github/workflows/platform-pr.yml`'s `preview-deploy-smoke` job) narrows the trigger to actual deploy surfaces:

- `infrastructure/helm/**` (the chart itself)
- Preview-relevant Terraform (`infrastructure/digitalocean/**` other than the DOKS-only, plan-only root)
- The Dockerfile / `.dockerignore` / any `deployables/*/Dockerfile`
- Deploy and cluster-preview scripts: `scripts/digitalocean-*.mjs`, `scripts/doks-*.mjs`, `scripts/platform-kubernetes-deployment.mjs`, `scripts/platform-kubernetes-secret.mjs`, `scripts/platform-ingress-wait.mjs`, `scripts/render-platform-helm-values.mjs`, `scripts/platform-smoke*.mjs`, `scripts/stripe-money-smoke-test*.mjs`
- Deploy-pipeline workflow files (`.github/workflows/platform-*.yml`)

A PR that only changes app code (bounded contexts, deployables, packages) still needs a docker image built, but instead of a cluster preview it gets the `compose-preview-smoke` job: the same production image booted with `docker compose` (platform-api, platform-worker, and all three web deployables against a real compose Postgres, env rendered by `scripts/platform-compose-smoke.mjs` from the same `buildPlatformHelmValues()` source of truth the Helm chart uses) and driven by the same `scripts/platform-smoke.mjs` the cluster preview runs, through a small path-based proxy (`scripts/platform-compose-ingress.mjs`) standing in for the ingress. It needs no cloud secrets — every value is a local placeholder — so unlike the cluster preview it also runs on fork PRs.

**Escape hatch:** apply the `preview` label to any PR to force the real cluster preview regardless of what changed (it already forces the full battery via `full-battery` resolution in `platform-pr.yml`). Use this when you need to see the change behind a live `pr-N(-marketplace|-admin).preview.chasesets.com` URL, or to debug something the compose stand-in's proxy can't reproduce.

Preview-cleanup (`platform-preview-cleanup.yml`, #4825) is unaffected: it discovers targets from closed/merged PR numbers and a scheduled cluster sweep, never from `change-scope` output, so it keeps reconciling every `chase-sets-pr-*` namespace a cluster preview (or a `preview`-labelled PR) actually created.

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

Use `Platform Staging DOKS Cutover Evidence` (`.github/workflows/platform-staging-doks-cutover-evidence.yml`) to rehearse and prove the cutover without moving live traffic. Dispatch requires the exact confirmation phrase `run staging doks cutover evidence`, a `phase` (`rehearse` targets the `doks.<zone>` shadow hosts, `flip-soak` targets the live hosts after the flip), the DOKS ingress load balancer IPv4 as `ingress_target`, and optionally a `load_balancer_id`. It captures support-safe cutover evidence with `pnpm run cutover:doks-evidence` (which platform served each host, the served TLS certificate chain, and — when a load balancer id is given — load balancer health) and reruns the staging UAT battery (smoke, marketplace critical flows, Buy Now freshness probes, Stripe money smoke) against the phase's DOKS hosts. It uploads `staging-doks-cutover-evidence-<run>-<attempt>` and fails when any host is served by the wrong platform, fails TLS, or is unreachable.

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

## Ingress, Certificates, Argo Rollouts, And Load Balancer

The ingress controller (ingress-nginx), its DigitalOcean Load Balancer, cert-manager, the ACME `ClusterIssuer`s, and Argo Rollouts are installed from the source-owned add-ons in [infrastructure/helm/doks-ingress](../../infrastructure/helm/doks-ingress/README.md). Versions and values stay in git; install through the helper, never ad hoc:

```bash
node ./scripts/doks-cluster-addons.mjs --environment staging --dry-run   # preview pinned commands
DIGITALOCEAN_ACCESS_TOKEN=<token with DNS write access> \
  node ./scripts/doks-cluster-addons.mjs --environment staging           # install / upgrade
node ./scripts/doks-cluster-addons.mjs --environment production --dry-run
```

This installs `ingress-nginx` (namespace `ingress-nginx`) whose `LoadBalancer` Service provisions the `chase-sets-<environment>-doks-ingress` DigitalOcean Load Balancer, `cert-manager` with CRDs (namespace `cert-manager`), the `letsencrypt-staging` / `letsencrypt-production` `ClusterIssuer`s, and the two-replica Argo Rollouts controller with CRDs (namespace `argo-rollouts`). The Argo dashboard is disabled. The load balancer runs L4 pass-through for 80/443 so NGINX terminates TLS with cert-manager certificates; port 80 stays reachable for HTTP-01 challenges and PROXY protocol carries real client IPs.

Confirm the load balancer IPv4 before touching DNS:

```bash
kubectl get service ingress-nginx-controller --namespace ingress-nginx -o wide
kubectl get service --all-namespaces | grep -i loadbalancer
kubectl get clusterissuers
kubectl get deployment --namespace argo-rollouts
kubectl get crd rollouts.argoproj.io analysistemplates.argoproj.io analysisruns.argoproj.io
```

### Preview Wildcard Certificate Bootstrap (One-Time, `--environment staging` Only)

Previews share ONE `*.preview.chasesets.com` TLS certificate instead of each preview namespace issuing its own (#4857); a per-preview issuance design exhausted Let's Encrypt's 50-certificates-per-168h quota during a high-throughput PR day and blocked every PR behind "PR Required" for three hours. Only the staging DOKS cluster hosts previews, so this bootstrap is scoped to `--environment staging` and is a normal part of `doks-cluster-addons.mjs`:

```bash
DIGITALOCEAN_ACCESS_TOKEN=<token with DNS write access> \
  node ./scripts/doks-cluster-addons.mjs --environment staging
```

In addition to the ingress-nginx/cert-manager/ClusterIssuer steps above, a staging run:

1. Applies the `digitalocean-dns-token` Secret (key `access-token`, from `DIGITALOCEAN_ACCESS_TOKEN`) into the `cert-manager` namespace by piping the manifest to `kubectl apply -f -` stdin — the token never appears in a command argument or in `--dry-run` output. This is the credential cert-manager's DNS-01 solver uses to create/delete the `_acme-challenge.preview.chasesets.com` TXT record during issuance.
2. Renders `previewWildcardCertificate.enabled=true` on the `letsencrypt-production` `ClusterIssuer` release, which adds a `Certificate` for `*.preview.chasesets.com` (secret name `preview-wildcard-tls`) in the `cert-manager` namespace, issued through a DNS-01 solver scoped (via `selector.dnsZones`) to only the `preview.chasesets.com` zone — every other certificate this issuer signs keeps using the existing HTTP-01 solver, unaffected.

This bootstrap is idempotent: re-running it re-applies the same Secret and Certificate spec, which is a no-op once the token is current and the certificate is issued. Re-run it whenever the DigitalOcean token rotates.

The production add-on run applies the same Secret safely over stdin but scopes its DNS-01 solver to `chasesets.com` and does not render the preview wildcard Certificate. That solver exists only so #4053 can issue the production live-and-shadow certificate before live DNS moves.

The DNS wildcard that routes browser/client traffic to the load balancer is a separate, equally one-time step (DNS-01 issuance itself needs no A record — it proves ownership via a TXT record — but real preview traffic does):

```bash
DIGITALOCEAN_ACCESS_TOKEN=<token> \
  node ./scripts/digitalocean-preview-cleanup-sweep.mjs apply-shared-dns --target <load-balancer-ipv4>
```

This is also idempotent (a no-op if the wildcard A record already points at the given target) and only needs re-running if the load balancer IP changes.

Diagnose a stuck or retrying issuance in the `cert-manager` namespace (not a preview namespace):

```bash
kubectl describe certificate preview-wildcard -n cert-manager
kubectl describe order -n cert-manager
```

A `rateLimited` order retries automatically until it succeeds; that is expected, not an incident.

Application `Ingress` objects (platform chart) publish through `ingressClassName: nginx` with the `cert-manager.io/cluster-issuer` annotation and are enabled at cutover, not before.

Inspection:

```bash
kubectl get ingress --namespace chase-sets-platform
kubectl describe ingress --namespace chase-sets-platform
kubectl get certificates,orders,challenges --namespace chase-sets-platform
```

### Proportional Rollout Evidence (Staging First)

Staging enables Rollouts in `values.staging.yaml`; previews remain Deployments. The deploy workflow holds `public-web`, `marketplace`, and `platform-api` at 10% after canary-Service readiness analysis. Its existing smoke, projection-convergence, Buy Now freshness, and Stripe money gates are the promotion decision. A green tail advances through analyzed 25%, 50%, and 100% steps; a failed tail runs `abort` before normal incident classification.

For the staging evidence attached to the rollout PR/issue:

1. Run both add-on dry runs, then install/upgrade the staging add-ons from an approved operator session. Confirm the controller Deployment and three CRDs above are ready.
2. Confirm `DOKS_INGRESS_TARGET` is set and the shadow or live DOKS hosts pass `platform-ingress-wait`; proportional routing intentionally refuses to render without DOKS ingress.
3. Dispatch Platform Deploy for a reviewed staging revision. While it is held, capture:

   ```bash
   kubectl get rollouts,analysisruns --namespace chase-sets-platform
   kubectl get ingress --namespace chase-sets-platform -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.nginx\.ingress\.kubernetes\.io/canary-weight}{"\n"}{end}'
   kubectl argo rollouts get rollout chase-sets-platform-chase-sets-platform-marketplace --namespace chase-sets-platform
   ```

   Expected: the new revision is paused after successful readiness analysis, and the controller-generated canary Ingress reports weight `10`.
4. Let the workflow verification tail finish. Confirm all three Rollouts become `Healthy`, the production job begins only after staging promotion, and the release-health artifact retains the existing smoke/freshness decisions.
5. Rehearse failure only in a controlled staging window: temporarily patch one generated `AnalysisTemplate` to an unreachable canary URL, deploy a new staging revision, and verify its AnalysisRun becomes `Failed`, the Rollout becomes `Degraded`/aborted, and nginx returns the canary weight to `0`. Immediately restore the source-owned template with the next Helm deploy and verify `Healthy`. Never perform this drill in production and never replace it with a fake metrics provider in committed configuration.

Production remains a separate operator flip. After #4053 has installed the production add-ons, proven production DOKS ingress on internal/shadow hosts, and completed the DNS rollback rehearsal, set the production GitHub Environment variable `PRODUCTION_ARGO_ROLLOUTS_ENABLED=true`. Leave it absent/false before that cutover; Helm fails closed if the flip requests nginx proportional routing without an enabled DOKS Ingress.

## DNS Cutover And Rehearsed Rollback

The cutover keeps **both platforms serving** and makes the flip an instant, reversible DNS change. App Platform is kept warm through the entire staging soak and the production low-signup window (#4053) so rollback is always a DNS-only step. Two coordinated controls drive it across [environment-dns](../../infrastructure/digitalocean/environment-dns/README.md) and [platform](../../infrastructure/digitalocean/platform):

- `doks_ingress_target` (load balancer IPv4) creates the **shadow validation hosts** `doks.staging.chasesets.com`, `www.doks.…`, `marketplace.doks.…`, `admin.doks.…`. DOKS serves and issues certificates on these while App Platform serves the live hosts. No live traffic moves.
- `staging_app_serving=doks` makes the `platform` root replace the live leaf CNAMEs with `A` records and release App Platform's apex attachment before creating the apex `A`.

### 1. Rehearse (both platforms serving)

1. Install the add-ons and confirm a stable load balancer IPv4.
2. Apply environment-dns with `doks_ingress_target=<lb-ip>` (leave `staging_app_serving=app-platform`). Only the shadow hosts appear; App Platform still owns every live host.
3. Prove the DOKS pipeline against the shadow hosts:

   ```bash
   node ./scripts/platform-ingress-wait.mjs \
     --url https://doks.staging.chasesets.com/ \
     --url https://admin.doks.staging.chasesets.com/health/ready \
     --url https://marketplace.doks.staging.chasesets.com/health/ready
   ```

4. Confirm `Certificate` resources are `Ready` and cert-manager `Order`/`Challenge` completed.
5. Prove the DOKS pipeline end-to-end and capture support-safe cutover evidence by dispatching `Platform Staging DOKS Cutover Evidence` with `phase=rehearse`, `ingress_target=<lb-ip>`, and the confirmation phrase. It reruns the full staging UAT battery against the `doks.<zone>` shadow hosts and records, per host, which platform served it (resolved address vs the load balancer target), the served TLS certificate chain, and load balancer health. Sign the parity checklist off in #4050 from the uploaded `staging-doks-cutover-evidence-<run>-<attempt>` artifact.

### 2. Flip (instant cutover)

1. Apply environment-dns with `doks_ingress_target=<lb-ip>` and `staging_app_serving=doks` to retain the shadow validation records and validate the coordinated target. It does not own live serving records.
2. Apply the platform root with the same values. One dependency graph destroys each `www`/`marketplace`/`admin` CNAME before creating its replacement `A`, releases the App Platform live-domain attachments, and then creates the apex `A` at the load balancer.
3. Wait for HTTPS probes on the live hosts:

   ```bash
   node ./scripts/platform-ingress-wait.mjs \
     --url https://staging.chasesets.com/ \
     --url https://admin.staging.chasesets.com/health/ready \
     --url https://marketplace.staging.chasesets.com/health/ready
   ```

4. Run the staging UAT battery. Re-prove the cut-over surface by dispatching `Platform Staging DOKS Cutover Evidence` with `phase=flip-soak` and the same `ingress_target`; it runs the battery and captures cutover evidence against the live hosts now served by DOKS. Keep TTL low (`doks_ingress_ttl`, 300s default) until confidence is recorded.

### 3. Rollback (rehearsed)

1. Flip `staging_app_serving` back to `app-platform` in both roots and apply. The platform dependency graph removes the DOKS apex/leaf records before restoring the App Platform domain attachments and leaf CNAMEs.
2. Confirm HTTPS probes pass against App Platform and record the rollback evidence.

Because App Platform never left, rollback is a single Terraform graph change — no redeploy. The shadow hosts stay in place, so the next flip attempt needs no re-rehearsal.

### Production

Production live hosts in the root `chasesets.com` zone remain owned by the platform root. The `environment-dns/production.tfstate` state owns only shadow records. `PRODUCTION_APP_SERVING` defaults to `app-platform`; `PRODUCTION_DOKS_INGRESS_TARGET` defaults empty; `PRODUCTION_DOKS_CERTIFICATE_READY` defaults false. Never reuse the repo-level staging `DOKS_INGRESS_TARGET`.

Production differs from the staging rehearsal in one deliberate way: its Ingress keeps both shadow and live host rules warm, and one explicit DNS-01 `Certificate` covers both sets. The marketplace pair is omitted while `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false`. This makes certificate issuance finish before the live-record flip and avoids the cert-manager NXDOMAIN/post-flip issuance race.

#### Phase B: prepare add-ons and the dedicated target

1. On merged `main`, let the production deploy install the production ingress-nginx, cert-manager, DNS-01 solver, and Argo add-ons. If CI cannot install them, configure the production context and run the same idempotent helper directly:

   ```bash
   doctl kubernetes cluster kubeconfig save chase-sets-production-doks --expiry-seconds 900
   DIGITALOCEAN_ACCESS_TOKEN="$DIGITALOCEAN_ACCESS_TOKEN" \
     node ./scripts/doks-cluster-addons.mjs --environment production
   ```

2. Record the new load balancer and require `active` status:

   ```bash
   read -r LB_ID LB_IP LB_STATUS < <(
     doctl compute load-balancer list \
       --format ID,IP,Name,Status --no-header \
       | awk '$3 == "chase-sets-production-doks-ingress" { print $1, $2, $4 }'
   )
   test -n "$LB_ID" && test -n "$LB_IP" && test "$LB_STATUS" = "active"
   printf 'production ingress lb id=%s ip=%s status=%s\n' "$LB_ID" "$LB_IP" "$LB_STATUS"
   ```

3. Publish only the target; explicitly retain App Platform and the closed certificate gate:

   ```bash
   gh variable set PRODUCTION_DOKS_INGRESS_TARGET --env production --body "$LB_IP"
   gh variable set PRODUCTION_APP_SERVING --env production --body app-platform
   gh variable set PRODUCTION_DOKS_CERTIFICATE_READY --env production --body false
   gh variable get PRODUCTION_MARKETPLACE_PUBLIC_ENABLED --env production
   # Expected: false. Do not alter the runtime profile, exposure flags, or secrets.
   ```

#### Phase B: go-live toggle sequence

The serving flip must reproduce the runtime behavior already active on App Platform. `values.production.yaml` is generated from Terraform's `local.production_runtime_parity_env`, so the rehearsal and flip use this exact parity posture:

| Runtime contract | Phase B DOKS value | Cutover treatment |
| --- | --- | --- |
| Catalog control / activation | `dry-run-only` / `test-profiles-only` | Preserve the restricted App Platform posture. |
| Catalog import / promotion / reapply disabled providers | `mtgjson,scryfall,tcgplayer` for all three | Keep provider operations closed; the serving switch is not catalog activation. |
| Public indexing | `true` | Match current production behavior; do not change crawler exposure during cutover. |
| Realtime background maintenance / wake signal | `true` / `true` | Match current production behavior; do not combine a realtime rollout with the serving switch. |
| Event-store wake notifications / worker wake relay | `true` / `true` | Transfer the already-active wake loop to the DOKS worker without creating a second behavior change. |
| Projection wake source contexts | `public-presence` | Preserve the current bounded production source set; do not expand it during cutover. |

Sequence these deliberately:

1. Before rehearsal, verify the generated production overlay still has every value above. Treat any difference from `local.production_runtime_parity_env` as a blocker.
2. During rehearsal and the serving flip, change only the target, certificate gate, and `PRODUCTION_APP_SERVING`. Do not change public indexing, the realtime set, wake signaling, or projection sources.
3. Defer every launch-only transition to the launch runbook: public-indexing exposure changes require the launch SEO/crawler gate; realtime maintenance/wake changes require their own capacity and rollback evidence; projection wake-source expansion requires connection-budget and convergence evidence. If the launch posture retains a current value, record that as an explicit no-op there rather than silently inheriting it.

This separation is intentional: matching an already-active App Platform value on DOKS is cutover parity, while changing that value is a launch decision with a different rollback surface.

#### Phase B: rehearse and issue the certificate before the flip

1. Dispatch `Platform Deploy` from `main`. With serving still `app-platform`, the production job applies `environment-dns/production.tfstate` to create only the applicable shadow A records, deploys both shadow and live Ingress rules, and waits for the DNS-01 certificate plus shadow HTTPS probes:

   ```bash
   gh workflow run platform-production.yml --ref main
   RUN_ID="$(gh run list --workflow platform-production.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   gh run watch "$RUN_ID" --exit-status
   ```

2. Reconfirm certificate and ingress evidence directly. Do not continue unless the certificate is `Ready=True`, every required live/shadow DNS name is present, shadow HTTPS is green, and unresolved Orders/Challenges are zero:

   ```bash
   kubectl wait --namespace chase-sets-platform --for=condition=Ready \
     certificate/chase-sets-platform-doks-tls --timeout=10m
   kubectl get certificate/chase-sets-platform-doks-tls \
     --namespace chase-sets-platform -o jsonpath='{.spec.dnsNames}{"\n"}{.status.conditions}{"\n"}'
   kubectl get orders.acme.cert-manager.io,challenges.acme.cert-manager.io \
     --namespace chase-sets-platform
   node ./scripts/platform-ingress-wait.mjs \
     --url https://doks.chasesets.com/ \
     --url https://www.doks.chasesets.com/ \
     --url https://admin.doks.chasesets.com/health/ready
   ```

3. Retain the rehearsal run link: its `Smoke check` creates a synthetic production waitlist signup and verifies the admin read model. This is the before-flip signup evidence.

#### Phase B: flip and verify

1. Open the certificate gate, then change only the serving switch:

   ```bash
   gh variable set PRODUCTION_DOKS_CERTIFICATE_READY --env production --body true
   gh variable set PRODUCTION_APP_SERVING --env production --body doks
   ```

2. Dispatch and watch `Platform Deploy`. The production job rechecks the ready certificate and shadow HTTPS **before** `terraform apply`; the platform apply changes App Platform's desired domain set from the live hosts to `app-platform.chasesets.com`. The leaf A resources depend on that completed update, and the apex A depends on the leaves, so App Platform has released its provider-managed DNS records before DOKS record creation begins. App Platform and its parked fallback routes remain intact.

   ```bash
   gh workflow run platform-production.yml --ref main
   FLIP_RUN_ID="$(gh run list --workflow platform-production.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   gh run watch "$FLIP_RUN_ID" --exit-status
   ```

3. Verify live resolution, TLS/readiness, the production smoke and stage-1 canary steps, and the post-flip synthetic waitlist signup/admin read from the flip run:

   ```bash
   for host in chasesets.com www.chasesets.com admin.chasesets.com; do
     test "$(dig +short A "$host" | tail -n 1)" = "$LB_IP"
   done
   node ./scripts/platform-ingress-wait.mjs \
     --url https://chasesets.com/ \
     --url https://www.chasesets.com/ \
     --url https://admin.chasesets.com/health/ready
   gh run view "$FLIP_RUN_ID" --json jobs \
     --jq '.jobs[] | select(.name == "Deploy Production") | .steps[] | select(.name == "Smoke check" or .name == "Stage 1 production canary") | [.name,.conclusion] | @tsv'
   ```

The three-day soak clock begins only after these probes and both workflow steps are green. Keep App Platform, the target, shadow records, certificate, and marketplace-off posture unchanged for the whole soak.

#### Phase B: DNS-only rollback

Rollback is the serving variable re-flip after the separate `prepare-app-platform` TTL phase has aged. Leave the ingress target and ready certificate in place so the shadow/live DOKS path stays warm. The dependency graph deletes the DOKS apex and leaf A records before changing the App Platform domain set from the parking host back to the live hosts; App Platform then recreates its provider-managed apex and CNAME records:

```bash
gh variable set PRODUCTION_APP_SERVING --env production --body app-platform
gh workflow run platform-production.yml --ref main
ROLLBACK_RUN_ID="$(gh run list --workflow platform-production.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$ROLLBACK_RUN_ID" --exit-status
node ./scripts/platform-ingress-wait.mjs \
  --url https://chasesets.com/ \
  --url https://www.chasesets.com/ \
  --url https://admin.chasesets.com/health/ready
for host in chasesets.com www.chasesets.com admin.chasesets.com; do
  test "$(dig +short A "$host" | tail -n 1)" != "$LB_IP"
done
```

Do not disable/delete the App Platform app, remove its components, clear the target/certificate, or destroy any infrastructure here. Those actions belong to #5171/#4055 after the separately approved soak gate.

Certificate incidents:

- If `Certificate` is pending, inspect cert-manager `Order` and `Challenge` resources before changing DNS.
- If HTTP-01 challenges fail, confirm the Ingress class, host, DNS target, PROXY protocol config, and any redirect middleware.
- If production cert issuance fails during cutover, pause the flip and keep App Platform serving until certificate evidence is green.

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
