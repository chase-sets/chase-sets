# Platform Helm Chart

This chart is the first renderable Kubernetes scaffold for the Chase Sets platform runtime components accepted by milestone #103 and issue #4047.

It is the canonical runtime topology for the DOKS deploy target:

- `public-web`
- `marketplace`
- `admin-web`
- `platform-api`
- `platform-worker`
- `platform-bootstrap`

`runtime-values.json` is the checked-in source for component commands, ports, routes, probes, and environment-key contracts. `values.yaml` is generated from it as the preview-safe baseline. `values.staging.yaml` is generated alongside it for staging-only component overrides, including representative platform-worker wake capacity and the horizontally scaled, explicitly resourced platform API.

```bash
node ./scripts/render-platform-helm-values.mjs
```

Run the freshness check before opening a PR:

```bash
node ./scripts/render-platform-helm-values.mjs --check
```

## Runtime Secrets

Pods read sensitive environment variables from the existing Kubernetes Secret named by `global.existingSecretName` (`chase-sets-platform-runtime` by default). The chart intentionally does not render a Secret manifest, ExternalSecret, or sealed-secret payload because the DOKS migration keeps secret values out of git and Terraform state.

Apply or rotate the runtime Secret from CI after the target cluster context is selected:

```bash
node ./scripts/platform-kubernetes-secret.mjs --namespace staging
```

The script derives required keys from this chart's `secret: true` env entries, reads the matching process environment variables, base64-encodes them in memory, and pipes the Secret manifest to `kubectl apply -f -`. It logs only the Secret name and key count. Use the dry run for rotation planning without printing values:

```bash
node ./scripts/platform-kubernetes-secret.mjs --dry-run --namespace staging
```

After a rotation applies, rerun the Helm upgrade or restart the affected runtime Deployments so pods reload environment variables from the updated Secret.

For staging and production, the secret helper also derives the collector-only `CHASE_SETS_OTLP_TOKEN` key in memory from the existing `OTEL_EXPORTER_OTLP_HEADERS` value. It never logs either value. Preview releases do not receive that key because cluster collection is disabled there.

## Kubernetes Observability

Staging and production Helm upgrades enable the in-cluster observability topology automatically when `OBSERVABILITY_ENABLED` is not `false`:

- an OpenTelemetry Collector DaemonSet accepts pod OTLP and collects kubelet node/pod/container usage;
- one cluster Collector Deployment runs a kube-state-metrics sidecar and exports a bounded cluster-health metric set;
- both paths upsert `deployment.environment`, `k8s.cluster.name`, and `chase_sets.observability_stack=single-shared-stack` before forwarding to the secured shared Droplet;
- application pods export to the internal Collector Service rather than directly across the public endpoint.

Preview namespaces do not install collectors or kube-state-metrics. The cluster metric relabel contract drops UID, container-image, and container-id labels before export.

## Ingress

`doksIngress` is disabled in the preview-safe baseline. Staging and production deploys enable it when `DOKS_INGRESS_TARGET` is set and use the live host set:

```yaml
doksIngress:
  enabled: true
  className: nginx
  clusterIssuer: letsencrypt-production
  tls:
    enabled: true
    secretName: chase-sets-platform-doks-tls
  hosts:
    - host: doks.staging.chasesets.com
      paths:
        - path: /.well-known
          service: platform-api
        - path: /ucp
          service: platform-api
        - path: /mcp
          service: platform-api
        - path: /api
          service: platform-api
        - path: /
          service: marketplace
    - host: www.doks.staging.chasesets.com
      paths:
        - path: /api
          service: platform-api
        - path: /
          service: public-web
    - host: marketplace.doks.staging.chasesets.com
      paths:
        - path: /api
          service: platform-api
        - path: /
          service: marketplace
    - host: admin.doks.staging.chasesets.com
      paths:
        - path: /api
          service: platform-api
        - path: /
          service: admin-web
```

