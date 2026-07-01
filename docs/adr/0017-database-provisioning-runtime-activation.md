# ADR 0017: Database Provisioning Is Separate From Runtime Activation

## Status

Accepted for milestone #69

## Context

Deployable profiles decide which runtime behavior is mounted, reachable, and running. Database provisioning decides which durable context databases, users, wake-listener users, and connection pools exist.

Production profile changes must not imply accidental deletion of canonical context data. At the same time, production may pre-provision full-platform context databases before proof or public marketplace routes are exposed.

## Decision

Keep database provisioning separate from runtime activation and route exposure.

Terraform names three context sets:

- `provisioned_context_names`: durable context databases and users that should exist.
- `active_runtime_context_names`: contexts mounted by the selected API and worker profiles.
- `exposed_route_context_names`: contexts reachable through ingress.

Production can provision the canonical platform context database set while staying in `landing` mode. Creating a database/user never exposes a route, starts a worker, or promotes marketplace behavior. Preview and staging may remain disposable because their cleanup workflows own their environment state.

## Alternatives Considered

- Derive database lifecycle from active profile. Rejected because mode changes could plan destructive production database/user changes.
- Use one database cluster per bounded context. Rejected because the current managed Postgres cluster plus per-context databases/users is simpler to operate, budget, back up, and recover at current scale.
- Move to self-managed Postgres. Rejected because DigitalOcean Managed Postgres PITR/backups and Terraform-managed users fit the current operational model with less custom database administration.

## Consequences

Production profile/topology releases must include context-set evidence, connection-budget headroom, destructive database guard results, and restore posture. Routine profile, route, worker, and projection changes should use retained context databases plus managed PITR/backups rather than precreated forks by habit.

Destructive database changes require explicit reviewed override evidence. Profile changes should use profile gating, not database deletion, to change exposure.

This decision supports issues #3223, #3224, #3225, #3226, #3227, #3220, and #3242.
