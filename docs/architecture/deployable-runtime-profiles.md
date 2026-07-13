# Deployable Runtime Profiles

Issue: #3242

Runtime profiles describe how production composition roots run without changing bounded-context ownership.

## Source Of Truth

The typed profile contract is exported from `@chase-sets/platform-runtime` and implemented in `infrastructure/platform-runtime/runtime-profiles.ts`.

The DOKS component baseline is owned by `infrastructure/helm/platform/runtime-values.json` and its generated Helm values; use it for expected-vs-actual topology evidence instead of copying component lists into release notes.

Production mode, API profile, and worker profile use the same names:

| Mode | API profile | Worker profile | Purpose |
| --- | --- | --- | --- |
| `landing` | `landing` | `landing` | Landing and admin support only; no public marketplace runtime. |
| `proof` | `proof` | `proof` | Private production marketplace proof for provider and live-money evidence. |
| `public` | `public` | `public` | Full public marketplace runtime after launch gates pass. |

`requireValidRuntimeProfileSelection` fails closed when a mode/profile selection is unknown or mixed. Profile consumers should call the shared contract instead of inventing component-name or environment-variable conditionals.

## Deployable Role Model

Deployables are runtime composition roots:

- web deployables compose route trees and request shells;
- `platform-api` composes context API mounts, provider callbacks, and health/readiness endpoints;
- `platform-worker` composes worker groups, projection runners, provider jobs, and wake processors;
- bootstrap jobs compose schema, seed, and reconciliation startup work.

Bounded contexts remain the canonical home for behavior, read models, UI slices, events, and tests. Shared cross-context contracts belong in `contracts/` or `infrastructure/`. Deployable-local code should stay limited to runtime wiring, config, ingress, health, and platform integration.

## Profile Contract

Each profile declares:

- mounted context set;
- public marketplace route exposure;
- private proof route exposure;
- provider callback posture;
- worker groups;
- required secret posture;
- smoke expectation.

`landing` mounts only the landing admin/support surface. `proof` mounts the full platform for private provider/live-money evidence while public marketplace promotion remains disabled. `public` mounts and exposes the full marketplace after launch approval gates pass.

## Database Lifecycle

Runtime activation is separate from database provisioning. See [Deployable Profile Database Companion](./deployable-profile-database-companion.md).

Operators should read these context sets independently:

- `provisioned_context_names`: durable databases and users Terraform manages;
- `active_runtime_context_names`: contexts mounted by selected API and worker profiles;
- `exposed_route_context_names`: contexts reachable through ingress.

Creating a context database does not expose routes or run workers. Profile activation and ingress rules own exposure.

## Evidence Checklist

Profile/topology PRs and release records should name:

- selected production mode, API profile, and worker profile;
- mounted, exposed, and provisioned context counts;
- provider callback posture and required secret posture;
- smoke expectation and actual smoke/proof evidence;
- `connection_budget_profiles` headroom for `landing`, `proof`, and `public`;
- destructive database guard result and any exact reviewed override addresses;
- restore expectation: projection rebuild, managed PITR/backups, or a precreated fork.

Add a new ADR before introducing another production posture, a new image group, or a new deployable family.
