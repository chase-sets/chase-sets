# Event Projection Query Plans

Projection subscriptions read source events by global position with optional event-type and stream-prefix filters.

## Required Query Shape

Filtered projection reads should use all normalized stream metadata that can be derived from the subscription manifest:

```sql
WHERE global_position > $1::bigint
  AND event_type = ANY($2::text[])
  AND stream_context_name = ANY($3::text[])
  AND stream_category = ANY($4::text[])
  AND (stream_id LIKE $5 || '%' OR ...)
ORDER BY global_position ASC
LIMIT $n
```

`stream_id LIKE prefix || '%'` remains the final correctness guard, but the planner should be able to prune most rows through normalized `stream_context_name`, `stream_category`, and `event_type` predicates before checking the prefix.

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

The accepted plan should show an index scan or bitmap plan using a context/category/type/global-position index for filtered reads. A broad global-position scan followed by heavy application-side filtering is not acceptable for sustained backlogs.
