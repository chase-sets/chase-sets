# Push-Wake Connection Budget

The DOKS runtime is the only compute estate. Managed Postgres remains the hard shared limit, so every connection source must be classified as pooled or direct.

## Rules

- Query traffic uses the Terraform-managed PgBouncer transaction pools in staging and production. Cluster backend demand is capped by the per-context pool sizes in `context_database_connection_pool_sizes`.
- `LISTEN` is incompatible with transaction pooling. Relay listeners use dedicated least-privilege `cs_<env>_<context>_wake_listener` users and direct cluster URLs.
- Context waiters and schema bootstrap also use direct URLs because they require session behavior.
- Preview Postgres is in-cluster and outside the managed-cluster budget.
- A rolling DOKS update may overlap old and new pods; capacity evidence must include that peak, not only steady state.

## Runtime Budgets

The canonical worker runner and client-pool values live in `infrastructure/helm/platform/runtime-values.json`. Staging-only wake/autoscaling overrides live in the generated `values.staging.yaml`. The runtime startup assertion requires the sum of projection, operations, job, import, dispatch, scheduled, and wake runner concurrency to stay at or below `DATABASE_POOL_MAX`.

Terraform owns server-side context pool sizes and exposes the direct listener/waiter URLs. Capacity reviews must derive current values from these source-owned Terraform and Helm files; do not duplicate totals in release notes.

## Change Procedure

Before increasing replicas, KEDA limits, runner concurrency, context pool sizes, listener coverage, or waiter counts:

1. update the source-owned Helm or Terraform value;
2. regenerate Helm values;
3. calculate the managed-pool and direct-connection envelopes from the checked-in sources;
4. include steady and rolling-overlap totals against the provider connection limit;
5. validate Terraform without credentials;
6. attach the reviewed evidence to the rollout decision.

A scale change that cannot demonstrate hard-limit headroom must not ship.
