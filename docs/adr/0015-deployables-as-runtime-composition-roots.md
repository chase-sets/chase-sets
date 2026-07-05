# ADR 0015: Deployables As Runtime Composition Roots

## Status

Accepted for milestone #69

Compute-runtime posture superseded by [ADR 0018: DOKS Compute Runtime](./0018-doks-compute-runtime.md). The deployable ownership model in this ADR remains accepted.

## Context

Chase Sets is consolidating duplicate runtime components such as `admin-support-api` and `admin-support-worker` into profiled `platform-api` and `platform-worker` components. The consolidation must not move behavior ownership into deployables or imply that each bounded context deserves its own service boundary.

Bounded contexts are already the canonical home for behavior, read models, UI slices, events, and tests. Deployables assemble those context-owned modules for a runtime posture: web surface, API host, worker host, bootstrap job, ingress, scaling, health checks, and secrets.

## Decision

Deployables are runtime composition roots, not bounded-context ownership boundaries.

`public-web`, `marketplace`, and `admin-web` compose browser/server routes. `platform-api` composes context API mounts and provider callbacks. `platform-worker` composes worker groups, projection runners, provider jobs, and wake processors. Bootstrap jobs compose schema, seed, and reconciliation startup work. Cross-context behavior remains in bounded contexts, contracts, or infrastructure packages, not in deployable-specific business logic.

## Alternatives Considered

- Keep separate support and full-platform deployables. Rejected because the duplicate API/worker families make production posture, cost, smoke checks, rollback, and connection budgeting harder to reason about.
- Split one deployable per bounded context. Rejected because it would turn domain ownership into a runtime topology by default, multiplying images, App Platform components, secrets, health checks, and rollback paths without measured isolation need.
- Move to Kubernetes or custom container orchestration first. Rejected at milestone #69 because the App Platform model could express the then-needed profiles with lower operational complexity. Superseded for pre-launch compute/runtime planning by [ADR 0018](./0018-doks-compute-runtime.md), after deploy-lane stabilization and beta-clock sequencing changed the trade-off.

## Consequences

New behavior belongs in the owning bounded context first. Deployables may select, mount, scale, and protect that behavior, but should stay thin.

A new deployable or image group requires measured runtime need and an owner-visible rollback/smoke path. Otherwise, use a runtime profile on the existing composition roots.

This decision supports issues #3213, #3214, #3219, #3220, and #3242.
