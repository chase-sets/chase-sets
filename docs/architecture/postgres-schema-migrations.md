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

## Adding A Migration

Add a migration only for cross-cutting or shared runtime schema work. Bounded-context-owned table changes should usually remain with that context's schema unless the change is a one-time data backfill, a large-table concurrent index, or another operation that must not run every boot.

When adding a migration:

1. Choose a stable id in `YYYYMMDD_short_description` form.
2. Keep statements idempotent and restartable.
3. Use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` for large-table indexes.
4. Do not wrap concurrent index creation in an explicit transaction.
5. Add or update tests that prove the migration is recorded once and does not stay in boot-time schema SQL.
6. Document any rollback or restore expectation in the owning architecture/runbook doc.

Do not edit generated `infrastructure/event-core-postgres/schema.ts` by hand; it is synced from `schema.sql`. Runtime migration behavior belongs in `infrastructure/bounded-context-runtime/schema.ts`.
