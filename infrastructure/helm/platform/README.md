# Platform Helm Chart

This chart is the first renderable Kubernetes scaffold for the Chase Sets platform runtime components accepted by milestone #103 and issue #4047.

It mirrors the current DigitalOcean App Platform component topology:

- `public-web`
- `marketplace`
- `admin-web`
- `platform-api`
- `platform-worker`
- `platform-bootstrap`

`values.yaml` is generated from the existing App Platform Terraform shape and stays the preview-safe baseline. `values.staging.yaml` is generated alongside it for DOKS staging-only component overrides, including representative platform-worker wake capacity.

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

## Ingress

`doksIngress` is disabled by default while App Platform still owns public routing. Staging deploys enable it only when `DOKS_INGRESS_TARGET` is set; the render/deploy values use the `STAGING_APP_SERVING` flag to choose the active host set:

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

When `STAGING_APP_SERVING=app-platform`, hosts are the `doks.<zone>` shadow validation names. When it flips to `doks`, hosts become the live staging apex plus `www`, `marketplace`, and `admin`. The chart renders one `Ingress` and one SAN `Certificate` for the active host set. Provider webhook, MCP, UCP, well-known, and `/api` paths stay routed to `platform-api` before the web catch-all. The matching DNS records live in `infrastructure/digitalocean/environment-dns` and remain disabled until a DOKS load balancer target is known.

## Rollouts

Argo Rollouts are scaffolded as an opt-in chart capability for the two user-facing web components only:

- `public-web`
- `marketplace`

The default chart still renders Kubernetes `Deployment` resources for every service and worker. `public-web` and `marketplace` values include a disabled `rollout` block so CI can prove the manifest shape before DOKS owns traffic. When a component's `rollout.enabled` is set to `true`, that component renders an Argo `Rollout` instead of a `Deployment`, keeps the existing component Service as the stable service, and renders an additional canary Service with the configured suffix.

Do not enable this in staging or production until Argo Rollouts, nginx ingress traffic routing, the DOKS deploy helper, and staging cutover evidence are all in place. Current production "canary" checks remain post-deploy synthetic smoke against the single deployed App Platform release; proportional Rollouts are reserved for beta-wave exposure control after DOKS cutover.

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

`platform:kubernetes-deployment` is the DOKS deploy workflow helper for issue #4049. It provides the command contract that replaces App Platform deploy/wait/diagnostics calls:

```bash
pnpm run platform:kubernetes-deployment -- plan --image registry.digitalocean.com/chase-sets/chase-sets-platform:<tag> --namespace staging --release chase-sets-staging
pnpm run platform:kubernetes-deployment -- deploy --image registry.digitalocean.com/chase-sets/chase-sets-platform:<tag> --namespace staging --release chase-sets-staging
pnpm run platform:kubernetes-deployment -- rollback --namespace staging --release chase-sets-staging
pnpm run platform:kubernetes-deployment -- diagnostics --namespace staging --release chase-sets-staging
```

Deploy uses `helm upgrade --install --wait --atomic`, then waits for every rendered runtime Deployment through `kubectl rollout status`. Rollback uses `helm rollback --wait`, then reuses the same rollout waits. Diagnostics use Kubernetes resources, descriptions, and pod logs; they do not depend on App Platform state.

## Boundaries

This scaffold intentionally does not own ingress controller installation, certificate issuer installation, external secrets, Argo Rollouts controller installation, live DOKS apply wiring, or App Platform removal.

`platform-bootstrap` renders as a Helm `pre-install,pre-upgrade` hook. Before running bootstrap it scales the worker Deployment targets to zero through the in-image `bootstrap-quiesce.mjs` wrapper, waits for those pods to drain, then runs the existing bootstrap command. If bootstrap fails or exceeds `CHASE_SETS_BOOTSTRAP_COMMAND_TIMEOUT_SECONDS`, the wrapper restores the previous worker replica counts before returning the failing exit code so Helm aborts before new pods roll. The hook Job uses `activeDeadlineSeconds` below Helm's rollout timeout so Kubernetes reports a Job failure before Helm reaches its generic condition timeout. During first install, missing worker Deployments are skipped because there is no outgoing version to quiesce yet.
