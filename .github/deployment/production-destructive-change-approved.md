# Production Destructive Change Approval

Approval reference: #1404
Reviewed on: 2026-06-12
Owner: Platform Operations

## Approved Destructive Changes

- `digitalocean_database_db.contexts["experience"]`
- `digitalocean_database_db.contexts["insights"]`
- `digitalocean_database_db.contexts["support"]`
- `digitalocean_database_user.contexts["experience"]`
- `digitalocean_database_user.contexts["insights"]`
- `digitalocean_database_user.contexts["support"]`

## Reason

PR #1390 merged the former `experience`, `insights`, and `support` bounded contexts into
`platform-operations` slices. Their runtime behavior now lives in Platform Operations as
`platform-feedback`, `insights-dashboards`, and `support-requests`, while the public API
mounts and durable event stream prefixes remain stable.

## Evidence

- Context ownership: `bounded-contexts/platform-operations/context.json`
- Context docs: `bounded-contexts/platform-operations/README.md`
- Infrastructure source: `infrastructure/digitalocean/platform/locals.tf`
- Failed deploy requiring this approval: https://github.com/chase-sets/chase-sets/actions/runs/27392938391

This approval is intentionally scoped to the six retired context database/user resources
above. Any additional destructive Terraform action must fail closed and receive a separate
reviewed approval.

## Rollback Posture

Rollback should redeploy a commit before #1390 only through the emergency recovery path.
The merged Platform Operations runtime owns the active schema, seeds, routes, API mounts,
and support/feedback/dashboard slices after #1390; these retired resources must not be used
as hidden compatibility, old-session repair, or fallback data sources for Milestone #17.
