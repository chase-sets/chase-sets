# DigitalOcean Platform Deployment Runbook

This runbook covers the current DigitalOcean platform deployments. PR previews run as per-PR Kubernetes namespaces on the shared DOKS cluster with disposable in-cluster Postgres. Staging and production still use the App Platform-managed Terraform root unless a DOKS cutover flag is explicitly set. [ADR 0018](../adr/0018-doks-compute-runtime.md) records the accepted pre-launch decision to migrate compute/runtime orchestration to DOKS after #101 deploy stabilization and #97 beta-clock start.

## Architecture

- Regions: App Platform runs in `nyc`; managed Postgres and Spaces stay in `nyc3`; PR preview compute and disposable Postgres run in DOKS.
- Infrastructure: App Platform Terraform root at `infrastructure/digitalocean/platform`; platform Helm chart at `infrastructure/helm/platform`; shared staging/production telemetry backend root at `infrastructure/digitalocean/observability`.
- State: DigitalOcean Spaces bucket through Terraform's S3 backend with `use_lockfile=true`.
- State keys:
  - PR previews: `platform/previews/pr-<number>.tfstate`.
  - Staging: `landing/staging.tfstate`.
  - Production: `landing/production.tfstate`.
- Environment DNS state keys:
  - Staging: `environment-dns/staging.tfstate`.
- Catalog asset state keys:
  - Preview assets: `catalog-assets/preview.tfstate`.
  - Staging assets: `catalog-assets/staging.tfstate`.
  - Production assets: `catalog-assets/production.tfstate`.
- Observability state keys:
  - Shared pre-launch stack: `observability/shared.tfstate`.
- DNS: `chasesets.com` must exist as a DigitalOcean DNS domain before Terraform runs. Staging also uses `infrastructure/digitalocean/environment-dns` to delegate and populate the stable `staging.chasesets.com` child zone before App Platform deploy/reset operations. The platform Terraform root owns App Platform domain attachments and staging nested alias CNAMEs; App Platform owns the apex A/AAAA routing records for primary domains.
- Catalog asset storage: preview, staging, and production each have a dedicated DigitalOcean Spaces bucket with a CDN-backed custom domain. PR previews share `assets.preview.chasesets.com` instead of creating per-PR buckets or CDNs.
- Deploy orchestration: GitHub Actions is the canonical deploy owner. Label-gated PR previews and staging build one platform container image in GitHub Actions with bounded Docker Buildx cache, push it to DigitalOcean Container Registry, and record the digest. PR previews deploy that image through Helm into `chase-sets-pr-<number>` namespaces; staging points App Platform components at the immutable image tag unless the DOKS cutover path is active. Production verifies and promotes the staging-built commit image instead of rebuilding a second artifact. A change-scope classifier gates CI and CD work so documentation-only, workflow-only, and non-deployable changes do not build images or deploy runtime infrastructure.
- Preview and staging environments run the full public platform profile. Production selects `landing`, `proof`, or `public` through `production_runtime_profile`; non-production always resolves to the `public` runtime profile.
- Expected production App Platform component baseline before public marketplace promotion: `public-web` service size `apps-s-1vcpu-1gb` with one instance, `admin-web` service size `apps-s-1vcpu-1gb` with one instance, profiled `platform-api` service size `apps-s-1vcpu-1gb` with two instances, profiled `platform-worker` worker size `apps-s-1vcpu-1gb` with one instance, and `platform-bootstrap` job size `apps-s-1vcpu-1gb` with one pre-deploy instance. The retired `admin-support-api`, `admin-support-worker`, and `admin-support-bootstrap` component names must not appear in the App Platform spec outside a reviewed rollback.
- Public landing is static-first in operation: `public-web` owns only public page rendering and the browser analytics bridge, while `/api/public-presence/analytics/waitlist` is handled by `platform-api`. Full App Platform static-site hosting is deferred while the home route still owns the no-JavaScript waitlist form action and runtime robots/sitemap/canonical metadata.
- Database connections: App Platform components use component-specific per-context Postgres client pool budgets. API components keep enough clients for concurrent route loaders, workers keep enough clients for their configured runner groups plus control-plane work, and bootstrap jobs keep a smaller bounded pool. PR previews synthesize per-context database URLs for an in-cluster Postgres Deployment backed by `emptyDir`; preview data is disposable and namespace teardown removes the database. Staging routes runtime traffic through managed PgBouncer transaction pools on `db-s-2vcpu-4gb` so hot contexts such as Catalog, Control, Auth, Identity, Public Presence, Discovery, and Marketplace can use larger managed pools without exhausting server connections. Staging storage is right-sized separately at `25600` MiB on cluster creation and activates only when the staging reset workflow recreates Postgres. Production also uses `db-s-2vcpu-4gb` as the baseline for its component pool budgets. Managed pool `size` consumes database server connection capacity; scale the database tier before increasing managed PgBouncer pool sizes further.
- Production branch: `production` is a smoke-verified deployed release marker. The production workflow fast-forwards it only after App Platform deployment and production smoke pass. It also creates an annotated `release-<yyyymmddHHMMSS>-<sha>` Git tag and a matching DOCR image tag for audit and rollback.
- Image retention: the `chase-sets-platform` DOCR repository uses immutable commit, tree, PR, and release tags. `.github/workflows/platform-registry-cleanup.yml` uses `DIGITALOCEAN_REGISTRY_TOKEN`, preserves all `release-*` tags, App Platform-referenced staging/production tags and matching digests, and the newest 25 SHA/tree tags; scheduled runs delete older unprotected tags and then start DigitalOcean registry garbage collection. DigitalOcean registry GC makes the registry read-only while it runs. Platform Deploy, Platform Staging Reset, and Platform Registry Cleanup share the `platform-registry-mutation` GitHub Actions concurrency group, so registry-pushing deploy paths cannot start while cleanup is deleting tags or running GC, and cleanup cannot start while a registry-pushing deploy path is running. Before deleting tags or starting GC, the cleanup workflow also checks queued and in-progress Platform Deploy and Platform Staging Reset runs and writes a deferred cleanup artifact instead of entering the read-only window when a deploy is already waiting on the lane. Manual dispatch defaults to dry-run for operator inspection and uploads `artifacts/release-health/digitalocean-registry-cleanup.json`.
- Terraform state snapshots: DigitalOcean Spaces does not support object versioning, so `.github/workflows/platform-terraform-state-snapshot.yml` copies durable state objects into `state-archive/YYYY-MM-DD/<original-key>` daily and prunes archive objects older than 30 days. The workflow excludes disposable PR preview state under `platform/previews/`, uploads metadata-only evidence, and alerts through the scheduled workflow reporter.
- Availability checks: Terraform creates DigitalOcean uptime checks for public, admin, and canonical marketplace endpoints. Uptime alert emails are created only when `PLATFORM_ALERT_EMAILS` is configured for the GitHub environment. Terraform also creates managed-Postgres DBAAS monitor alerts for disk utilization above 80%, CPU above 85%, memory above 85%, and 15-minute load above 85 when `managed_postgres_alerts_enabled=true` and alert emails are configured. DigitalOcean's Terraform provider does not expose DBAAS connection-count alert policies; `.github/workflows/platform-postgres-growth-evidence.yml` supplies the repo-owned support-safe connection-pressure warning path at 80% of `max_connections`.
- Drift visibility: `.github/workflows/platform-digitalocean-drift-digest.yml` uses `DIGITALOCEAN_READONLY_TOKEN` to run a read-only advisory digest of DigitalOcean apps, managed databases, registry tags, observability droplets/volumes, uptime checks, and CDN endpoints. The digest uploads `artifacts/release-health/digitalocean-drift-digest.json`, maps known Chase Sets resources to Terraform roots, and flags unknown or cost-impacting resources for operator review. It also warns if retired admin-support component names reappear in one App Platform app. It cannot delete resources.
- Observability cost posture: `infrastructure/digitalocean/observability` provisions one shared pre-launch Droplet and volume for staging and production, defaults `droplet_backups_enabled=false`, and validates backups stay off because the host is reproducible from Terraform/cloud-init. The attached volume is the durable telemetry surface; staging and production accept no more than 24 hours of telemetry data loss by default and require a manual volume snapshot before destructive maintenance or risky host replacement. The drift digest reports Droplet backup state and observability volume size and warns when shared-stack cost posture drifts.
- Stateful destroy guards: Terraform resources that hold non-replayable or delegated state use `lifecycle { prevent_destroy = true }` by default. This covers the platform managed Postgres cluster, observability data volume, catalog asset Spaces bucket, Terraform state bucket, and delegated environment DNS zone. A deliberate destroy or replacement must be reviewed as a destructive infrastructure change before the guard is bypassed.
- Image groups are intentionally deferred. The platform still deploys one shared image across App Platform components because splitting deployables into separate image groups would add Docker, registry, Terraform, promotion, rollback, and smoke-test complexity before there is enough deployment data to justify it.

## Accepted DR Risks

The platform deliberately accepts the following pre-launch disaster-recovery risks. These are decisions, not unowned gaps; revisit them when launch traffic, compliance obligations, customer contracts, incident evidence, or restore-drill results change the cost/risk balance.

### Single Region

Decision: App Platform stays in `nyc`, while managed Postgres and Spaces stay in `nyc3`. Chase Sets does not currently run cross-region database replication, object-storage replication, or DNS failover.

Rationale: a second active region would add Terraform, secrets, data-replication, deploy, smoke-test, rollback, and operator complexity before the marketplace has enough launch traffic to justify it. The current architecture keeps the event-sourced system easier to reason about and recover.

Blast radius and recovery: a DigitalOcean NYC-region incident can take the application, managed Postgres, Spaces-backed assets, Terraform state bucket, and observability host offline together. Recovery is manual: create or restore a managed Postgres cluster from DigitalOcean backups/PITR in an available region, provision or repoint Spaces-backed assets and Terraform/App Platform specs, update DNS, redeploy the platform image, and rebuild derived projections from the recovered event stores. The current RPO is bounded by the managed Postgres backup/PITR posture plus any asset/state artifacts that must be restored from Spaces. The measured RTO remains pending until the milestone restore-verification drill records a restore time.

Revisit trigger: public launch traffic with meaningful revenue exposure, a compliance or customer SLA that requires regional failover, a regional incident, or a restore drill that misses the accepted recovery target.

### Production Managed Postgres HA

Decision: production's intended in-region high-availability posture is one primary plus one DigitalOcean managed standby node (`database_node_count=2`) in `nyc3`, with runtime traffic still using the primary App Platform database bindings only. Do not route application reads to standby nodes and do not add read-only node endpoints as part of this posture.

Rationale: a standby reduces single-node failure exposure without introducing read-splitting behavior, replica-lag semantics, or cross-region recovery complexity before launch. The checked-in Terraform keeps `database_node_count=1` by default until operators record explicit launch/cost approval and support-safe plan evidence. Production plans that set `database_node_count` above `1` must also set `production_database_standby_approved=true` and `production_database_standby_reference=<approval-and-plan-evidence-record>`; the `production_database_standby_approval` check rejects placeholder references. The `production_database_standby_posture` output records the desired node count, configured node count, primary-only traffic posture, and remaining operator action while production is still single-node.

Support-safe plan evidence before apply:

1. Run staging plan first for the same Terraform change and confirm it is free of source-of-truth database deletes or replacements.
2. Run production `terraform plan` through the normal deployment workflow or an operator shell with the production backend. Do not apply.
3. Save the plan summary and `terraform show -json` classification artifact in the approval record. The evidence must show no `delete`, `delete/create`, or replacement actions for `digitalocean_database_cluster.postgres`, `digitalocean_database_db.contexts`, `digitalocean_database_user.contexts`, `digitalocean_database_user.wake_listeners`, or `digitalocean_database_connection_pool.contexts`.
4. Confirm `connection_budget_profiles` still passes the steady-state, rolling-deploy, and 80% tier-upgrade trigger checks. Do not weaken these checks to land the standby.
5. Confirm the planned database change is only the approved node-count increase plus source-owned managed-Postgres alert policies.

