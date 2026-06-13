# Projection Helper Toolkit

Projection handlers should read as table mappings first and custom SQL second. Use the helpers in
`@chase-sets/event-core-postgres/projection-helpers` for the repeatable 70-80% of projection mutations, and keep
`db.query` in the handler for custom fan-out, aggregation, joins, and query-shape-specific work.

## Survey Baseline

The Phase 4 helper surface was designed against the six largest projection files before any pilot migration:

- Discovery search: many item/reference/category upserts, status transitions, JSONB field/category edits, and dependent
  item refresh cascades.
- Discovery item detail: the same catalog item JSONB and status patterns, plus blueprint/reference/dimension upserts and
  all-item refresh cascades.
- Auth identity: account/user/membership/invitation upserts, status transitions, JSONB contact/auth/passkey/social arrays,
  lookup-table mirrors, and membership mirror cascades.
- Marketplace supply: account/review/supply-location/item/hold upserts, stream-version guarded inventory updates, badge
  JSONB set updates, and item-change callbacks.
- Discovery market support: account/listing/offer/review upserts, listing status transitions, seller availability upserts,
  slug redirects, realtime patch emission, and Google Shopping refresh cascades.
- Catalog admin projection: page row bulk upserts, dependent graph refreshes, delete cascades, and display-identity
  recomputation.

The useful abstraction boundary is row-level mutation plus JSONB array edits. Cascades remain explicit orchestration
because each cascade names domain-specific dependents and side effects.

### Phase D Survey

Issue #1566 surveyed raw `db.query` calls in the toolkit-migrated auth and discovery projections plus newer projection
files in those bounded contexts. Helpers remain survey-gated: build only when the same pattern appears in at least three
distinct projection files.

| Candidate pattern | Matching projection files | Distinct file count | Decision |
| --- | --- | ---: | --- |
| `INSERT ... SELECT ... ON CONFLICT` derived-row upsert | `bounded-contexts/discovery/support/market-support/projection.ts` | 1 | Declined; below threshold. |
| COALESCE/conditional `UPDATE ... WHERE` | `bounded-contexts/discovery/support/market-support/projection.ts`, `bounded-contexts/discovery/features/item-detail/read-model/projection.ts` | 2 | Declined; below threshold. |
| Cascade read feeding batch refresh | `bounded-contexts/discovery/features/categories/read-model/projection.ts`, `bounded-contexts/discovery/features/search/read-model/projection.ts`, `bounded-contexts/discovery/features/item-detail/read-model/projection.ts`, `bounded-contexts/discovery/support/market-support/projection.ts`, `bounded-contexts/discovery/features/google-shopping-operations/api/feed-row-projection.ts` | 5 | Built as `refreshAffectedRows`. |

## Helper Mapping

- `upsertRow`: use for `INSERT ... ON CONFLICT` keyed by a const `insertColumns` list. Set `updateColumns` when conflict
  updates intentionally exclude insert-only/default columns. Use `casts` for JSONB columns instead of pre-stringifying.
- `updateRow`: use for ordinary keyed `UPDATE` statements. Keep the `setColumns` and `where.columns` lists inline or in
  table-local constants so column typos fail early and SQL generation stays deterministic.
- `refreshAffectedRows`: use for the recurring cascade shape where a projection reads affected row ids from one source
  table, optionally with structured joins/where/order clauses, and invokes a refresh callback for every selected id.
  Use `idsFromRow` only when one selected row carries multiple affected ids, such as a JSONB id array. Keep graph
  traversals, aggregate reads, and side-effect orchestration outside the helper.
- `transitionStatus`: use for status-only event transitions with an `updated_at` write, such as `published`, `revoked`,
  `suspended`, or `expired`.
- `appendJsonbArrayElement`: use for atomic JSONB array appends. Set `unique: true` plus `orderBy: [{ kind: "text" }]`
  for sorted primitive sets such as auth methods and credential ids.
- `removeJsonbArrayElement`: use for atomic JSONB removals by primitive value or object path text, such as category ids
  or field-value objects.
- `replaceJsonbArrayElement`: use for remove-then-append JSONB object updates keyed by one or more object fields, such as
  field values or social login links.
- `patchJsonbArrayElement`: use when the existing JSONB object should keep all fields and only receive a small patch, such
  as marking a contact method verified.

## Escape Hatch

Raw `db.query` is still first-class. Prefer raw SQL when the handler needs bulk `VALUES` construction, `RETURNING` data
from an update before a domain-specific refresh, stream-version guards, aggregate refreshes, slug redirect reads, realtime
patch emission, or multi-table cascades whose shape is not a reusable row mutation. Keep those custom blocks close to the
handler so the domain reason is visible.

## Row-Identity Verification

For migrations, replay a representative event sequence against the migrated projection and compare final projected rows to
hand-computed rows from the old SQL. The auth pilot uses this in
`bounded-contexts/auth/support/auth-support/projection-row-identity.test.ts`: it replays account, user, membership,
invitation, and session events into Postgres, then snapshots all affected read-model and lookup tables. This catches
parameter-order mistakes, JSONB serialization changes, mirror drift, and status timestamp regressions.
