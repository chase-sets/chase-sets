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

## Validation

The Platform PR workflow renders and validates this chart when Helm files change:

```bash
docker run --rm -v "${PWD}:/repo" -w /repo alpine/helm:3.15.4 lint infrastructure/helm/platform
docker run --rm -v "${PWD}:/repo" -w /repo alpine/helm:3.15.4 template chase-sets-platform infrastructure/helm/platform > platform-helm-rendered.yaml
docker run --rm -v "${PWD}:/work" -w /work ghcr.io/yannh/kubeconform:v0.6.7 -strict -summary platform-helm-rendered.yaml
```

## Boundaries

This scaffold intentionally does not own ingress, certificates, external secrets, rollout strategy, live DOKS apply wiring, or App Platform removal.

`platform-bootstrap` renders as a Helm `pre-install,pre-upgrade` hook. Before running bootstrap it scales the worker Deployment targets to zero through the in-image `bootstrap-quiesce.mjs` wrapper, waits for those pods to drain, then runs the existing bootstrap command. If bootstrap fails, the wrapper restores the previous worker replica counts before returning the failing exit code so Helm aborts before new pods roll. During first install, missing worker Deployments are skipped because there is no outgoing version to quiesce yet.