Cost, rollback, and failover expectations:

- Cost: a standby node materially increases the managed Postgres monthly run rate for the selected database size. Operators must record the approved incremental monthly cost in `production_database_standby_reference` before setting `database_node_count=2`.
- Failover: DigitalOcean manages primary-to-standby failover inside the cluster. Chase Sets should expect a brief connection interruption, reconnect through existing primary bindings, and let workers retry idempotent jobs. No application read splitting is expected or supported by this change.
- Rollback: the normal rollback is operational, not destructive: leave the standby in place and roll back the application image or Terraform app-spec change. Scaling `database_node_count` back to `1` is a cost rollback only after another no-delete/no-replace plan proves DigitalOcean will remove only the extra standby capacity and not replace the source-of-truth cluster.
- Current blocker: as of this repo change, no explicit production launch/cost approval or support-safe production plan evidence is checked in or recorded on #3696. The remaining operator action is to create that approval/evidence record, then set the three Terraform values above in a follow-up production infrastructure change.

Revisit trigger: public launch traffic with meaningful revenue exposure, a customer SLA needs in-region failover, restore-drill evidence changes RTO expectations, or DigitalOcean provider/API support exposes source-owned alerts for connection count or replication lag.

### Observability Config Drift

Decision: staging and production observability host configuration is source-owned through Terraform, cloud-init, and checked-in stack files. Live edits on the Droplet, including Grafana dashboards, scrape config, alert rules, and Caddy changes, are treated as temporary operator state and are not configuration-of-record. The drift digest inventories observability Droplets and volumes, but it does not diff live application configuration inside the host.

Rationale: the observability stack is intentionally reproducible and cost-aware. Keeping source as the recovery path avoids paying for continuous host-image backup and avoids creating a second configuration system around live dashboard tweaks before production traffic proves the need.

Blast radius and recovery: a lost or rebuilt observability host may lose uncommitted live configuration edits. The durable telemetry surface is the attached volume; the accepted telemetry data-loss window is no more than 24 hours by default, with a manual volume snapshot required before destructive maintenance, risky host replacement, or retention changes. Recovery is to re-run Terraform/cloud-init from source, reattach or restore the volume when available, and reapply only source-controlled dashboards and rules. If a live change is needed after recovery, capture it in source before treating it as durable.

Revisit trigger: production incident response depends on a live-only dashboard or alert, audit/compliance needs longer telemetry or dashboard retention, operators repeatedly need host-local changes, or a drift incident shows the source-owned path is too slow.

### Terraform State Snapshot Scope

Decision: Terraform state uses daily same-bucket archive copies instead of native object versioning.

Rationale: DigitalOcean Spaces does not expose S3 object versioning. A scheduled copy to `state-archive/YYYY-MM-DD/` protects against accidental overwrite or corruption of an individual state object without introducing a second storage provider before launch.

Blast radius and recovery: same-bucket archive copies do not protect against bucket deletion, account-wide credential compromise, or a regional Spaces outage. Recovery from object overwrite is supported by copying a dated archive object back to its original key, then running a Terraform plan for the affected root before any apply.

Revisit trigger: compliance or revenue exposure requires bucket-loss recovery, a state incident shows same-bucket archival is insufficient, or restore drills show state recovery cannot meet the accepted recovery target.

## Preview Hosts

