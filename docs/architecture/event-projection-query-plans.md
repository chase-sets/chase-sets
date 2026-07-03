# Event Projection Query Plans

Projection subscriptions read source events by global position with optional event-type and stream-prefix filters.

## Required Query Shape

Filtered projection reads should use normalized stream context metadata when it can be derived from the subscription manifest:

```sql
WHERE global_position > $1::bigint
  AND event_type = ANY($2::text[])
  AND (
    (stream_context_name = $3 AND stream_id LIKE $4 || '%')
    OR (stream_context_name = $5 AND stream_id LIKE $6 || '%')
  )
ORDER BY global_position ASC
LIMIT $n
```

`stream_id LIKE prefix || '%'` remains the correctness guard. Prefix-derived `stream_context_name` predicates stay inside the matching OR arm so mixed prefix shapes cannot globally filter each other out. `stream_category` remains stored for wake metadata, operator inspection, and future planner work, but read correctness must not depend on it: existing category names and aggregate ids can both contain dashes, so the persisted category is not a safe replacement for the declared stream prefix.

## Supporting Indexes

The deployed schema must keep these indexes in both `schema.sql` and generated `schema.ts`:

- `event_store_events_tenant_type_global_idx`
- `event_store_events_stream_prefix_global_idx`
- `event_store_events_context_category_type_global_idx`
- `event_store_events_context_category_global_idx`

## Validation

Before large projection backfills, capture `EXPLAIN (ANALYZE, BUFFERS)` for representative catalog subscriptions with production-like event counts.

Use the backlog explain helper against a production-like database clone or staging database:

```powershell
$env:DATABASE_URL = "<connection-string>"
node ./scripts/explain-event-projection-backlog.mjs --event-types=catalog.catalog-item.published --stream-prefixes=catalog.item- --after=0 --limit=500
```

The accepted plan should show an index scan or bitmap plan using the stream-prefix or event-type/global-position indexes for filtered reads. A broad global-position scan followed by heavy application-side filtering is not acceptable for sustained backlogs.
