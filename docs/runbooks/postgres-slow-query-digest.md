# Postgres Slow Query Digest

`Platform Postgres Slow Query Digest` records support-safe slow-query evidence from managed Postgres `pg_stat_statements` aggregate counters. The workflow is read-only: it pulls context database URLs from Terraform state, checks whether `pg_stat_statements` is already installed, and uploads `postgres-slow-query-digest/v2` under `artifacts/release-health/postgres-slow-query-digest.json`.

The digest never creates or enables the extension. If a database does not already expose `pg_stat_statements`, the artifact records `extensionInstalled: false` and an empty digest for that context — that is collected, valid evidence, not a collection failure.

## Run It

Use the GitHub Actions workflow manually when investigating a release-health or database-capacity question:

1. Open `Platform Postgres Slow Query Digest`.
2. Choose `staging` or `production`.
3. Type `collect postgres slow query digest` in the confirmation field.
4. Leave `top_query_limit` at `25` unless a narrower investigation needs less output.

The weekly scheduled run inspects staging. Production runs are intentionally manual so an operator chooses when to use production database credentials.

Local dry runs are possible with explicit database URLs:

```powershell
pnpm run ops postgres:slow-query-digest -- `
  --environment staging `
  --database-url checkout=postgresql://redacted `
  --out artifacts/release-health/postgres-slow-query-digest.json
```

Do not paste real connection strings into issues, PRs, shell transcripts, or screenshots.

## Artifact Shape

The artifact includes:

- context/database labels;
- `pg_stat_statements` posture: extension installed, view accessible, shared-preload posture, track setting, and compute-query-id setting;
- per-fingerprint aggregate counters: calls, total/mean/max/stddev execution time, rows returned, shared/temp block counters, and WAL bytes when available;
- collection errors with bounded classification/code fields (never raw messages).

The artifact deliberately excludes:

- raw `pg_stat_statements.query` text;
- bind values and SQL literals;
- row samples and payload bodies;
- connection strings, emails, URLs, tokens, and secrets;
- customer, provider, account, session, and order identifiers.

Fingerprints are repo-owned hashes of Postgres `queryid` values (`pgss-<16 hex chars>`). They are useful for comparing repeated runs, but they are not a query catalog and should not be treated as a stable cross-cluster API.

### Least-Privilege Posture Fields

`sharedPreloadLibraryEnabled`, `trackSetting`, and `computeQueryIdSetting` are each probed independently. When the runtime role is denied access to one of those optional settings (for example a managed-Postgres role without a `GRANT ... ON PARAMETER shared_preload_libraries`), that field is `null` — undetermined, not false. A denied optional setting never discards the rest of the database record: extension presence, view accessibility, and digest evidence are collected from unrestricted catalog relations (`pg_extension`, `pg_namespace`) and the `pg_stat_statements` view itself, independently of the posture probes.

## Coverage And Result Semantics

`summary` reports explicit coverage so a run can't be misread:

- `attemptedDatabaseCount`: every configured/selected database the run tried to inspect.
- `collectedDatabaseCount`: databases where a record was obtained, whether the extension is installed or absent — extension absence is valid evidence, not a failure.
- `extensionAbsentDatabaseCount` / `extensionInstalledDatabaseCount`: split of the collected databases.
- `collectionErrorCount`: databases that failed entirely (connection, TLS, or catalog-query failure) before any evidence could be recorded for them.

`result` follows from those counts:

- `success`: every attempted database was collected (posture-setting denials inside a collected record do not count against this).
- `warning`: a genuine mixed run — at least one database collected and at least one failed. Advisory only.
- `failure`: attempted databases but zero collected records. This is a terminal, nonzero-exit outcome; it must never be read as "observed zero slow-query time," because no database was actually inspected.

## Interpretation

Check `result` first. A `failure` means zero databases were actually collected — treat every other `summary` field as uninformative for that run, investigate `errors[].classification`/`code`, and do not read the run as "no slow queries." Only once `result` is `success` or `warning` should you read the timing fields below for the databases that were collected.

Start with `summary.largestTotalExecTimeMs`, `summary.largestMaxExecTimeMs`, and the top rows in each database's `slowQueryDigests`.

- High `totalExecTimeMs` usually means a frequent query is consuming meaningful database time, even when each call is acceptable.
- High `maxExecTimeMs` with low calls points to a spike, lock wait, cold cache, or one-off maintenance-shaped operation.
- High shared block reads compared with hits can indicate cache pressure, missing indexes, or large scans.
- Temp block writes suggest sorts or hashes spilling to disk and deserve query-plan follow-up.
- WAL bytes are advisory and only present on Postgres versions that expose the counter.

Use the digest as a triage pointer. It intentionally does not tell you the raw SQL, tenant, account, order, provider, URL, or payload that produced the aggregate. If you need plan-level analysis, collect it through a private operator channel with bounded-context owners and keep customer/provider data out of GitHub.

## Extension Ownership

Enabling `pg_stat_statements` can require managed-database configuration, `shared_preload_libraries`, and `CREATE EXTENSION`. Those are production mutations and cross the same ownership boundary called out by the Postgres schema migration and event-store partitioning work.

Do not enable the extension from this digest workflow. Coordinate any extension enablement with #3626/#3627 and the schema migration posture in [Postgres Schema Migrations](../architecture/postgres-schema-migrations.md) and [Postgres Event Store Partitioning And Retention](../architecture/postgres-event-store-partitioning-retention.md). The digest remains useful before that work because it records which databases are already observable and which need a planned enablement path.