Each pull request receives its own `pr-<number>` preview environment. Every preview host is a single label under `preview.chasesets.com` (#4857) so the one shared `*.preview.chasesets.com` wildcard certificate covers all of them:

- `pr-<number>.preview.chasesets.com`: landing `public-web`.
- `pr-<number>-marketplace.preview.chasesets.com`: marketplace web.
- `pr-<number>-admin.preview.chasesets.com`: admin web.

Preview app components:

- `public-web`, `marketplace`, `admin-web`. Their internal `CHASE_SETS_INTERNAL_API_ORIGIN` (used for server-side actor resolution against `platform-api`) is computed by the Helm chart from the release fullname, so it resolves to the preview's own `chase-sets-pr-<number>-chase-sets-platform-platform-api` Service rather than the base staging release name.
- `platform-api`: same-origin `/api/*` for landing, admin, and marketplace.
- `platform-worker`: full-system background workers and worker health.
- `platform-bootstrap`: `PRE_DEPLOY` schema, seed, control-plane, and platform-admin reconciliation.

The preview workflow deploys these components with the platform Helm chart into namespace/release `chase-sets-pr-<number>`. The chart enables `previewPostgres` only for `DEPLOYMENT_ENVIRONMENT=preview`; runtime secret generation creates the disposable Postgres credentials and per-context database URLs, and bootstrap creates the preview databases/users before schema reconciliation. The workflow deletes and recreates the preview namespace before deploy, so teardown removes the Postgres Deployment, Service, Secrets, and all preview data. Preview workflows must not apply the platform Terraform root or create `chase-sets-pr-<number>-postgres` DigitalOcean managed database clusters. The preview Helm deploy pins every preview workload, including the in-cluster preview Postgres, to the dedicated staging `preview` node pool with a `chase-sets.com/pool=preview` nodeSelector and the matching `chase-sets.com/preview-only` taint toleration; the pool itself is defined in the DOKS foundation root (see [DOKS Platform Operations](./doks-platform-operations.md)).

### Preview DNS And TLS

Preview hosts are single-label (`pr-<number>`, `pr-<number>-marketplace`, `pr-<number>-admin`) under `preview.chasesets.com`, so ONE shared `*.preview.chasesets.com` DNS wildcard A record and ONE shared `*.preview.chasesets.com` TLS certificate cover every preview, present and future (#4857). Neither is created per-PR:

- **DNS**: a single wildcard A record at `preview.chasesets.com`, pointing at the DOKS ingress load balancer, applied once (idempotently — re-running is a safe no-op unless the load balancer IP changed) by `node ./scripts/digitalocean-preview-cleanup-sweep.mjs apply-shared-dns --target <load-balancer-ipv4>` as part of the DOKS foundation bootstrap in [DOKS Platform Operations](./doks-platform-operations.md#ingress-controller-cert-manager-and-load-balancer). No preview deploy touches DNS.
- **TLS**: a single wildcard `Certificate` for `*.preview.chasesets.com`, rendered by `infrastructure/helm/doks-ingress` (`previewWildcardCertificate`), issued via cert-manager's ACME DNS-01 solver (the only way to legally prove a wildcard name) into the stable `cert-manager` namespace as Secret `preview-wildcard-tls`. Each preview deploy copies that ONE secret into its own `chase-sets-pr-<number>` namespace before `helm upgrade --install` (`copyPreviewWildcardTlsSecret` in `scripts/platform-kubernetes-deployment.mjs`) and points the preview Ingress's `tls.secretName` at the copy, with no `cert-manager.io/cluster-issuer` annotation — so a preview deploy performs zero ACME issuance. A high-throughput PR day that used to issue one certificate per preview namespace exhausted Let's Encrypt's 50-certificates-per-168h-per-domain quota and blocked every PR behind "PR Required" for three hours; this shared-secret design makes that structurally impossible regardless of merge velocity.

Because the wildcard secret already exists (bootstrapped once, renewed automatically by cert-manager thereafter), the deploy step that used to block up to 10 minutes on `kubectl wait --for=condition=Ready certificate/pr-<number>-platform-tls` is now a fast presence check (`kubectl get secret/preview-wildcard-tls`) run immediately after deploy, not a poll. If the copy step cannot find the shared secret it fails the deploy immediately with a message pointing at the bootstrap command above, rather than deploying a preview with dead TLS.

If the shared certificate ever needs to re-issue (renewal, or the DNS-01 order hits a transient Let's Encrypt rate limit and is retrying), diagnose it in the `cert-manager` namespace, not a preview namespace: `kubectl describe certificate preview-wildcard -n cert-manager` and `kubectl describe order -n cert-manager` (cert-manager auto-retries a `rateLimited` order until it succeeds; that is expected and does not require operator action). Staging and production keep their existing per-environment `letsencrypt-production` HTTP-01 issuance, entirely unaffected by this change.

In staging and production, `platform-bootstrap` runs only the long-lived data profiles: `critical-bootstrap` and `catalog-integration-bootstrap`. Bootstrap receives `DEPLOYMENT_ENVIRONMENT=<environment>` so staging and production policy checks evaluate the same environment identity used by runtime services. Bootstrap reconciles schemas, required operating data, and Catalog integration structure. It does not run host-level projection, subscription, outbox, job, or Catalog seed projector drains in these long-lived environments; worker components own that catch-up after deployment. Preview keeps the full bootstrap drain because `scenario-seed` depends on cross-context scenario projections and local Catalog read models. After the DOKS staging release and ingress are available, the production workflow dispatches `Platform Staging Advisory Evidence`. That workflow runs the transient `scenario-seed` Job without pausing projection workers, then runs the broad deployed marketplace E2E contract. It has its own serialized concurrency lane, timeout, summary, artifacts, and deduplicated incident signal; it is not a production promotion dependency and is never created by the production path. Staging representative marketplace data remains a separate operator flow described in [Staging Representative Commerce State](./staging-representative-commerce-state.md); it is not part of ordinary deployment bootstrap and is blocked in production.

Preview environments are disposable and intentionally `noindex,nofollow` for landing and marketplace.

## Staging Hosts

The long-lived staging environment uses the same full-platform shape as PR previews, but keeps stable hostnames and state across merges:

- `www.staging.chasesets.com`: canonical staging landing `public-web`.
- `staging.chasesets.com`: launch-facing staging marketplace entry point, routed to `marketplace`.
- `marketplace.staging.chasesets.com`: marketplace web.
- `admin.staging.chasesets.com`: admin web.
- Legacy dash-based staging hosts temporarily redirect to their nested replacements.

The staging environment root, `staging.chasesets.com`, is delegated from `chasesets.com` into its own DigitalOcean DNS zone and attached to App Platform as the staging app's primary domain in that child zone. This mirrors production apex ownership by making the staging root a real apex: App Platform-managed A/AAAA routing records coexist with exact-name Google Workspace MX/TXT records at the same owner name. A managed App Platform subdomain alias or self-managed alias is not correct for this host because those modes expect CNAME ownership and conflict with exact-name mail.

When Google Workspace mail is enabled for an environment root, configure that root like the production apex. For staging, the parent zone owns only the `NS staging` delegation; the child zone owns Gmail MX/SPF, optional Google DKIM, SES bounce/DKIM/DMARC, and the asset CDN CNAME. App Platform owns the apex A/AAAA records for the staging primary domain. The platform Terraform root owns the child-zone CNAME records for `www`, `marketplace`, and `admin` because those hosts depend on the app's generated ingress hostname. No CNAME exists at the environment root.

Staging is intentionally `noindex,nofollow` for landing and marketplace. Use it to test incremental merge changes against durable state after the fresh PR preview has already passed.

### Staging DNS Operations

Use the delegated child-zone primary-domain mode for root environment hosts that must support both runtime routing and Google Workspace mail. The DOKS staging deploy lane waits on HTTPS ingress readiness for the landing, admin, marketplace, root marketplace, and legacy redirect hosts before smoke checks run. The staging reset workflow still owns the temporary App Platform attachment repair path until App Platform decommission; a root-domain attachment that stays in `CONFIGURING` blocks reset smoke checks because App Platform routing and certificate validation are not healthy.

Incident history: on May 17, 2026, attaching `staging.chasesets.com` as a DigitalOcean-managed App Platform alias left the domain in `CONFIGURING` and prevented staging deployment from reaching smoke checks. A later self-managed alias attempt proved the app shape, but DigitalOcean reported `DomainCNAMEMismatch` while exact-name A/AAAA, MX, and TXT records were present because that attachment mode expects a CNAME. On May 26, 2026, using `zone = chasesets.com` with `type = PRIMARY` still left `staging.chasesets.com` in `CONFIGURING` with `DomainZoneInvalid` and `DomainCNAMEMismatch`; DigitalOcean treated it as a subdomain and still expected CNAME ownership.

When staging DNS regresses, verify this shape before rerunning deployment:

- Parent `chasesets.com` zone delegates `NS staging` to DigitalOcean nameservers.
- Child `staging.chasesets.com` zone owns apex A/AAAA routing records through App Platform primary-domain management.
- Child apex owns Google Workspace MX/TXT records; no CNAME exists at the environment root or as `CNAME staging` in the parent zone.
- Nested App Platform hosts (`www`, `marketplace`, and `admin`) are CNAMEs in the child zone because they target the app's generated ingress hostname.
- The platform deployment reset step may reset only the stale `staging.chasesets.com` App Platform domain attachment when DigitalOcean reports the earlier `DomainZoneInvalid` or `DomainCNAMEMismatch` states.

## Required GitHub Environment Secrets

Configure these in `preview`, `staging`, and `production` GitHub Environments:

- `DIGITALOCEAN_ACCESS_TOKEN`
- `SPACES_ACCESS_ID`
- `SPACES_SECRET_KEY`
- `PLATFORM_INTERNAL_AUTH_SECRET`
- `PLATFORM_ADMIN_EMAIL`
- `PLATFORM_ADMIN_PASSWORD`
- `CHASE_SETS_DISCORD_INVITE_URL`
- `SES_AWS_ACCESS_KEY_ID`
- `SES_AWS_SECRET_ACCESS_KEY`
- `SES_SOURCE_ARN`

Additional DigitalOcean operational secrets:

- `DIGITALOCEAN_READONLY_TOKEN`: configure where Platform DigitalOcean Drift Digest can read it; the workflow currently runs in the `production` GitHub Environment.
- `DIGITALOCEAN_REGISTRY_TOKEN`: configure where Platform Registry Cleanup can read it; the workflow currently runs in the `staging` GitHub Environment.

Additional `preview` and `staging` secrets for the full platform:

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CONNECT_WEBHOOK_SECRET`
- `EASYPOST_API_KEY`
- `SCRYDEX_API_KEY`
- `SCRYDEX_TEAM_ID`

Optional provider-access secrets for `preview`, `staging`, and `production`:

- `TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE`

## DigitalOcean API Token Scope Inventory

DigitalOcean tokens are split by capability. Never print token values; workflow files and runbooks should refer only to `${{ secrets.* }}` names.

| GitHub secret | DigitalOcean token posture | Workflows | Required capability |
| --- | --- | --- | --- |
| `DIGITALOCEAN_ACCESS_TOKEN` | Full Access (`api:write`) because these paths create, update, or delete apps, databases, DNS records, registry resources, Terraform-managed infrastructure, restore-point forks, preview resources, and rollback/restore resources. | Platform PR preview deployment, Platform Production, Platform Staging Reset, Platform Database Restore Drill, Platform Production Restore Point Cleanup, rollback/restore/emergency workflows. | Full deploy operator capability. Keep this out of advisory or cleanup-only workflows. |
| `DIGITALOCEAN_READONLY_TOKEN` | Prefer Custom Scopes with `app:read`, `database:read`, `registry:read`, `droplet:read`, `block_storage:read`, `uptime:read`, `monitoring:read`, and `cdn:read`. Use Read Only (`api:read`) if the custom picker or `doctl` endpoint coverage leaves a collection with a 403. | Platform DigitalOcean Drift Digest. | Read-only inventory of App Platform, managed databases/backups, registry tags, observability Droplets/volumes, uptime checks/alerts, and CDN endpoints. |
| `DIGITALOCEAN_REGISTRY_TOKEN` | Prefer Custom Scopes with `app:read`, `registry:read`, `registry:delete`, and `registry:update`. Add the narrow missing registry action scope if DigitalOcean returns a 403 for tag deletion or garbage collection. | Platform Registry Cleanup. | Read App Platform image tags, delete unreferenced DOCR tags, and start registry garbage collection. |

The quarterly reminder workflow `.github/workflows/platform-digitalocean-token-rotation-reminder.yml` runs at a non-`:00` minute on the first month of each quarter and can be manually dispatched. It opens or updates `[ops] Rotate DigitalOcean tokens` with the three secret names, a 90-day rotation target, and the operator proof checklist.

Operator creation steps:

1. In DigitalOcean, go to Control Panel -> Account -> API -> Tokens -> Personal access tokens -> Generate New Token.
2. Name the token after the GitHub secret and capability, for example `chase-sets-production-readonly-digest`.
3. Set the expiration to 90 days or the closest shorter option the UI allows.
4. Choose the scope set from the inventory above. DigitalOcean documents Read Only as the `api:read` alias and Full Access as the `api:write` alias; Custom Scopes preserve only the exact selected scopes.
5. Generate the token, copy it once, and store it only in the matching GitHub Environment or repository secret. Do not paste it into a terminal, issue, PR, comment, artifact, or chat.
6. Dispatch Platform DigitalOcean Drift Digest and Platform Registry Cleanup after adding `DIGITALOCEAN_READONLY_TOKEN` and `DIGITALOCEAN_REGISTRY_TOKEN`. Use registry cleanup `dry_run=true` first, then dispatch an apply run only after the dry-run summary looks correct.
7. Delete the superseded DigitalOcean tokens only after the scoped workflow proof is green.

Fallback for DigitalOcean scope gaps:

- If `DIGITALOCEAN_READONLY_TOKEN` fails a collection with 403, recreate it as a Read Only token (`api:read`) and rerun the digest. Keep the digest advisory; do not swap it back to `DIGITALOCEAN_ACCESS_TOKEN`.
- If `DIGITALOCEAN_REGISTRY_TOKEN` fails tag deletion or garbage collection with 403, first add the narrow registry scope named by the failed endpoint. If DigitalOcean does not expose a granular scope for that operation, pause scheduled apply cleanup and use manual `dry_run=true` until a short-lived exception token is approved and rotated immediately after cleanup.
- Spaces and Terraform-state least privilege remain separate follow-up work. `SPACES_ACCESS_ID` and `SPACES_SECRET_KEY` cover S3-compatible state and catalog asset operations; the Bitwarden notes on issue #3339 intentionally keep Spaces/Terraform-state key rotation outside this DigitalOcean API token split.

Optional `preview` and `staging` variables:

- `STRIPE_API_BASE_URL`
- `EASYPOST_API_BASE_URL`
- `EASYPOST_MODE`
- `PLATFORM_ADMIN_DISPLAY_NAME`
- `NOTIFICATION_EMAIL_PROVIDER`
- `SES_AWS_REGION`
- `SES_FROM_EMAIL`
- `SES_CONFIGURATION_SET_NAME`

Optional `preview`, `staging`, and `production` variables:

- `PLATFORM_ALERT_EMAILS`: JSON list of alert recipients, for example `["ops@example.com"]`.

Staging and production observability deployment secrets and variables:

- `OBSERVABILITY_OTLP_HEADERS` (secret): output `app_platform_otlp_headers` from `infrastructure/digitalocean/observability`, used by App Platform services to write OTLP telemetry.
- `OBSERVABILITY_ENABLED`: optional override; set to `false` only during an observability incident when the protected OTLP endpoint is unavailable.
- `OBSERVABILITY_OTLP_ENDPOINT`: optional override. By default staging uses `https://otel.staging.chasesets.com` and production uses `https://otel.chasesets.com`.

Staging and production schema-bootstrap authority:

- `PLATFORM_BOOTSTRAP_OWNER` is the single environment-scoped ownership contract. Its only valid values are `app-platform` and `doks`; the Platform Deploy workflow passes the resolved value to Terraform as `TF_VAR_platform_bootstrap_owner` in both deploy jobs. The checked-in default is `doks` for both normal and manual/emergency releases, including production. Never derive this authority from `DOKS_INGRESS_TARGET` or another ingress/DNS setting.
- Exactly one control plane runs schema bootstrap in an environment. When the value is `doks`, the retained App Platform `platform-bootstrap` pre-deploy job logs a no-op without loading API/database configuration, and Terraform omits the App Platform worker component. The DOKS bootstrap hook remains the sole schema-bootstrap path.
- To transfer authority to DOKS, first prove its bootstrap hook can complete, then change `PLATFORM_BOOTSTRAP_OWNER` on only the affected GitHub Environment and run Platform Deploy. Confirm the Terraform plan resolves `doks`, the App Platform job is a logged no-op, its worker is absent, and bootstrap executes exactly once before treating the transition as complete. Returning authority to App Platform requires a reviewed deployment change that first disables the DOKS bootstrap path; never flip the variable alone, enable both paths, or use an ingress change as the handoff signal.

The deployment-contract preflight runs for staging and production in Resolve Release, before the release image build or any staging mutation. It reads the effective repository and GitHub Environment variables, then derives component and database-key names through the same Terraform-to-Helm renderer used by the DOKS deployment. Its JSON contains ownership, rollout and image-identity sources, component names, and database-key names/status only; it never reads or writes secret values.

Reproduce the checked-in defaults locally:

```powershell
node ./scripts/deployment-contract-preflight.mjs --environment staging --out artifacts/deployment-contract/staging.json
node ./scripts/deployment-contract-preflight.mjs --environment production --out artifacts/deployment-contract/production.json
```

Pass `--bootstrap-owner-override`, `--production-runtime-profile-override`, `--production-marketplace-public-enabled`, `--argo-rollouts-enabled`, or `--app-platform-lane` to reproduce an environment override. The production owner-omission regression fixture must fail with the ownership remediation:

```powershell
node ./scripts/deployment-contract-preflight.mjs --fixture ./scripts/fixtures/deployment-contract-preflight/production-owner-omission.json --out artifacts/deployment-contract/production-owner-omission.json
```

When the preflight fails, inspect the redacted contract artifact and its job-summary errors. Restore the missing workflow-to-Terraform owner mapping or correct the environment variable so the runtime owner and sole bootstrap owner match. For DOKS ownership, keep App Platform bootstrap as a no-op and its worker absent. For an App Platform ownership transfer, disable the DOKS runtime/bootstrap path in the reviewed deployment change and ensure every listed `PLATFORM_CONTROL_DATABASE_URL`/`DATABASE_URL_*` key is configured before switching authority.

Additional `staging` variables:

- `GOOGLE_WORKSPACE_DKIM_TXT_VALUE`: the Google Admin Console-provided DKIM TXT value for `google._domainkey.staging.chasesets.com`. Leave unset until Google generates the key; MX and SPF remain managed without it.
- `STAGING_GUEST_BUY_NOW_CANARY_SEARCH_QUERY`: staging search query used by the Buy Now freshness probes to discover the first active buyable item. Defaults to `air balloon`; the broader `MARKETPLACE_E2E_SEARCH_QUERY` deploy check stays separate from the checkout-ready Buy Now fixture contract.
- `STAGING_GUEST_BUY_NOW_CANARY_ITEM_PATH`: optional stable staging item detail path override used by the Buy Now freshness probes when operators need to pin a known fixture.
- `STAGING_GUEST_BUY_NOW_CANARY_FIXTURE_KEY`: operator-owned fixture identifier recorded in probe evidence. Defaults to `staging-guest-buy-now-fixture`.
- `STAGING_GUEST_BUY_NOW_CANARY_TIMEOUT_MS`: browser wait timeout for the Buy Now freshness probes. Defaults to `45000`.
- `STAGING_GUEST_BUY_NOW_CANARY_READY_SLO_MS`: per-attempt write-to-checkout-ready budget for the Buy Now freshness probes. Defaults to `10000` (the interim #1227 gate value pending #1237).
- `STAGING_GUEST_BUY_NOW_CANARY_ATTEMPTS`: probe attempt budget; only readiness-SLO misses are retried. Defaults to `3`.
- `STAGING_GUEST_BUY_NOW_WAKE_RUNTIME_READY_BUDGET_MS`: post-deploy wake-runtime preflight budget for the staging Buy Now freshness probes. Defaults to `120000`.
- `STAGING_GUEST_BUY_NOW_WAKE_RUNTIME_READY_POLL_INTERVAL_MS`: wake-runtime preflight poll interval for the staging Buy Now freshness probes. Defaults to `5000`.

The staging account-flow Buy Now probe signs in with `MARKETPLACE_E2E_EMAIL`/`MARKETPLACE_E2E_PASSWORD` when configured and otherwise registers a synthetic probe-namespaced account.

Optional `production` variables and secrets for the proof-mode Buy Now freshness probe (used only while `PRODUCTION_MARKETPLACE_PROOF_ENABLED=true`):

- `PRODUCTION_PROOF_CANARY_EMAIL` / `PRODUCTION_PROOF_CANARY_PASSWORD` (secrets): preferred dedicated operator account with access to the permission-gated proof marketplace host. If the dedicated pair is not configured yet, the workflow falls back to the required `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` production secrets; the probe step still fails closed if neither credential pair is available.
- `PRODUCTION_PROOF_BUY_NOW_CANARY_SEARCH_QUERY`, `PRODUCTION_PROOF_BUY_NOW_CANARY_ITEM_PATH`, `PRODUCTION_PROOF_BUY_NOW_CANARY_FIXTURE_KEY`, `PRODUCTION_PROOF_BUY_NOW_CANARY_TIMEOUT_MS`, `PRODUCTION_PROOF_BUY_NOW_CANARY_READY_SLO_MS`, `PRODUCTION_PROOF_BUY_NOW_CANARY_ATTEMPTS`: proof-mode equivalents of the staging probe variables, defaulting to the staging values/defaults.

SES values configured for platform environments:

| Environment | `NOTIFICATION_EMAIL_PROVIDER` | `SES_AWS_REGION` | `SES_FROM_EMAIL` | `SES_CONFIGURATION_SET_NAME` | `SES_SOURCE_ARN` |
| --- | --- | --- | --- | --- | --- |
| `preview` | `amazon-ses` | `us-east-2` | `notifications@preview.chasesets.com` | `transactional-preview` | `arn:aws:ses:us-east-2:812517519777:identity/preview.chasesets.com` |
| `staging` | `amazon-ses` | `us-east-2` | `notifications@staging.chasesets.com` | `transactional-staging` | `arn:aws:ses:us-east-2:812517519777:identity/staging.chasesets.com` |
| `production` | `amazon-ses` | `us-east-2` | `notifications@chasesets.com` | `transactional-production` | `arn:aws:ses:us-east-2:812517519777:identity/chasesets.com` |

`SES_AWS_ACCESS_KEY_ID` and `SES_AWS_SECRET_ACCESS_KEY` are environment secrets for the IAM principal allowed to send through those SES identities and configuration sets.

The profiled `platform-worker` component consumes these values in preview, staging, and production. Production validates SES values whenever proof/public runtime posture needs provider callbacks or public marketplace launch.

Catalog asset storage also depends on `SPACES_ACCESS_ID` and `SPACES_SECRET_KEY` in all three environments. The Spaces key must be able to read/write the Terraform state bucket and the environment asset buckets:

| Environment | Bucket | CDN domain |
| --- | --- | --- |
| `preview` | `chase-sets-preview-catalog-assets` | `assets.preview.chasesets.com` |
| `staging` | `chase-sets-staging-catalog-assets` | `assets.staging.chasesets.com` |
| `production` | `chase-sets-production-catalog-assets` | `assets.chasesets.com` |

Preview and staging Terraform validation requires test-mode provider values:

- `STRIPE_SECRET_KEY` starts with `sk_test`.
- `STRIPE_PUBLISHABLE_KEY` starts with `pk_test`.
- Preview uses `https://pr-<number>-marketplace.preview.chasesets.com/account/payouts` and `https://pr-<number>-marketplace.preview.chasesets.com/account/payouts/setup`.
- Staging uses `https://marketplace.staging.chasesets.com/account/payouts` and `https://marketplace.staging.chasesets.com/account/payouts/setup`.
- `EASYPOST_API_KEY` starts with `EZTK`.
- `EASYPOST_MODE` is `test`.

## Required GitHub Protection

Deployment safety depends on GitHub repository settings as well as workflow code:

- Protect `main` with required pull requests and a required `PR Required` status check from `.github/workflows/platform-pr.yml`.
- Keep GitHub native merge queue enabled for `main` using the [Release Process Evolution](./release-process-evolution.md) queue policy. Use a maximum merge/build group size of two deployable pull requests unless release-health metrics say to hold or decrease.
- Protect or ruleset-match `production` so only the production workflow can move the deployed-release marker.
- Restrict the `staging` GitHub Environment to deployments from `main`.
- Restrict the `production` GitHub Environment to deployments from `main`.
- Do not require approval on the `production` GitHub Environment for the normal release path. Production deploys automatically after the `main` merge check, staging migration/bootstrap, staging smoke check, and production release-lock check succeed.
- Allow the `preview` GitHub Environment to deploy from pull requests created in this repository. Fork PRs do not receive preview secrets under the `pull_request` event.

The Platform PR workflow first resolves change scope. Pull request runs default to a fast lane before reporting `PR Required`: local static checks, affected workspace typecheck, affected non-DB/unit tests, and workflow syntax with Actionlint when workflows/actions changed. Heavy affected jobs are reserved for the full battery: DB-profile tests, marketplace Playwright e2e suites, broad workspace builds, Docker image validation, and Terraform validation. The full battery always runs for `merge_group` events, and pull requests opt into it with the `full-ci`, `full-pr-battery`, or `preview` labels. Skipped heavy jobs are accepted by `PR Required` only when the run is in the PR fast lane; merge-group and full-battery PR runs still require every affected heavy job to pass. Same-repository deploy-scoped pull requests deploy and smoke a live preview before `PR Required` can pass; same-repository non-deploy-scoped pull requests can still opt into a live preview with the `preview` label. Fork PRs skip preview deployment because preview secrets are unavailable to `pull_request` runs. DB-profile tests run against an explicit GitHub Actions PostgreSQL service. Playwright e2e tests start the sandbox marketplace stack once for the selected suites and upload browser artifacts when they fail. Coverage remains non-blocking, but the workflow merges first-party LCOV files and writes a Markdown coverage summary with command statuses. The workflow also fails if generated Terraform working directories under `.terraform/` are tracked; keep only `.terraform.lock.hcl` in git.

On pushes to `main`, a cancellable dispatcher submits the exact push SHA as an automatic release candidate. Push dispatchers use `platform-release-candidate`, so a burst coalesces before candidate work enters the deployment lane. Dispatched automatic releases and operator `workflow_dispatch` releases share `platform-registry-mutation`, which allows one running release and one latest pending release across Platform Deploy, Platform Staging Reset, and Platform Registry Cleanup. The active release is never cancelled. The newest automatic, manual, or emergency request replaces only the pending request; emergency mode bypasses the audited production release lock, not deployment serialization. Therefore precedence is immutable active release first, then the latest pending request regardless of trigger type. The automatic candidate performs one final `origin/main` freshness check immediately before the first staging apply. Once that check passes, its commit and pinned image digest are immutable through staging verification and production promotion, failure, or rollback; later main commits cannot supersede it. The merge queue already validated `PR Required` on the exact release commit, so the active run verifies that existing check instead of waiting for a redundant re-run. It resolves deployment scope and deploys staging only when the release changed deployable runtime or Terraform surfaces. Once staging ingress is available, it dispatches advisory seed and broad marketplace E2E in a separate workflow while the blocking smoke, bounded projection convergence, Buy Now freshness, account-cart canary, Stripe money smoke, rollback readiness, and production marker path continues. Production depends only on those blocking gates. If the release is documentation-only, workflow-only, or otherwise non-deployable, staging and production remain skipped by design.

Production promotion also evaluates `PRODUCTION_RELEASE_LOCKED` before production configuration validation or Terraform work. Set `PRODUCTION_RELEASE_LOCKED=true`, `PRODUCTION_RELEASE_LOCK_REASON`, and preferably `PRODUCTION_RELEASE_LOCK_REFERENCE` in the production GitHub Environment to pause normal promotion during an incident or maintenance window. A manual workflow dispatch may pass the lock only when `emergency_release=true` and `emergency_reference` points to the audited fix-forward, revert, incident, or rollback evidence record. See [Release Process Evolution](./release-process-evolution.md).

Production deploy failures and cancelled deploy jobs create or update a GitHub issue titled `Incident: Platform Deploy ...` with the workflow run URL, release commit, and per-job results. The notifier adds the issue to an open `Incidents` milestone when one exists, but issue creation must remain fail-safe when that milestone is absent. Treat the issue as the operator-visible notification channel: attach fix-forward, rollback-readiness, cleanup artifact, emergency release reference, or accepted no-op evidence there before closing it. Intentional candidate supersession before the first staging mutation is routine queue coalescing, is recorded as skipped rather than failed, and does not create an incident. After activation there is no superseded outcome: the release-health record reports the immutable active identity, latest pending SHA and coalesced commit count when present, and the promoted, failed, or rolled-back terminal transition.

## Production Database Restore Points

Before production Terraform apply or App Platform deployment can trigger `PRE_DEPLOY` bootstrap migrations, the production workflow classifies the release recovery mode. Routine app, UI, worker, projection, read-model, additive infrastructure, and other replayable changes use DigitalOcean managed Postgres PITR/backups plus event-sourced projection replay (`pitr`). High-risk canonical-state changes use a precreated DigitalOcean managed-database fork (`precreated-fork`): destructive or irreversible schema migrations, event-store format/upcaster changes, command-state rewrites, money movement or provider-idempotency changes, database engine/topology changes, and restore-point helper changes. Operators can also choose `force_restore_point=true` with a `recovery_reason` on manual dispatch to create a hot fork (`manual-hold`).

When recovery mode requires a precreated fork, DigitalOcean exposes this as `doctl databases fork <name> --restore-from-cluster-id <cluster-id>`; the forked cluster contains source data from the original cluster at fork creation time. The workflow starts the fork without `doctl --wait`, then polls the allowlisted database summary fields (`ID,Name,Status,Created`) until the fork is `online`. The default fork wait budget is 75 minutes with a 30-second poll interval; override with `PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_SECONDS` and `PRODUCTION_DB_RESTORE_POINT_FORK_POLL_SECONDS` only for an incident-specific operator decision. The longer default reflects observed DigitalOcean fork latency during restore-drill rehearsal while preserving a bounded fail-closed gate. The workflow resolves the source cluster from the saved `postgres_cluster_id` output, falling back to the existing `digitalocean_database_cluster.postgres` state resource while that output is first rolling out. The workflow fails closed if a required fork cannot be created, does not become online before the timeout, or if Terraform state does not expose either source.

The recovery classification is summarized in `production-release.json` under `recovery.productionRecoveryMode` and `recovery.productionRecoveryReason`. The restore-point record is written to `artifacts/release-health/production-db-restore-point.json` and summarized in `production-release.json` under `recovery.productionRestorePoint`. For `pitr`, the restore-point result is `skipped` and the restore-point type is `digitalocean-managed-pitr`. For `precreated-fork` or `manual-hold`, keep the forked cluster until the release is either known good or the rollback/fix-forward window has closed. If production recovery needs the restore point, use the recorded fork cluster id as the source of truth for data inspection or restore planning.

If restore-point creation fails with `failure.type: "restore-point-fork-timeout"` and the recorded status remains `forking`, treat the production deploy as safely stopped before production mutation. Inspect the recorded restore-point name and cluster id, then check only the safe summary fields:

```bash
doctl databases get <restore-point-cluster-id> --format ID,Name,Status,Created --no-header
```

If the cluster later becomes `online`, leave it in place, add its id or name to the restore-point cleanup hold list while the release decision is active, and rerun the production deploy only after confirming the release still needs a precreated fork. If the cluster stays `forking` past the operator incident window or enters a failed state, open a DigitalOcean support case with the cluster id and restore-point name, then delete the fork only after the rollback/fix-forward window is closed or a replacement restore point is available. Do not paste raw `doctl databases get` JSON into incident notes; it can include credential fields.

Emergency workflow dispatches may bypass restore-point creation only through the same audited emergency path used for the production release lock: `emergency_release=true` plus an `emergency_reference`. The bypass is recorded as `result: "bypassed"` in release health. Do not use this for ordinary releases.

After the release window closes, delete the forked restore-point cluster to stop ongoing database charges:

```bash
doctl databases delete <restore-point-cluster-id> --force
```

The `Platform Production Restore Point Cleanup` workflow runs four times per day and deletes only restore-point forks whose names start with `cs-prod-rp-` and are at least 6 hours old. Manual dispatch defaults to `dry_run=true` for operator inspection. Scheduled runs apply cleanup automatically so old release-window forks do not keep accruing charges.

Use the workflow `hold_names` input, or the production environment variable `PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES`, to keep an active incident or rollback fork. The hold list accepts comma-separated restore-point cluster names or ids; held forks appear in the cleanup artifact under `restorePoints.held` and are excluded from deletion candidates.

When production deploys fail with DigitalOcean database quota errors, first inspect old restore-point forks with the dry-run cleanup helper or manual workflow dispatch. The helper lists managed databases, selects only clusters whose names start with `cs-prod-rp-`, skips held clusters, and defaults to forks at least 6 hours old:

```bash
node ./scripts/production-db-restore-point-cleanup.mjs \
  --out artifacts/release-health/production-db-restore-point-cleanup.json
```

Review the `restorePoints.candidates` list before applying. To delete the selected restore-point forks, rerun with `--apply`; lower `--min-age-hours` only when the linked release issue already confirms the rollback/fix-forward window has closed for the candidate forks:

```bash
node ./scripts/production-db-restore-point-cleanup.mjs \
  --min-age-hours 6 \
  --apply \
  --out artifacts/release-health/production-db-restore-point-cleanup.json
```

## Staging Database Restore Drill

The `Platform Database Restore Drill` workflow (`.github/workflows/platform-database-restore-drill.yml`) runs monthly at off-peak time. The cadence is deliberately monthly because every full drill creates a managed Postgres fork and historically costs about 29 wall-minutes; infrastructure changes that need immediate recovery proof should use the confirmed manual dispatch rather than making every merge group wait on destructive recovery machinery. Manual dispatch requires the exact confirmation phrase `run staging database restore drill`. It is staging-only: it resolves the `chase-sets-staging-postgres` managed Postgres cluster, creates a temporary fork named `cs-stg-drill-<yyyymmdd>-<run-id>-<attempt>`, measures fork-to-available time, validates cheap reads against the expected staging context databases and event-store tables, and destroys the fork in the same script before the job finishes. It must never use `PRODUCTION_DATABASE_CLUSTER_ID` or run with `DEPLOYMENT_ENVIRONMENT=production`.

Database recovery is explicitly two phase: restore the logged event stores and durable operational tables first, then deploy the normal bootstrap/worker runtime and replay every unlogged projection from checkpoint zero when recovery-marker loss is detected. Do not use projection-table row counts as proof that the fork restore failed; unlogged tables may be empty after recovery by design. Restore acceptance must first prove `event_store_streams` and `event_store_events` are present, logged, and readable, then prove the worker detects missing or behind `event_projection_recovery_markers`, resets the affected projection checkpoints, reaches source heads, and serves correct projection-backed reads. No manual projection-table restore or checkpoint edit is part of the recovery path.

The evidence artifact is `artifacts/database-restore-drill/staging-database-restore-drill.json` with 30-day retention. Treat the most recent successful artifact's `timings.forkToAvailableMs` as the current measured restore-time/RTO baseline for DigitalOcean managed-Postgres fork recovery. Timeout artifacts keep `timings.forkToAvailableMs` and `timings.forkAvailableAt` null and record the bounded wait in `timings.forkWaitMs` / `timings.forkWaitFinishedAt` instead. Until the first successful run exists, the RTO baseline remains pending. The artifact records only fork metadata, timings, table names, row-count/max-position aggregates, and cleanup status; it must not contain connection strings, passwords, event payloads, or customer data.

Drift digest recognizes `cs-stg-drill-*` forks as operator-managed restore-drill resources, not unknown databases. Stale drill forks older than the restore-point retention threshold are warning cleanup candidates. If a runner is cancelled after creating a fork, delete it directly with `doctl databases delete <drill-fork-cluster-id> --force`, or run the cleanup helper with `--prefix cs-stg-drill-` after confirming the candidate is not an active drill.

## Staging Rollback Drill

Run the `Platform Staging Rollback Drill` workflow (`.github/workflows/platform-staging-rollback-drill.yml`) quarterly, and before closing #3334 for the first time. It is staging-only and uses the shared `platform-deploy-staging` concurrency group so it cannot race a normal staging deploy. Manual dispatch requires the exact confirmation phrase `run staging rollback drill`, a prior known-good image digest in `sha256:<64 hex>` form, and a `rollback_reference` link showing how the target was selected.

The workflow resolves the staging App Platform app and smoke domains from staging Terraform state, verifies the live app is `chase-sets-staging-platform`, verifies the target image exists in DOCR, captures the currently serving staging image as the roll-forward target, applies the previous digest with `digitalocean-app-deployment.mjs` rollback helpers, waits for App Platform deployment capacity, runs staging smoke on the rollback image, then rolls forward to the captured current image and smokes again. It must never run with `DEPLOYMENT_ENVIRONMENT=production`, use production Terraform state, or rely on a production marker branch.

The evidence artifact is `artifacts/staging-rollback-drill/staging-rollback-drill.json` with 30-day retention. Success requires `phases.rollback`, `phases.rollbackSmoke`, `phases.rollForward`, and `phases.rollForwardSmoke` to be `success`, plus `rollbackTarget.imageExists: true`. The artifact is support-safe: it records app id/name, image refs, component names, phase statuses, timestamps, and non-secret errors only; it must not contain credentials, connection strings, event payloads, or customer data. #3334 should remain open until one live successful workflow run is linked with evidence showing old digest deployed, health checks green on old digest, and roll-forward completed.

The production readiness gate remains warn-and-proceed by design: it records cold-start projection readiness in release-health and step summary evidence, while the proof canary remains the promotion gate. Keep `fetch-depth: 0` in this workflow until the production marker, release-health drift, and exact release-commit checks are split into a targeted fetch helper. Keep the synthetic staging Stripe seller password deterministic until the smoke registration path can receive a generated secret without losing reproducible rerun support; those accounts are staging/test-mode only and should not be used outside smoke evidence.

## Automated Production Rollback

Before production `terraform apply`, the production workflow captures the currently serving App Platform image from the active DigitalOcean app spec, resolves the smoke-verified `production` marker commit, finds the matching `release-*` tag, verifies the rollback image still exists in DOCR, and writes:

- `artifacts/release-health/production-rollback-target.json`
- `artifacts/release-health/production-rollback-readiness.json`

The rollback readiness step fails closed before cutover when the prior known-good image, release tag, registry evidence, or smoke-verified marker cannot be proven. Production release-health records `ROLLBACK_READINESS_RESULT` as `success`, `failure`, or `skipped`; it should not be `unknown` for production deploy attempts.

If post-cutover production smoke, Stage 1 canary, proof-mode Buy Now, or settlement provider-health verification fails after readiness succeeded, the workflow automatically rewrites all App Platform components that use `chase-sets-platform` back to the captured prior image digest/tag and waits for App Platform to finish deploying it. The production marker is not advanced for the failed revision. The release-health record reports recovery mode `rollback`, the rollback target commit, and the workflow-generated rollback reference.

Manual override remains the audited emergency path: set `PRODUCTION_RELEASE_LOCKED=true` to pause normal promotion, then dispatch Platform Deploy with `emergency_release=true` and an `emergency_reference` that links the incident, rollback-readiness evidence, or fix-forward PR. Use `Platform Rollback Readiness` when validating a specific rollback target outside the automatic deploy path. Do not manually move the `production` marker until the rollback or fix-forward image has passed smoke and the incident issue contains the evidence.

As of June 1, 2026, repository evidence shows `main` protected by strict `PR Required`, required conversation resolution, linear history, admin enforcement, and active GitHub native merge queue ruleset `17097957`, `Require merge queue for main`. The `production` marker remains protected by the `Protect production deployed marker` ruleset.

## One-Time State Bootstrap

Create the Spaces bucket before the first platform Terraform init:

```bash
cd infrastructure/digitalocean/state-bootstrap
terraform init
terraform apply
```

Then run `terraform init` in `infrastructure/digitalocean/platform` and `infrastructure/digitalocean/observability` using the appropriate backend key. The CI workflows use the same backend settings.

## Terraform State Snapshot Recovery

The `Platform Terraform State Snapshot` workflow copies durable Terraform state objects into `state-archive/YYYY-MM-DD/<original-key>` every day. It snapshots:

- `landing/staging.tfstate`
- `landing/production.tfstate`
- `environment-dns/staging.tfstate`
- `catalog-assets/preview.tfstate`
- `catalog-assets/staging.tfstate`
- `catalog-assets/production.tfstate`
- `observability/shared.tfstate`

It intentionally excludes disposable PR preview state under `platform/previews/`. The workflow summary and artifact list object keys, archive keys, byte counts, and pruning results only; they must not include state file contents.

To recover a corrupted or accidentally overwritten durable state object:

1. Pause the affected deploy or bootstrap workflow before the next `terraform apply`.
2. Identify the affected key and the last known-good archive date from the workflow summary or artifact.
3. Copy the archived object back to its original key:

```bash
aws s3api copy-object \
  --endpoint-url https://nyc3.digitaloceanspaces.com \
  --bucket chase-sets-terraform-state \
  --copy-source /chase-sets-terraform-state/state-archive/<yyyy-mm-dd>/<original-key> \
  --key <original-key> \
  --metadata-directive COPY
```

4. Initialize the affected Terraform root with its normal backend settings and run `terraform plan`.
5. If the plan matches the expected live infrastructure, resume the paused deploy or bootstrap. If it shows unexpected creates or destroys, keep the workflow paused and open an incident issue with the plan summary and the restored archive key.

Same-bucket snapshots protect against object overwrite and state corruption. They do not protect against bucket deletion, regional Spaces outage, or compromised Spaces credentials.

## One-Time Observability Bootstrap

Create or update the shared staging and production observability host before enabling App Platform telemetry export. When consolidating from the former per-environment roots, use the production observability state as the shared-state base because its Droplet and volume names already match the shared stack. The Terraform root includes `moved` blocks for the production DNS record address changes; import any existing staging `grafana`, `otel`, and `prometheus` DNS records into the new staging keys before applying. The resulting shared-state plan must show address moves/imports only for existing observability resources, not Droplet or volume destroy/recreate.

```bash
cd infrastructure/digitalocean/observability

terraform init \
  -backend-config=bucket=chase-sets-terraform-state \
  -backend-config=key=observability/shared.tfstate \
  -backend-config=region=us-east-1 \
  -backend-config='endpoints={s3="https://nyc3.digitaloceanspaces.com"}' \
  -backend-config=skip_credentials_validation=true \
  -backend-config=skip_metadata_api_check=true \
  -backend-config=skip_region_validation=true \
  -backend-config=skip_requesting_account_id=true \
  -backend-config=use_path_style=true \
  -backend-config=use_lockfile=true

terraform plan -out=tfplan
terraform show -no-color tfplan > ../../../artifacts/terraform-plans/observability-shared-tfplan.txt
terraform apply tfplan
```

Run once for the shared stack. Generate one `grafana_admin_password`, one `otel_write_token`, and one `prometheus_query_token` while staging and production share the host. After apply, copy `app_platform_otlp_headers` to both GitHub Environment `OBSERVABILITY_OTLP_HEADERS` secrets. Copy `prometheus_query_token` to both GitHub Environment `PROMETHEUS_QUERY_TOKEN` secrets so operational evidence workflows can query Prometheus without exposing credentials. Keep the plan text as PR or operations evidence; the deploy lane performs the apply, not local development.

## Catalog Asset Terraform Root

Create or update the stable Catalog asset buckets, CDN endpoints, managed certificates, and CDN custom domains before deploying platform environments that write Catalog provider imagery. For audited staging or production evidence, use the `Platform Catalog Assets Apply` workflow instead of an ad hoc local apply. Run `plan` first, review the uploaded plan artifact, then run `apply` with the exact confirmation text. After apply, the workflow verifies that the Spaces bucket root returns AccessDenied and can verify one support-safe known CDN object path when provided.

```bash
cd infrastructure/digitalocean/catalog-assets

terraform init \
  -backend-config=bucket=chase-sets-terraform-state \
  -backend-config=key=catalog-assets/<environment>.tfstate \
  -backend-config=region=us-east-1 \
  -backend-config='endpoints={s3="https://nyc3.digitaloceanspaces.com"}' \
  -backend-config=skip_credentials_validation=true \
  -backend-config=skip_metadata_api_check=true \
  -backend-config=skip_region_validation=true \
  -backend-config=skip_requesting_account_id=true \
  -backend-config=use_path_style=true \
  -backend-config=use_lockfile=true

terraform apply -var=environment=<environment>
```

Run for `preview`, `staging`, and `production` whenever this root changes. `doctl spaces keys create` can create or rotate the Spaces key used by Terraform and App Platform, and `gh secret set --env <environment>` should then update `SPACES_ACCESS_ID` and `SPACES_SECRET_KEY` for each GitHub environment.

Run `pnpm install --frozen-lockfile` before Terraform apply. The platform Terraform root creates per-context database users and runs the repo-local DigitalOcean grant script so those users receive database and public-schema privileges before App Platform deploys. In staging, Terraform also creates one managed Postgres transaction pool per context database and points runtime `DATABASE_URL_*` variables at the pool URIs. PR previews do not apply this root for live deploys; the preview workflow creates runtime database URLs for disposable in-cluster Postgres and bootstrap creates the users and databases inside the preview namespace.

The platform root treats database provisioning separately from runtime profile exposure. `provisioned_context_names` is the durable database/user set, `active_runtime_context_names` is the set mounted by the selected API and worker profile, and `exposed_route_context_names` is the set allowed to receive routed traffic. Production pre-provisions the canonical platform context databases plus retained historical contexts even while the runtime profile is `landing`. Creating a context database does not expose routes or run workers; profile activation and ingress rules do that. Staging follows the active runtime context set, and PR previews synthesize the same active set into their namespace-local Postgres instance.

Deploy workflows install dependencies before `doctl` authentication and scope provider/admin secrets to validation, Terraform, smoke, and release-marker steps. Dependency installation, local verification, and Docker image construction should not receive provider, database, or admin secrets.

## PR Preview Deployment

Pull requests deploy through `.github/workflows/platform-pr.yml` when they are same-repository deploy-scoped PRs, or when a same-repository PR carries the `preview` label as a manual opt-in.

The preview deployment job runs only after required local CI jobs pass. Full-battery runs also require the affected heavy jobs, including Terraform validation, to pass before preview. Non-deploy-scoped PRs without the `preview` label still avoid spending DigitalOcean deploy capacity.

The workflow:

1. Validates required preview secrets and variables before any deploy step uses them.
2. Builds and pushes `registry.digitalocean.com/<account-registry>/chase-sets-platform:pr-<number>-<head-sha>` with Docker Buildx cache and records the pushed digest in the workflow output.
3. Configures `kubectl` for the shared staging DOKS cluster.
4. Deletes and recreates namespace `chase-sets-pr-<number>` so stale runtime objects and preview database state cannot carry forward.
5. Applies preview runtime secrets, including the in-cluster Postgres superuser and application credentials.
6. Copies the shared `preview-wildcard-tls` Secret (the ONE `*.preview.chasesets.com` certificate, bootstrapped once — see [Preview DNS And TLS](#preview-dns-and-tls)) from the `cert-manager` namespace into this preview's namespace, then deploys the platform Helm release with `previewPostgres.enabled=true`, the pushed image digest, and single-label preview ingress hosts (`pr-<number>[.,-marketplace.,-admin.]preview.chasesets.com`) pointing at that copied secret. No ACME issuance happens in this step or anywhere else in a preview deploy.
7. Verifies the copied TLS secret is present (a fast presence check, not a poll — the copy in the previous step already failed loudly if the shared secret was missing).
8. Waits for preview ingress hosts to become reachable over https and fails with Kubernetes diagnostics if rollout does not complete.
9. Runs `pnpm run smoke:platform` against landing, admin, and marketplace with strict preview smoke requirements.

The preview Kubernetes workloads share the same runtime image and differ only by run command, environment, scaling, health checks, and ingress routing. Staging and production App Platform components keep their existing managed database paths until their own DOKS cutover work explicitly changes them.

## Runtime Profiles

Deployables are runtime composition roots, not bounded-context ownership boundaries. Bounded contexts remain the canonical home for behavior, read models, UI slices, events, and tests; profiles only decide which composition root hosts those slices in a given production posture. See [Deployable Runtime Profiles](../architecture/deployable-runtime-profiles.md) for the durable contract and ADR links.

The typed profile source of truth lives in `@chase-sets/platform-runtime/runtime-profiles`. Production mode and API/worker profiles use the same natural names:

| Production mode | API `CHASE_SETS_RUNTIME_PROFILE` | Worker `CHASE_SETS_RUNTIME_PROFILE` | Runtime posture |
| --- | --- | --- | --- |
| `landing` | `landing` | `landing` | Landing and admin support only; no public marketplace runtime. |
| `proof` | `proof` | `proof` | Private production marketplace proof for provider and live-money evidence. |
| `public` | `public` | `public` | Full public marketplace runtime after launch gates pass. |

Mixed selections fail closed. For example, `productionMode=landing` with `CHASE_SETS_RUNTIME_PROFILE=proof` is invalid because proof routes and live provider callback expectations must not appear in landing mode. The contract also describes mounted context set, provider callback posture, private proof route exposure, worker groups, required secret posture, and smoke expectation. Terraform and workflow issues in the profiled-topology milestone should consume this contract instead of inventing component-name conditionals.

Database lifecycle is a companion track to runtime profile migration, not a side effect of it. Sequence the deployable-profile work in this order:

1. Introduce and consume the typed runtime profile contract.
2. Keep `provisioned_context_names`, `active_runtime_context_names`, and `exposed_route_context_names` separate.
3. Keep production durable database destructive-change guards active for the managed Postgres cluster, context databases, context users, wake-listener users, and context connection pools.
4. Use `connection_budget_profiles` and the push-wake capacity evidence before changing pool maxima, worker concurrency, direct listener counts, or database tier.
5. Treat production PgBouncer as blocked until the session-safety gate splits work-signal waiters from transaction-pooled query traffic.
6. Keep App Platform API/worker topology on the profiled `platform-api`/`platform-worker` components after the profile and database evidence agree.
7. Treat retired admin-support deployables as drift unless a reviewed rollback explicitly owns their temporary return.

Creating a context database/user is reversible only through reviewed database lifecycle work; it never exposes routes or starts workers by itself. Profile activation and ingress rules own exposure.

### Runtime topology and component-count baseline

`scripts/digitalocean-runtime-topology.mjs` is the offline topology fixture for App Platform component shape. It does not call DigitalOcean; it evaluates an App Platform spec against the target runtime mode and reports missing, unexpected, and retired components.

| Topology mode | Expected services | Expected workers | Expected jobs | Component count | Cost direction |
| --- | --- | --- | --- | --- | --- |
| `preview` | `public-web`, `admin-web`, `marketplace`, `platform-api` | `platform-worker` | `platform-bootstrap` | 6 | Disposable full-platform proof; keep small. |
| `staging` | `public-web`, `admin-web`, `marketplace`, `platform-api` | `platform-worker` | `platform-bootstrap` | 6 | Full-platform pre-production baseline. |
| `production-landing` | `public-web`, `admin-web`, `platform-api` | `platform-worker` | `platform-bootstrap` | 5 | Same component count as legacy landing, fewer deployable families to build, route, smoke, and roll back. |
| `production-proof` | `public-web`, `admin-web`, `marketplace`, `platform-api` | `platform-worker` | `platform-bootstrap` | 6 | Adds marketplace web plus full platform proof runtime only while proof evidence is active. |
| `production-public` | `public-web`, `admin-web`, `marketplace`, `platform-api` | `platform-worker` | `platform-bootstrap` | 6 | Final public marketplace baseline after launch gates pass. |

`admin-support-api`, `admin-support-worker`, and `admin-support-bootstrap` are retired component names. Their reappearance should be treated as topology drift unless a reviewed rollback or legacy-cleanup exception names the reason and owner. The target component counts are intentionally normalized counts, not a pricing promise; monthly spend still depends on instance sizes, instance counts, database tier, Spaces/CDN use, registry retention, and observability posture. Directionally, the landing profile reduces operational complexity without increasing App Platform component count.

## Staging Deployment

Staging deploys through `.github/workflows/platform-production.yml` after the `Platform PR` workflow succeeds for a `main` push, before production, when the release commit changed deployable runtime or Terraform surfaces. Staging is a pre-production verification check, not the release destination: it proves the release image can run Terraform-managed migrations/bootstrap and pass smoke checks against durable staging state. Manual dispatch is retained as a redeploy escape hatch for a ref already contained in `origin/main`; manual dispatch compares the requested ref with the `production` marker when available and runs staging before production only when deployment is required. If a queued automatic deployment finally starts after a newer `origin/main` commit exists, the staging job skips deployment work without marking the workflow failed, and production promotion stays skipped because staging did not deploy that stale commit.

The staging job:

1. Uses the release commit resolved by the deployment workflow.
2. Waits for the release commit to have a completed successful `PR Required` check from the Platform PR workflow.
3. Checks out the release commit.
4. Skips stale automatic deployments when the release commit is no longer the current `origin/main`.
5. Validates required staging secrets and variables before any deploy step uses them.
6. Builds and pushes `registry.digitalocean.com/<account-registry>/chase-sets-platform:<release_commit>` with bounded Docker Buildx cache and records the pushed digest in the workflow output.
7. Initializes Terraform with backend key `landing/staging.tfstate`.
8. Runs Terraform fmt and plan for `environment=staging` with the pushed image tag, and records whether `digitalocean_app.platform` will change.
9. Waits for any prior DigitalOcean App Platform deployment to reach a terminal phase before Terraform apply.
10. Runs Terraform apply for `environment=staging`, which runs the App Platform `PRE_DEPLOY` bootstrap and migration path before runtime traffic is validated.
11. Waits for the Terraform-created App Platform deployment to reach a terminal phase when the app spec changed.
12. Creates a forced DigitalOcean App Platform deployment only when Terraform did not change the app spec, waits for completion, and fails unless the deployment phase is `ACTIVE`.
13. Resets only the `staging.chasesets.com` App Platform domain attachment when DigitalOcean reports the stale `DomainZoneInvalid` or `DomainCNAMEMismatch` state left by an earlier subdomain/CNAME configuration.
14. Waits for landing, admin, marketplace, staging root marketplace, and legacy redirect domains. Staging root is deployment-gated because it is the launch-facing marketplace root and App Platform routing/certificate validation depends on child-zone records while Gmail MX/TXT records coexist at the same owner name.
15. Runs `pnpm run smoke:platform` against landing, admin, marketplace, and the staging marketplace root with strict staging smoke requirements, including marketplace UCP discovery at `/.well-known/ucp`, REST profile discovery at `/ucp/v1`, and MCP tool discovery at `/ucp/mcp`.
16. Dispatches `Platform Staging Advisory Evidence` with the exact applied release commit, image, and digest. Its non-quiescing scenario reconciliation and broad deployed marketplace E2E start independently and cannot change the promotion decision. Dispatch failures and advisory run failures create or update the same `Incident: Staging advisory evidence failing` issue; a later successful advisory run closes it.
17. Restores cached Playwright Chromium from `~/.cache/ms-playwright` using a key derived from the pinned Playwright version for the blocking browser probes.
18. Runs the [Buy Now Freshness Probes](./guest-buy-now-freshness-probe.md) (guest and account flows) against the deployed staging marketplace by first waiting for wake-runtime preflight on the admin wake-status endpoint, then discovering an active buyable item from the probe-owned staging search/path contract. The guest email and account are unique to the workflow run; the blocking probe does not use the broad marketplace E2E actor. Each flow records wake preflight status, write-to-checkout-ready latency, browser segments, and a negative invalid-session probe in `artifacts/release-health/guest-buy-now-freshness-probe.json` and `account-buy-now-freshness-probe.json`, and aborts promotion on wake runtime not becoming ready, permanent checkout-session-not-found, missing `afterWrite`, missing guest cookie or account session handoff, a readiness budget miss across the attempt budget (`checkout-ready-slo-exceeded`), a negative probe that masks an invalid session as preparing-checkout, or missing buyable staging fixture state. Results land in the job summary, the `staging-buy-now-freshness-probes` artifact, and the staging release-health record.
19. Runs `pnpm run stripe:money-smoke -- --edge-check --seller-flow` against staging with Stripe test-mode keys and a run-unique synthetic staging seller. Optional GitHub environment variables `STAGING_SMOKE_ORDER_IDS`, `STAGING_SMOKE_BALANCE_CREDIT_AMOUNT`, `STAGING_SMOKE_PAYMENT_METHOD_CATEGORY`, `STAGING_SMOKE_CREATE_PAYMENT`, `STAGING_SMOKE_PAYOUT_AMOUNT`, and `STAGING_SMOKE_REQUEST_PAYOUT` can deepen the payment and payout probes when staging has known safe orders or payout-ready balances.

Production starts automatically only after this staging job deploys the release commit and passes the blocking staging gates. The advisory workflow has no edge into `deploy-production`; its serialized lane bounds mutations without occupying the production workflow's release concurrency group.

Blocking fixture ownership is explicit: platform smoke uses only long-lived `critical-bootstrap` operating data; projection convergence inspects runtime status and needs no scenario rows; Buy Now owns its stable search/path contract plus run-unique guest and synthetic account identities; account-cart consumes only its deliberately configured redacted observation; Stripe creates a run-unique seller. The scenario profile, `MARKETPLACE_E2E_EMAIL`, `MARKETPLACE_E2E_PASSWORD`, and Catalog admin E2E actor belong exclusively to representative advisory evidence.

Representative commerce state is intentionally outside this normal staging deploy path. Run `.github/workflows/platform-staging-representative-commerce-state.yml` after staging reset or after Catalog integration imports when staging needs fresh internal accounts, inventory, listings, offers, and accepted-offer purchase/sale coverage over newly imported Catalog Items.

Staging Postgres storage right-sizing is also outside ordinary staging deploys. The platform Terraform root pins new staging clusters to `staging_database_storage_size_mib = 25600`, but ignores `storage_size_mib` drift on the existing `digitalocean_database_cluster.postgres` resource so a routine deploy does not resize or replace the live cluster. Activate the smaller allocation through the `Platform Staging Reset` workflow only: dispatch it with the exact `reset staging` confirmation, let it destroy and recreate staging Postgres, then run the representative commerce state workflow if staging needs product-review data rebuilt over fresh Catalog output. The monthly `Platform Database Restore Drill` creates and deletes temporary forks only; it is recovery evidence, not a staging rebuild window for this storage change.

## Preview Cleanup

Closed and merged pull requests destroy their preview environment through `.github/workflows/platform-preview-cleanup.yml`. The same workflow also runs a once-daily safety sweep that lists disposable preview Terraform state objects under `platform/previews/`, leaked preview Kubernetes namespaces, and forbidden live preview database clusters. Any `chase-sets-pr-<number>-postgres` managed cluster is a policy violation because PR previews must use namespace-local Postgres.

The cleanup workflow runs with the trusted base workflow definition and deletes the matching `chase-sets-pr-<number>` namespace. Namespace deletion removes the preview Postgres Deployment, Service, Secrets, runtime workloads, and disposable database data. Legacy preview Terraform state and any forbidden managed preview database cluster remain sweep findings until an operator deletes them through the approved cleanup path.

If cleanup fails, rerun the cleanup workflow for the closed PR. Inspect the uploaded cleanup logs before removing a legacy state key by hand. The scheduled sweep uploads `platform-preview-cleanup-sweep` evidence with candidate state keys, live preview database cluster names, leaked namespace names, and selected PR numbers, but does not read Terraform state contents. For operator-approved cleanup outside the PR-close workflow, `node scripts/digitalocean-preview-cleanup-sweep.mjs cleanup-databases` lists leaked preview database clusters in dry-run mode by default; deletion requires `--delete --confirm "delete leaked preview database clusters"`.

## Production Deployment

Production deploys automatically through `.github/workflows/platform-production.yml` after the staging job succeeds. It promotes the same immutable commit-tagged image that staging just deployed, instead of rebuilding a second artifact. Non-deployable release commits do not reach production promotion because staging is intentionally skipped.

Production is intentionally gated to the `landing` runtime profile by default. Operators may set `PRODUCTION_RUNTIME_PROFILE=proof` to run the profiled `platform-api`, `platform-worker`, and platform bootstrap across the full platform context set for private provider proof collection while public marketplace web/domain exposure remains disabled. Proof and public profiles require live Stripe keys, separate Stripe payment and Connect webhook secrets, EasyPost production key, EasyPost webhook secret, `EASYPOST_MODE=production`, and unset provider API base URL overrides because production `platform-api` must not start with fake money, sandbox postage, or redirected provider endpoints. Landing disables UCP, native MCP, and provider webhook ingress; proof/public route those paths plus public/admin `/api/*` traffic to `platform-api`. Admin-web server-side loaders always use the internal `platform-api` private URL through `CHASE_SETS_INTERNAL_API_ORIGIN`.

The former private production proof readiness preflight is retired. Keep provider dashboard destinations, live smoke setup, and approval fields owned by the money, fulfillment, notifications, launch supply, tax, and marketplace promotion runbooks; then use the final public launch readiness preflight below to validate production GitHub Environment variables and secret names before promotion.

After proof mode deploys, run:

```powershell
pnpm run ops marketplace:production-proof-topology-evidence --base-url https://marketplace.chasesets.com --reference PRODUCTION-PROOF-2026-05-30 --operator "ops@chasesets.com" --proof-enabled true --public-enabled false
```

The command fails until the base URL is `https://marketplace.chasesets.com`, `https://chasesets.com`, or `https://admin.chasesets.com`, `/api/health/ready` returns JSON `200`, Stripe payment, Stripe Connect money-movement, SES/SNS email, and EasyPost postage callback paths return JSON `200` or `400` without redirects, the private Checkout/Ordering/Payments/Settlement proof APIs used by live money smoke and deferred-checkout order creation return JSON `401` without redirects, the private Inventory/Marketplace launch-supply proof APIs return JSON `401` without redirects, the proof marketplace web route reaches the authenticated marketplace payout setup page instead of returning 404, proof mode is explicitly enabled, and public marketplace promotion remains disabled. Attach the redacted output to the private proof record before configuring provider dashboards or creating launch-supply proof listings.

The public marketplace is deployed to production only when the production GitHub Environment sets `PRODUCTION_RUNTIME_PROFILE=public` and `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true`, and the Marketplace promotion, Marketplace Checkout Fee, Checkout Launch, Support operations, Fulfillment postage, transactional email, launch supply measurement, and Tax approval variables all approve the launch posture. Keep `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED` unset or `false` until the [marketplace production promotion](./marketplace-production-promotion.md) gates are complete.

After all launch gates pass and production variables are set from the owner approval records, run the final public launch readiness preflight before triggering production promotion:

```powershell
gh variable list --env production --json name,value > .\secure\github-production-variables-2026-05-30.json
gh secret list --env production --json name,updatedAt > .\secure\github-production-secrets-2026-05-30.json
pnpm run ops marketplace:production-launch-readiness --variables .\secure\github-production-variables-2026-05-30.json --secrets .\secure\github-production-secrets-2026-05-30.json
```

This command combines the public launch variable snapshot with required production secret-name checks and fails until public promotion is on, proof mode is off, approval references are real, admin Google Workspace SSO is configured for `chasesets.com`, live Stripe/EasyPost secret names exist, and Amazon SES is set to `transactional-production`.

The workflow:

1. Checks out the release commit that already passed `PR Required` and staging deployment.
2. Skips stale automatic deployments when the release commit is no longer the current `origin/main`, then writes staging release-health evidence for the skipped attempt.
3. Evaluates the production release lock. Normal promotion stops when `PRODUCTION_RELEASE_LOCKED=true`; audited emergency releases may proceed only with the manual `emergency_release=true` input and a concrete `emergency_reference`.
4. Validates required production secrets and variables. When `PRODUCTION_RUNTIME_PROFILE` is `proof` or `public`, validation requires Stripe live-mode keys, separate Stripe payment and Connect webhook secrets, EasyPost production API and webhook configuration before provider routes can deploy. When `PRODUCTION_RUNTIME_PROFILE=public` and `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true`, workflow validation and Terraform checks also require `PRODUCTION_MARKETPLACE_PROMOTION_APPROVED=true`, a real `PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE`, approved Marketplace Checkout Fee evidence, approved Checkout Launch evidence, approved Stripe money operations evidence, approved Support readiness, approved Fulfillment postage evidence, approved transactional email evidence, approved launch supply measurement evidence, approved Tax readiness evidence, an explicit `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true` or `false` value from the Tax readiness record, and complete Amazon SES transactional email configuration. Terraform rejects placeholder-like production evidence references even when they are non-empty.
5. Verifies `registry.digitalocean.com/<account-registry>/chase-sets-platform:<release_commit>` already exists in DigitalOcean Container Registry. If it is missing, run a successful staging deployment for that commit before production promotion.
6. Runs Terraform fmt and plan for `environment=production` with the staging-promoted image tag, blocks destructive changes unless `.github/deployment/production-destructive-change-approved.md` exists in the reviewed commit and names the exact Terraform resource addresses being deleted, and records whether `digitalocean_app.platform` will change.
7. Waits for any prior DigitalOcean App Platform deployment to reach a terminal phase before Terraform apply.
8. Runs Terraform apply for `environment=production`.
9. Waits for the Terraform-created App Platform deployment to reach a terminal phase when the app spec changed.
10. Creates a forced DigitalOcean App Platform deployment only when Terraform did not change the app spec, waits for completion, and fails unless the deployment phase is `ACTIVE`.
11. Runs `pnpm run smoke:platform` with required admin authentication, `ops+smoke@chasesets.com`, and smoke UTM markers. When marketplace promotion is enabled, production smoke also requires the production marketplace domain. Proof mode waits for the production marketplace domain but verifies its gated proof routes through production proof topology evidence instead of public marketplace smoke.
12. Runs the Stage 1 production URL smoke (the "production canary" probes) against synthetic/operator-safe endpoints: landing, admin, and marketplace only when public marketplace is enabled. This is post-deploy smoke against the single rolled-out release, not a canary deployment or traffic split; it blocks the production marker when the deployed production reality fails basic smoke verification.
13. While `PRODUCTION_MARKETPLACE_PROOF_ENABLED=true`, runs the proof-mode [Buy Now Freshness Probe](./guest-buy-now-freshness-probe.md) (authenticated flow with the dedicated `PRODUCTION_PROOF_CANARY_EMAIL`/`PASSWORD` pair, or the `PLATFORM_ADMIN_EMAIL`/`PASSWORD` launch fallback, against the permission-gated proof marketplace host, same readiness budget and negative probe as staging). It writes `artifacts/release-health/production-proof-buy-now-freshness-probe.json`, records the result in the job summary, and blocks the production marker when it fails.
14. While `PRODUCTION_MARKETPLACE_PROOF_ENABLED=true`, signs in with the same proof operator credential pair and calls the authenticated Settlement provider-health endpoint. It writes `artifacts/release-health/production-settlement-provider-health-probe.json`, emits the `provider-health-checked` settlement operation telemetry, waits for OTLP export and Prometheus scraping (`PRODUCTION_SETTLEMENT_CANARY_SCRAPE_WAIT_SECONDS`, default 90 seconds) so the signal lands on the settlement dashboards, and blocks the production marker when it fails.
15. Adds a matching `release-<yyyymmddHHMMSS>-<sha>` DOCR tag to the promoted image, creates the annotated Git release tag, and fast-forwards the protected `production` branch to the smoke-verified deployed release commit.
16. Writes a `release-health/v1` artifact with queue timing, exposure-posture categories, staging and production results, the canary result (Stage 1 production canary plus the proof-mode Buy Now and Settlement provider-health probes when they run), release-lock state, release attempt phase/reason, and recovery metadata. Staging failures and stale staging skips upload `staging-release-health`; production attempts upload `production-release-health` including the proof-mode probe evidence.

### DOKS Rollouts Scaffold

Staging enables proportional Argo Rollouts for `public-web`, `marketplace`, and `platform-api` through `values.staging.yaml`. nginx receives 10% first; the controller calls each canary Service's existing readiness endpoint three times and auto-aborts on one failure. The release remains paused at 10% while the workflow runs its existing smoke, projection convergence, Buy Now freshness, and money checks. A green verification tail promotes the rollout through analyzed 25%, 50%, and 100% steps; a failed tail explicitly aborts before incident classification continues.

Production remains disabled by default because #4053 still owns its DOKS ingress/DNS cutover. `PRODUCTION_ARGO_ROLLOUTS_ENABLED=true` is the operator flip, but set it only after the production Argo add-on is installed and production DOKS ingress serves the real hosts; Helm intentionally fails when proportional routing is enabled without DOKS ingress. While the flag is false, the Stage 1 production canary remains post-deploy synthetic smoke against one release, not a traffic split.

### Terraform Errored State Recovery

When staging or production platform `terraform apply` fails after Terraform reports that it wrote `errored.tfstate`, the deploy workflow captures that file as a sensitive, recovery-only artifact named `sensitive-<environment>-terraform-errored-state-recovery-only` with 1-day retention. The workflow only writes presence/absence to the job summary and must never print the state contents.

Use the artifact only during the incident it was created for. First inspect the incident timeline, confirm no other platform Terraform run is active or queued for the same backend key, and verify the Spaces backend credentials and `.tflock` posture are healthy. Download the artifact to a secure local working directory, initialize Terraform against the same backend key, and run `terraform state push errored.tfstate` only when the backend is writable and the failed apply's live-resource changes are the intended state to preserve. After the push, run a backend-backed `terraform plan` or controlled replacement deploy to confirm the live resources, backend state, and deployment marker are reconciled. Delete local copies after recovery evidence is posted.

Use the `Platform Emergency Recovery` workflow as the guided front door for fix-forward, revert, rollback, and rollback-readiness paths. It validates the emergency reference, names whether release-lock bypass is allowed, and uploads `emergency-recovery-guide` evidence. Use the `Platform Rollback Readiness` workflow before rollback recovery. It validates the target commit, release tag, DOCR image, smoke-verified production marker, emergency reference, and destructive Terraform approval posture without deploying the target.

Production destructive-change overrides must be explicit in the pull request. Add `.github/deployment/production-destructive-change-approved.md` only for a deliberately reviewed infrastructure migration, list each approved Terraform resource address under `Approved Destructive Changes`, and remove the marker in the same PR or an immediate follow-up when the migration is complete. The deploy helper fails closed when the plan contains a destructive action that is not listed in the marker. Durable database deletes are guarded separately for the managed Postgres cluster, context databases, context users, wake-listener users, and context connection pools: profile/topology changes should use profile gating or retained context provisioning, recovery should use PITR/restore procedures, and only an audited resource-scoped emergency override may name those database resources for deletion or replacement.

### Stateful Destroy Guard Override

Default Terraform plans must not delete or replace stateful roots. A deliberate `terraform plan -destroy -target=digitalocean_database_cluster.postgres[0]`, `digitalocean_volume.observability_data`, `digitalocean_spaces_bucket.catalog_assets`, `digitalocean_spaces_bucket.terraform_state`, or `digitalocean_domain.environment` should fail at plan time because the resource has `prevent_destroy`.

Use the guard bypass only for an approved destructive workflow or an incident-specific recovery plan. The approved preview cleanup and staging reset workflows run `node scripts/disable-terraform-prevent-destroy.mjs <main.tf>` inside their ephemeral checkout immediately before `terraform destroy`; they do not commit the bypass. For any other case, document the incident or migration reference, name the exact resource address, take the required restore point or backup first, perform the same temporary source edit locally, run and capture the plan, apply only after review, and then restore the guard in source before merging follow-up work.

Topology/release-health evidence for profile migration must include:

- selected production mode and runtime/worker profiles;
- provisioned, active runtime, and exposed route context counts;
- `connection_budget_profiles` for landing/proof/public, including steady-state and rolling-deploy headroom;
- PgBouncer posture, including whether production query traffic remains direct or is explicitly routed through a session-safe pooling split;
- destructive database guard outcome and any reviewed override marker addresses;
- restore expectation: projection rebuild for derived read models, managed Postgres PITR for cluster/database recovery, or a precreated restore-point fork only when the release recovery mode requires it.

Use a precreated production database fork for release windows that carry reviewed data-destructive migrations, provider/live-money evidence that cannot be replayed safely, or an emergency reference that explicitly calls for a fork. Ordinary runtime profile changes, route exposure changes, worker runner changes, and projection rebuilds should rely on retained contexts plus the standard DigitalOcean PITR/backups posture instead of creating a fork by habit.

## Smoke Coverage

The platform smoke script checks:

- landing home page loads
- landing API readiness passes through the deployed API component
- admin home page loads
- admin API readiness passes through the deployed API component
- marketplace home and search pages load when a marketplace URL is supplied
- legacy dash-based staging URLs return temporary HTTPS `302` redirects to their nested equivalents when supplied, including `landing-staging.chasesets.com` to `www.staging.chasesets.com`
- waitlist signup accepts a tagged synthetic lead
- admin password sign-in works when admin credentials are supplied
- waitlist admin endpoint can find the synthetic lead when the smoke wrote one
- Commercial Terms schedules and agreements admin pages load under authenticated admin smoke, exercising the admin server-side loader path to the platform API. Production landing uses the `platform-api` landing profile for landing admin routes; proof/public use the same component with broader mounted contexts.

Catalog asset CDN smoke verifies that each environment's `CATALOG_ASSET_PUBLIC_BASE_URL` resolves over HTTPS and returns the expected protected-root `403` after the `catalog-assets` Terraform root applies and during staging/production platform smoke. A known object URL must return `200`; that proof belongs in the `Platform Catalog Assets Apply` workflow with a support-safe object path, or in provider-import evidence that confirms the stored URL starts with the environment CDN base URL.

Set `SMOKE_REQUIRE_ADMIN=true` and `SMOKE_REQUIRE_MARKETPLACE=true` for preview CI and staging. Staging also sets `SMOKE_REQUIRE_LEGACY_REDIRECT=true` and `SMOKE_WRITE_WAITLIST=false`. Production sets `SMOKE_REQUIRE_ADMIN=true`. Set `SMOKE_WRITE_WAITLIST=false` only for an intentionally read-only smoke check.

Production sets `SMOKE_REQUIRE_MARKETPLACE=true` only when `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true` after launch, Marketplace Checkout Fee, Checkout Launch, Support operations, Fulfillment postage, transactional email, launch supply measurement, and Tax approval evidence has passed validation. The current production posture should not include a marketplace URL in smoke output.

Production secrets are scoped to validation, Terraform, smoke, and Git release-marker steps. The production workflow must not run dependency installation, workspace builds, or Docker builds with production provider/admin secrets in scope.

`platform-worker` is deployed as an App Platform worker component, not a public service component. It still runs its local HTTP health and status endpoints for process diagnostics, but App Platform does not route public ingress to them. The workflow verifies that the deployment reaches `ACTIVE` after DigitalOcean starts the worker process. Staging keeps two `apps-s-1vcpu-2gb` worker instances as an explicit #4035 cost-vs-confidence decision while it is the shared full-platform proof lane: wake drills, representative catalog/import windows, and rolling deploy handoff all need capacity during the same pre-launch evidence period. Do not downsize staging to one steady worker until DOKS cutover provides KEDA/HPA-style burst capacity or release-health evidence shows at least ten deployable attempts with green wake drills, representative imports, and no staging stale-skip/deploy-handoff cause under review. Production defaults remain conservative; operators can scale `worker_instance_count`, `worker_job_concurrency`, and `worker_database_pool_max` together when production backlog or deploy-handoff measurements justify it.

## Recovering Non-Production Connection Exhaustion

If staging deployment fails in `platform-bootstrap` with PostgreSQL `53300` / `remaining connection slots are reserved for roles with the SUPERUSER attribute`, the active non-production app or bootstrap job exceeded the managed database tier's connection budget. If a PR preview hits connection exhaustion, delete and recreate the preview namespace first because preview database state is disposable and not backed by a managed tier.

1. Confirm the Terraform spec includes component-specific `DATABASE_POOL_MAX` values and does not let a single worker process exceed the database tier's connection budget.
   Worker startup now fails when configured runner concurrency exceeds `DATABASE_POOL_MAX`, unless `ALLOW_WORKER_OVER_POOL_CAPACITY=true` is explicitly set for local testing. Do not set that override in staging or production.
2. Confirm staging uses the explicit hot-context pool sizes on a `db-s-2vcpu-4gb` or larger database tier.
3. Confirm staging runtime `PLATFORM_CONTROL_DATABASE_URL` and `DATABASE_URL_*` variables resolve to connection pool URIs, not direct database URLs.
4. Re-run the PR workflow for preview or the deployment workflow for staging.
5. If a preview app is still holding too many direct connections, rerun the preview cleanup workflow and then rerun the PR workflow. If staging is affected, wait for the active staging deployment to finish or manually scale down the staging app before rerunning deployment.