The live staging hosts are the apex plus `www`, `marketplace`, and `admin`. The chart renders one `Ingress` and one SAN `Certificate` for that host set. Provider webhook, MCP, UCP, well-known, and `/api` paths stay routed to `platform-api` before the web catch-all. The matching DNS records live in `infrastructure/digitalocean/environment-dns` and remain disabled until a DOKS load balancer target is known.

## Health Probes

Readiness and liveness are deliberately different checks with a single source of truth each in `templates/_helpers.tpl`:

- **Readiness always probes `healthPath`** (`/health/ready` for `platform-api`, `platform-worker`, `admin-web`, and `marketplace`; `/` for `public-web`), which is DB-aware. This gates traffic and rollout progress and is unchanged by #4765.
- **Liveness probes `livenessPath` when a component sets one, else falls back to `healthPath`.** `livenessPath` is independent of `startupPath` (which only controls whether a `startupProbe` exists, i.e. a boot-grace window — it no longer implies a liveness path).

`platform-api` and `platform-worker` are the only components verified (by reading their server source — `infrastructure/platform-runtime/health.ts` mounted at `/health` for the API, `deployables/platform-worker/src/main.ts` for the worker) to serve a DB-free `/health/live` endpoint. Both get, **in the base chart** (`values.yaml`, so this applies to every environment — preview, staging, and production):

```yaml
startupPath: "/health/live"
livenessPath: "/health/live"
livenessProbe:
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 6
```

`admin-web`, `marketplace`, and `public-web` each register only a `health/ready` route today (no `/health/live`), so their liveness intentionally keeps falling back to `healthPath` unchanged.

