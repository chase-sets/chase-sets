# DOKS Ingress Add-ons

Cluster ingress, load balancer, and TLS add-ons for the DOKS runtime accepted by
[ADR 0018](../../../docs/adr/0018-doks-compute-runtime.md) and milestone #103
(issue #4045). This is the DOKS equivalent of the routing and certificate surface
App Platform provides today.

It owns three cluster-scoped concerns:

- **Ingress controller + load balancer** — the upstream `ingress-nginx` chart, whose
  `LoadBalancer` Service provisions the DigitalOcean Load Balancer that fronts DOKS
  ingress and terminates TLS with cert-manager certificates.
- **cert-manager** — the upstream `jetstack/cert-manager` chart, installed with CRDs.
- **ACME `ClusterIssuer`s** — rendered by this chart (`letsencrypt-staging` and
  `letsencrypt-production`, HTTP-01 solver via the nginx ingress class).

The application `Ingress` objects themselves stay in the
[platform chart](../platform/README.md); this chart only stands up the controller,
load balancer, and issuers those Ingress objects depend on.

## What Is Installed Where

| Component | Source | Namespace |
| --- | --- | --- |
| ingress-nginx controller + DO Load Balancer | upstream chart + `ingress-nginx-values.yaml` | `ingress-nginx` |
| cert-manager + CRDs | upstream chart + `cert-manager-values.yaml` | `cert-manager` |
| ACME `ClusterIssuer`s | this chart (`templates/cluster-issuer.yaml`) | `cert-manager` |

The upstream charts are pinned and installed by the source-owned helper so versions
and values stay in git, never in ad-hoc `helm install` invocations:

```bash
node ./scripts/doks-cluster-addons.mjs --environment staging
```

Preview the exact pinned commands without touching a cluster:

```bash
node ./scripts/doks-cluster-addons.mjs --environment staging --dry-run
```

`--environment` selects the per-environment DigitalOcean Load Balancer name
(`chase-sets-<environment>-doks-ingress`). Staging is the first cutover target.

## Load Balancer And TLS Posture

The controller Service pins `service.beta.kubernetes.io/do-loadbalancer-type: REGIONAL`
(a connection-terminating / HTTP DigitalOcean Load Balancer). NGINX terminates TLS with
cert-manager-issued certificates; port 80 is not force-redirected at the load balancer,
so cert-manager HTTP-01 challenges reach the controller. PROXY protocol is enabled on
both the load balancer and the controller so real client IPs survive for rate limiting
and `CHASE_SETS_TRUST_FORWARDED_HEADERS`.

`REGIONAL` must be set explicitly. On DOKS 1.33.1-do.0 and later the CCM default is
`REGIONAL_NETWORK` (a network / same-port pass-through load balancer). That default is
wrong here: a network LB requires the LB port and node target port to match, so it
forwards `:80`/`:443` to host `:80`/`:443` where this NodePort controller listens on
nothing (connections refused), and it does not support PROXY protocol. `REGIONAL`
rewrites the forwarding rules to the allocated NodePorts and supports PROXY protocol.
The annotation lives in git-managed values because the CCM reconciles the Service back
to these values — a hand-applied `kubectl annotate` does not survive a helm upgrade.
See [DigitalOcean load balancer configuration](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/).

## Rendering

```bash
docker run --rm -v "${PWD}:/repo" -w /repo alpine/helm:3.15.4 lint infrastructure/helm/doks-ingress
docker run --rm -v "${PWD}:/repo" -w /repo alpine/helm:3.15.4 template chase-sets-doks-ingress infrastructure/helm/doks-ingress
```

`ClusterIssuer` is a cert-manager CRD, so schema validation must ignore missing
schemas (the CRDs install with cert-manager, not with this chart).

## Cutover

The DNS records that point the staging hosts at this load balancer live in
[environment-dns](../../digitalocean/environment-dns/README.md). The end-to-end
cutover and rollback sequence lives in
[DOKS Platform Operations](../../../docs/runbooks/doks-platform-operations.md).
