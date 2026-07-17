# DOKS Ingress Add-ons

Cluster ingress, load balancer, and TLS add-ons for the DOKS runtime accepted by
[ADR 0018](../../../docs/adr/0018-doks-compute-runtime.md) and milestone #103
(issue #4045). This is the DOKS equivalent of the routing and certificate surface
App Platform provides today.

It owns five cluster-scoped concerns:

- **Ingress controller + load balancer** — the upstream `ingress-nginx` chart, whose
  `LoadBalancer` Service provisions the DigitalOcean Load Balancer that fronts DOKS
  ingress and terminates TLS with cert-manager certificates.
- **cert-manager** — the upstream `jetstack/cert-manager` chart, installed with CRDs.
- **Argo Rollouts** — the upstream `argo/argo-rollouts` chart, installed with CRDs and a private two-replica controller; no dashboard is exposed.
- **ACME `ClusterIssuer`s** — rendered by this chart (`letsencrypt-staging` and
  `letsencrypt-production`, HTTP-01 solver via the nginx ingress class; the
  production issuer also carries a DNS-01 solver scoped by `selector.dnsZones`
  to `preview.chasesets.com` on staging or `chasesets.com` on production).
- **The shared preview wildcard `Certificate`** (`previewWildcardCertificate`,
  `--environment staging` only) — ONE `*.preview.chasesets.com` certificate every
  preview namespace's Ingress references, instead of each preview issuing its own
  (#4857). See [Preview Wildcard Certificate Bootstrap](../../../docs/runbooks/doks-platform-operations.md#preview-wildcard-certificate-bootstrap-one-time---environment-staging-only).

The application `Ingress` objects themselves stay in the
[platform chart](../platform/README.md); this chart only stands up the controller,
load balancer, and issuers/certificate those Ingress objects depend on.

## What Is Installed Where

| Component | Source | Namespace |
| --- | --- | --- |
| ingress-nginx controller + DO Load Balancer | upstream chart + `ingress-nginx-values.yaml` | `ingress-nginx` |
| cert-manager + CRDs | upstream chart + `cert-manager-values.yaml` | `cert-manager` |
| Argo Rollouts controller + CRDs | upstream chart + `argo-rollouts-values.yaml` | `argo-rollouts` |
| ACME `ClusterIssuer`s | this chart (`templates/cluster-issuer.yaml`) | `cert-manager` |
| `digitalocean-dns-token` Secret (environment-scoped DNS-01 credential) | `scripts/doks-cluster-addons.mjs` (applied via `kubectl apply` stdin, never in git) | `cert-manager` |
| Shared preview wildcard `Certificate` (staging only) | this chart (`templates/preview-wildcard-certificate.yaml`) | `cert-manager` |

The upstream charts are pinned and installed by the source-owned helper so versions
and values stay in git, never in ad-hoc `helm install` invocations:

```bash
DIGITALOCEAN_ACCESS_TOKEN=<token with DNS write access> \
  node ./scripts/doks-cluster-addons.mjs --environment staging
```

Preview the exact pinned commands without touching a cluster:

```bash
node ./scripts/doks-cluster-addons.mjs --environment staging --dry-run
```

`--environment` selects the per-environment DigitalOcean Load Balancer name
(`chase-sets-<environment>-doks-ingress`) and DNS-01 zone. Staging additionally renders the preview wildcard Certificate; production uses DNS-01 to issue the live-and-shadow cutover certificate before its DNS flip.

## Load Balancer And TLS Posture

The controller Service pins the DOKS-coerced `REGIONAL_NETWORK` load-balancer type and binds ingress-nginx to host ports 80/443 so same-port L4 pass-through reaches the controller. NGINX terminates TLS with cert-manager-issued certificates; port 80 remains reachable for HTTP-01. PROXY protocol is disabled on both sides because the network load balancer does not support it. These paired values are the live-proven #4680/#4693 topology and must move together.

The annotations live in git-managed values because the CCM reconciles the Service back to them — a hand-applied `kubectl annotate` does not survive a Helm upgrade.
See [DigitalOcean load balancer configuration](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/).

## Rendering

```bash
docker run --rm -v "${PWD}:/repo" -w /repo alpine/helm:3.15.4 lint infrastructure/helm/doks-ingress
docker run --rm -v "${PWD}:/repo" -w /repo alpine/helm:3.15.4 template chase-sets-doks-ingress infrastructure/helm/doks-ingress
```

`ClusterIssuer` is a cert-manager CRD, so schema validation must ignore missing
schemas (the CRDs install with cert-manager, not with this chart).

## Cutover

The DNS records that point the staging or production shadow hosts at this load balancer live in
[environment-dns](../../digitalocean/environment-dns/README.md). The end-to-end
cutover and rollback sequence lives in
[DOKS Platform Operations](../../../docs/runbooks/doks-platform-operations.md).
