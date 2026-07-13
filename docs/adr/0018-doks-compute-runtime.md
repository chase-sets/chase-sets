# ADR 0018: DOKS Compute Runtime

## Status

Accepted for milestone #103

Supersedes the compute-runtime posture in [ADR 0015](./0015-deployables-as-runtime-composition-roots.md), where Kubernetes was rejected as unnecessary pre-launch complexity. ADR 0015 remains authoritative for deployables as thin runtime composition roots and bounded contexts as the home for behavior.

## Context

At decision time, the DigitalOcean App Platform deploy lane was being stabilized under milestone #101 and was the main operational constraint for deploy cadence, runtime topology control, worker handoff, and deployment observability.

Chase Sets is also about to enter the 30-day beta campaign window tracked by #97. The platform should settle on the production compute model before public launch traffic and campaign learning make infrastructure churn more expensive.

This decision is about compute and runtime orchestration only. DigitalOcean Managed Postgres remains the durable event-store/read-model data tier, with managed backups/PITR, context databases, users, PgBouncer posture, and stateful destroy guards governed by the existing database ADRs and runbooks. Spaces-backed assets, Terraform state, DNS, and observability storage are not moved by this decision.

## Decision

Migrate Chase Sets runtime compute from DigitalOcean App Platform to DigitalOcean Kubernetes (DOKS) before public launch.

The DOKS migration is milestone #103 execution work and starts only after:

1. milestone #101 stabilizes the current deploy lane;
2. #97 starts the 30-day beta campaign clock; and
3. the DOKS execution plan preserves the runtime profile contract, managed data-tier boundaries, smoke/proof evidence, rollback path, and release-health reporting.

`public-web`, `marketplace`, `admin-web`, `platform-api`, `platform-worker`, and `platform-bootstrap` remain deployable composition roots. DOKS replaces the host/orchestration layer for those roots; it does not create bounded-context service ownership, move behavior into deployables, split databases by runtime component, or make Kubernetes namespaces a domain boundary.

## Observable Triggers

Begin #103 execution when all of these are observable:

- #101 has a green staging-to-production deploy lane with no active deploy-stabilization incident.
- #97 has recorded the beta campaign start date and public-launch timing pressure is real.
- App Platform deployment health, logs, worker lifecycle behavior, or topology controls remain material launch risks even after #101 stabilization.
- The DOKS plan can show equivalent or better smoke coverage, release-health artifacts, rollback decision points, secret posture, and production marker discipline than the App Platform runbook.
- Managed Postgres connection budgets, PgBouncer/direct listener posture, and stateful destroy guards remain unchanged or explicitly improved by the compute migration plan.

Pause or revisit the migration if any of these are observed:

- #101 remains unstable or production deploy recovery is still under active incident response.
- DOKS planning requires a data-tier migration, self-managed Postgres, or destructive database replacement.
- The migration would land during the beta campaign without a rehearsed rollback and operator runbook.
- App Platform stabilization removes the launch-blocking runtime constraints and the remaining DOKS value is only theoretical.

## Alternatives Considered

- Keep App Platform through launch. Rejected because it preserves the current deployment and topology constraints into the beta-to-launch window, where compute migration becomes harder to rehearse and less forgiving.
- Move only workers to DOKS. Rejected for now because split orchestration would double release, secret, smoke, log, and rollback surfaces while leaving web/API deploy behavior on App Platform.
- Migrate the data tier with compute. Rejected because managed Postgres already owns the durable event-store/read-model posture with better pre-launch recovery and lower operational burden than self-managed database operations.
- Split runtime by bounded context while migrating. Rejected because bounded contexts own behavior, not runtime topology. Premature service splitting would increase images, manifests, network policies, and release coordination before measured isolation requires it.

## Consequences

#103 must produce a compute migration plan and implementation that treats deployables as thin composition roots, keeps shared folders tiny, and preserves bounded-context ownership. Kubernetes manifests, Helm charts, or controllers must express runtime profiles, health, ingress, worker lifecycle, and secrets without reintroducing deployable-local business behavior.

The migration raises operational complexity: cluster upgrades, node pools, ingress, pod disruption budgets, rollout strategy, autoscaling, image promotion, and Kubernetes observability become Chase Sets responsibilities. The trade is accepted because the platform gains clearer runtime control, worker shutdown/handoff semantics, deployment introspection, and topology flexibility before launch traffic hardens the deployment path.

DOKS is now the implemented compute runtime. [DigitalOcean Platform Deployment](../runbooks/digitalocean-platform-deployment.md) documents the supporting Terraform and deployment composition; [DOKS Platform Operations](../runbooks/doks-platform-operations.md) is the runtime operator guide.

This decision supports issue #4042 and sequences milestone #103 after #101 and #97.
