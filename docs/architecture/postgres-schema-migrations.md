# Postgres Schema Migrations

## Purpose

Bounded-context database bootstrap must be safe when multiple API, worker, or bootstrap instances start at the same time. The bootstrap path now uses a lightweight schema migration ledger and a Postgres advisory lock so every context database can apply one-time DDL/backfill work deterministically.

## Runtime Model

`bootstrapContextDatabase` waits for the database, opens one session, takes a session-level advisory lock, creates `bounded_context_schema_migrations` if needed, applies the additive boot schema, and then applies pending ledgered migrations.

The advisory lock is database-local. Different context databases can bootstrap independently, while two processes booting the same context database serialize schema changes.

The migration ledger table records:

- `migration_id`: stable, unique migration id.
- `description`: operator-readable intent.
- `applied_at`: database timestamp when the migration completed.

Ledgered migrations are idempotent by id. If a migration fails before its ledger row is inserted, the next bootstrap retries it. Migration statements must therefore be replay-safe or guard themselves with `IF EXISTS`, `IF NOT EXISTS`, or idempotent predicates.

## Event-Store Migrations

The event-store context/category backfill no longer runs as always-on boot SQL. It is a ledgered migration:

- backfill `stream_context_name` and `stream_category` for old rows;
- enforce `NOT NULL` after the backfill.

Large `event_store_events` indexes also moved out of boot schema SQL. They run as `CREATE INDEX CONCURRENTLY IF NOT EXISTS` in a ledgered migration, outside an explicit transaction block. This avoids holding write-blocking index locks on the append-only event table during ordinary fleet boot.

Context-owned read-model indexes can stay in additive boot schema SQL unless production evidence shows they need the same concurrent-index treatment.

The write-hot `event_store_streams` and `event_projection_checkpoints` tables use fillfactor 90 through the ledgered `20260710_event_store_write_hot_fillfactor` migration. The migration leads with a five-second `lock_timeout` because changing a table storage parameter requires an `ACCESS EXCLUSIVE` lock. It changes storage policy for future writes only: deployment deliberately does not run `VACUUM FULL` or `pg_repack`, avoiding a table rewrite and its additional lock, disk, and operational risk. Normal updates will gradually realize the reserved page space. If production evidence requires rollback, apply a new ledgered migration with the same lock timeout and `ALTER TABLE ... RESET (fillfactor)` for both tables; existing pages still are not rewritten automatically.

## Adding A Migration

Add a migration only for cross-cutting or shared runtime schema work. Bounded-context-owned table changes should usually remain with that context's schema unless the change is a one-time data backfill, a large-table concurrent index, or another operation that must not run every boot.

When adding a migration:

1. Choose a stable id in `YYYYMMDD_short_description` form.
2. Keep statements idempotent and restartable.
3. Use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` for large-table indexes.
4. Do not wrap concurrent index creation in an explicit transaction.
5. Add or update tests that prove the migration is recorded once and does not stay in boot-time schema SQL.
6. Document any rollback or restore expectation in the owning architecture/runbook doc.

## Lock Discipline For Required Columns

Migrations run from the bootstrap job while the previous API fleet is still serving reads, so every statement competes with live ACCESS SHARE locks. Two rules follow (enforced by the structure gate, rule R99):

**Adding a new required column: use one statement.** Since PostgreSQL 11, `ADD COLUMN ... NOT NULL DEFAULT <expression>` with a non-volatile default is a metadata-only "fast default": the default is evaluated once, stored in the catalog, and applied lazily on read. There is no table rewrite and no validation scan; the ACCESS EXCLUSIVE lock is held only for the catalog update, so the statement slips through the lock queue even under live traffic. Constant defaults (`0`, `'[]'::jsonb`, `FALSE`) and stable expressions (`now()`, `CURRENT_TIMESTAMP`) qualify. Volatile defaults (`gen_random_uuid()`, `random()`, `clock_timestamp()`) do NOT qualify — they rewrite the whole table under ACCESS EXCLUSIVE and stay forbidden.

**Do not split the add into nullable-add + backfill + `SET NOT NULL`.** That pattern was pre-11 advice and its final step is the dangerous one: `ALTER COLUMN ... SET NOT NULL` holds ACCESS EXCLUSIVE across a full-table validation scan. Under rolling-deploy reads the statement repeatedly hits `lock_timeout`, the schema-bootstrap retry loop classifies that as retryable, and the deploy livelocks silently until the quiesce kills the bootstrap job — this took down staging deploys in #4638. A `lock_timeout` guard does not make this safe; it is what makes the failure silent.

**Tightening an existing column** (when the column already exists and must become required): use the scan-free pattern in one migration — `ADD CONSTRAINT ... CHECK (column IS NOT NULL) NOT VALID` (brief lock, no scan), `VALIDATE CONSTRAINT` (SHARE UPDATE EXCLUSIVE only, does not block reads or writes), then `ALTER COLUMN ... SET NOT NULL` behind `lock_timeout`. On PostgreSQL 12+ the final step proves NOT NULL from the validated constraint and skips the scan, so only the brief catalog lock remains.

Do not edit generated `infrastructure/event-core-postgres/schema.ts` by hand; it is synced from `schema.sql`. Runtime migration behavior belongs in `infrastructure/bounded-context-runtime/schema.ts`.
