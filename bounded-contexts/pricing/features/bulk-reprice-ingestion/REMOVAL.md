# Bulk Reprice Ingestion Removal

This is a pre-authored future gate. Do not execute removal from this issue.

## Delete with the feature

- `features/bulk-reprice-ingestion/` directory, including domain, API, UI, read-model, tests, and this file
- `routes/marketplace/bulk-reprice.tsx`
- `support/route-support/bulk-reprice/loader.ts` and `action.ts`
- `support/request-support/api-client.ts` bulk-job and nudge methods
- `support/request-support/inventory-sku-gateway.ts` bulk adapter
- Pricing composition entries in `api.ts`, `server.ts`, `index.ts`, `support/runtime-support/services.ts`, and `support/runtime-support/schema.ts`
- Marketplace worker bulk-reprice lane and its `bulk-reprice` source value
- Tables `pricing_bulk_reprice_job_inputs`, `pricing_bulk_reprice_jobs`, `pricing_bulk_reprice_job_events`, `pricing_bulk_reprice_rows`, and `pricing_bulk_reprice_create_rate_limit_buckets`
- The feature migration and `pricing.bulk-reprice-ingestion` policy
- Bulk-reprice localization keys and feature documentation
- Pricing context route, slice, noun, and worker-graph entries

## Keep

- Marketplace chunked listing throughput and the `bulk-reprice` `changeSource` enum value until all retained consumers migrate
- `/account/desk/repricing` prefill parser and `PolicyEditorDrawer` flow
- The Inventory account-SKU resolution endpoint and its owning Inventory contract
- Pricing source-share history and the sunset policy/runbook