**Production behavior change (#4765):** before this fix, `platform-api`'s liveness silently defaulted to the DB-aware `/health/ready` check with Kubernetes' default timing (`timeout=1s period=10s failureThreshold=3`) in every environment including production, so a slow database or a briefly-busy event loop could kill a healthy pod (`Exit Code 137`, `kubelet: Container platform-api failed liveness probe`). This was proven live in preview namespace `chase-sets-pr-4766` and broke that PR's own "Stripe money smoke" step with 502/503s. With this change, production pods stop being killed by DB slowness: liveness now probes the DB-free `/health/live` endpoint with a tolerant ~60-second failure window, and only a genuinely hung process (not a slow database) triggers a restart. Traffic gating is unaffected because readiness is untouched.

The staging-only overlay (`values.staging.yaml`, via `doksStagingApiOverrides`) no longer duplicates this — it now only carries `replicas: 2` and the explicit CPU/memory envelope for `platform-api`; the tolerant liveness config is inherited from the base chart through the Helm `-f values.yaml -f values.staging.yaml` merge.

## Rollouts

Staging renders Argo `Rollout` resources for the three public traffic owners: `public-web`, `marketplace`, and `platform-api`. Preview and production values remain ordinary `Deployment` resources unless their deploy lane passes `--rollouts-enabled true`.

Each Rollout keeps the existing component Service as stable, adds a canary Service, and owns a component-specific stable Ingress. Isolating routes is required: cloning the former shared multi-service Ingress would apply nginx canary annotations to unrelated paths and couple independently progressing components. The controller shifts 10%, runs three checks against the canary Service's existing JSON readiness endpoint, and pauses. After CI smoke, projection convergence, Buy Now freshness, and money smoke pass, the workflow promotes the hold; 25%, 50%, and 100% each repeat the readiness analysis. One failed measurement aborts the update, and a three-revision rollback window lets the Helm restore-point flow fast-track recent stable revisions.

Rollout activation fails Helm rendering unless DOKS ingress is enabled; this prevents a rollout from claiming proportional exposure while no traffic router exists. Production remains gated by the `PRODUCTION_ARGO_ROLLOUTS_ENABLED` GitHub Environment variable.

## Validation

The Platform PR workflow renders and validates this chart, the runtime Secret contract, and the ingress wait contract when Helm, Secret-delivery, or ingress-wait files change:

```bash
docker run --rm -v "${PWD}:/repo" -w /repo alpine/helm:3.15.4 lint infrastructure/helm/platform
docker run --rm -v "${PWD}:/repo" -w /repo alpine/helm:3.15.4 template chase-sets-platform infrastructure/helm/platform > platform-helm-rendered.yaml
docker run --rm -v "${PWD}:/work" -w /work ghcr.io/yannh/kubeconform:v0.6.7 -strict -summary platform-helm-rendered.yaml
```

## Local Boot Proof

Use the local boot harness to prove the chart workloads start through Kubernetes scheduling before a live DOKS cutover. The harness derives from `values.yaml`, swaps only local-dev-safe image, command, and secret placeholders, renders this chart with Helm, applies the manifest to a throwaway namespace, and waits for every rendered Deployment and Job.

Dry-run the rendered local boot contract without touching a cluster:

```bash
pnpm run platform:helm-local-boot -- --dry-run
```

Run the proof against the current `kubectl` context:

```bash
pnpm run platform:helm-local-boot -- --namespace chase-sets-platform-local-boot
```

The harness uses the Dockerized Helm image `alpine/helm:3.15.4`, so a local `helm` binary is not required. A reachable Kubernetes context is required for the non-dry-run proof.

## Deployment Helper

`platform:kubernetes-deployment` is the DOKS deploy workflow helper. It provides the deploy, wait, diagnostics, rollback, and secret-rotation command contract:

```bash
pnpm run platform:kubernetes-deployment -- plan --image registry.digitalocean.com/chase-sets/chase-sets-platform:<tag> --namespace staging --release chase-sets-staging
pnpm run platform:kubernetes-deployment -- deploy --image registry.digitalocean.com/chase-sets/chase-sets-platform:<tag> --namespace staging --release chase-sets-staging --runtime-env DEPLOYMENT_ENVIRONMENT=staging --rollouts-enabled true
pnpm run platform:kubernetes-deployment -- promote --namespace staging --release chase-sets-staging --rollouts-enabled true
pnpm run platform:kubernetes-deployment -- abort --namespace staging --release chase-sets-staging --rollouts-enabled true
pnpm run platform:kubernetes-deployment -- rollback --namespace staging --release chase-sets-staging --rollouts-enabled true
pnpm run platform:kubernetes-deployment -- diagnostics --namespace staging --release chase-sets-staging
```

Deploy uses `helm upgrade --install --wait --atomic`, waits for ordinary Deployments through `kubectl rollout status`, and waits for Argo Rollouts to reach the 10% analysis hold. `promote` and `abort` use the pinned Argo kubectl plugin; promotion then waits for `Healthy`. Helm rollback detects whether the restored revision contains a Rollout or Deployment before waiting, so rollback targets captured before Argo activation remain valid. Diagnostics include Rollouts and AnalysisRuns in addition to Kubernetes workloads, descriptions, events, and pod logs.

## Boundaries

This chart intentionally does not own ingress controller installation, certificate issuer installation, or external secrets. The cluster-scoped Argo controller contract lives with the other DOKS add-ons in `scripts/doks-cluster-addons.mjs`.

`platform-bootstrap` renders as a Helm `pre-install,pre-upgrade` hook. Before running bootstrap it scales the worker Deployment targets to zero through the in-image `bootstrap-quiesce.mjs` wrapper, waits for those pods to drain, then runs the existing bootstrap command. If bootstrap fails or exceeds `CHASE_SETS_BOOTSTRAP_COMMAND_TIMEOUT_SECONDS`, the wrapper restores the previous worker replica counts before returning the failing exit code so Helm aborts before new pods roll. The hook Job uses `activeDeadlineSeconds` below Helm's rollout timeout so Kubernetes reports a Job failure before Helm reaches its generic condition timeout. During first install, missing worker Deployments are skipped because there is no outgoing version to quiesce yet.
