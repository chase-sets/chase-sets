# Deployable Profile Database Companion

Issue: #3227

Deployable profiles control which runtime slices are mounted, exposed, and running. Database provisioning controls which durable context databases and users exist. Those are separate lifecycle decisions.

## Context Sets

- `provisioned_context_names`: durable databases and users Terraform manages.
- `active_runtime_context_names`: contexts mounted by the selected API and worker profile.
- `exposed_route_context_names`: contexts reachable through ingress for the selected production mode.

Production may pre-provision the full canonical context database set while staying in landing mode. Creating a database/user does not expose a route, run a worker, or promote marketplace behavior. Preview and staging can stay disposable because their cleanup workflows own their databases.

## Migration Sequence

1. Define the typed runtime profile contract (#3212).
2. Separate provisioned, active, and exposed context sets (#3223).
3. Guard durable production database deletes/replacements (#3224).
4. Publish profile-aware connection budget output (#3225).
5. Converge production query traffic onto managed transaction pools once session-safety proof and waiter splitting are complete (#3226, #3234; landed by #4655 with production query pools and `production_pgbouncer_ready = true`, waiter/listener/bootstrap traffic direct).
6. Cut over profiled API and worker topology (#3213-#3217).
7. Update topology fitness and remove retired deployables only after release-health evidence is clean (#3218, #3219).

## Restore Expectations

- Projection/read-model drift: rebuild or replay from canonical source events.
- Managed Postgres cluster/database incident: use DigitalOcean PITR/backups into a new cluster.
- Reviewed data-destructive production release or live-money/provider evidence that cannot be replayed safely: create a pre-release restore-point fork and record the fork in release health.
- Runtime profile, route exposure, worker runner, or connection-budget-only changes: do not create a restore fork by habit; rely on retained context databases plus PITR/backups.

## Evidence Checklist

Every production profile/topology migration record should include:

- selected production mode, API runtime profile, and worker profile;
- provisioned, active runtime, and exposed route context counts;
- `connection_budget_profiles` headroom for landing, proof, and public modes;
- production PgBouncer posture and the direct-only listener/waiter exceptions;
- destructive database guard result and any exact reviewed override addresses;
- restore posture: projection rebuild, PITR/backups, or precreated fork.
