# Platform Helm Chart

This chart is the first renderable Kubernetes scaffold for the Chase Sets platform runtime components accepted by milestone #103 and issue #4047.

It mirrors the current DigitalOcean App Platform component topology:

- `public-web`
- `marketplace`
- `admin-web`
- `platform-api`
- `platform-worker`
- `platform-bootstrap`

`values.yaml` is generated from the existing App Platform Terraform shape:

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

Ingress is disabled by default while App Platform still owns public routing. Enable it only after the DOKS ingress controller and cert-manager issuer exist:

```yaml
ingress:
  enabled: true
  className: nginx
  clusterIssuer: letsencrypt-production
  hosts:
    - host: staging.chasesets.com
      paths:
        - path: /api
          service: platform-api
        - path: /
          service: marketplace
    - host: www.staging.chasesets.com
      paths:
        - path: /api
          service: platform-api
        - path: /
          service: public-web
    - host: marketplace.staging.chasesets.com
      paths:
        - path: /api
          service: platform-api
        - path: /
          service: marketplace
    - host: admin.staging.chasesets.com
      paths:
        - path: /api
          service: platform-api
        - path: /
          service: admin-web
```

Provider webhook, MCP, UCP, and well-known paths should stay routed to `platform-api` before DNS cutover. The matching DNS cutover records live in `infrastructure/digitalocean/environment-dns` and remain disabled until a DOKS load balancer target is known.

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

## Boundaries

This scaffold intentionally does not own ingress controller installation, certificate issuer installation, external secrets, Argo Rollouts controller installation, live DOKS apply wiring, or App Platform removal.

`platform-bootstrap` renders as a Helm `pre-install,pre-upgrade` hook. Before running bootstrap it scales the worker Deployment targets to zero through the in-image `bootstrap-quiesce.mjs` wrapper, waits for those pods to drain, then runs the existing bootstrap command. If bootstrap fails, the wrapper restores the previous worker replica counts before returning the failing exit code so Helm aborts before new pods roll. During first install, missing worker Deployments are skipped because there is no outgoing version to quiesce yet.
