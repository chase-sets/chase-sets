# Platform Helm Chart

This chart is the canonical DOKS runtime definition for the Chase Sets platform. It owns web, API, worker, bootstrap, runtime-secret, service, ingress, health, and rollout configuration. Durable DigitalOcean resources remain in their Terraform roots.

## Runtime Values

`runtime-values.json` is the checked-in, reviewable component and environment-key contract. `scripts/render-platform-helm-values.mjs` renders it into the chart baseline and adds environment overlays:

- `values.yaml` — preview-safe defaults;
- `values.staging.yaml` — staging capacity and public routes; and
- `values.production.yaml` — production capacity and runtime-profile controls.

Validate the generated contract with:

```bash
node scripts/render-platform-helm-values.mjs --check
pnpm exec vitest run scripts/render-platform-helm-values.test.mjs
```

The renderer must not read Terraform application configuration. Database endpoints and credentials enter Kubernetes through the environment-specific Secret exporter in the deployment workflow.

## Ingress And TLS

DOKS ingress always serves the live environment hostnames when `doksIngress.enabled=true`. The apex and `www` route to `public-web`, `admin` routes to `admin-web`, and marketplace hosts are rendered only when marketplace public exposure is enabled. Provider webhooks, MCP, UCP, well-known, and `/api` paths route to `platform-api` before web catch-alls.

Staging uses cert-manager HTTP-01 for its live host certificate. Production uses the environment DNS-01 issuer for the live host set. Diagnostic `doks.*` hostnames are deliberately not routed or added to runtime certificates.

Preview namespaces use `pr-<number>.preview.chasesets.com` and copy the shared `preview-wildcard-tls` Secret from `cert-manager`; previews never request one certificate per PR.

## Deploy And Rollback

`scripts/platform-kubernetes-deployment.mjs` is the workflow command contract. It renders values, applies secrets, runs the Helm upgrade, waits for workloads and ingress, captures diagnostics, and provides release-health-compatible rollback targets.

The bootstrap component runs as a Helm hook and uses direct `BOOTSTRAP_*` database URLs for its session advisory lock. The API and worker use the query/listener topology exported from the durable platform root. Argo Rollouts remain environment-gated; enabling proportional exposure without DOKS ingress is rejected during rendering.

Cluster-scoped ingress, cert-manager, Argo Rollouts, and issuer resources live in [doks-ingress](../doks-ingress/README.md). Operator procedures live in [DOKS Platform Operations](../../../docs/runbooks/doks-platform-operations.md).

## Boundaries

This chart does not own the Kubernetes cluster, node pools, ingress controller installation, certificate issuer installation, DigitalOcean DNS, managed Postgres, Spaces, registry retention, or observability storage.
