# Bulk Reprice Ingestion Removal

This is a pre-authored future gate. Do not execute removal from this issue.

## Delete with the feature

- `features/bulk-reprice-ingestion/` directory, including domain, API, UI, read-model, tests, and this file
- `routes/marketplace/bulk-reprice.tsx`
- `support/route-support/bulk-reprice/loader.ts` and `action.ts`
- `support/request-support/api-client.ts` bulk-job and nudge methods
- `support/request-support/inventory-sku-gateway.ts` bulk adapter
- Pricing composition entries in `api.ts`, `server.ts`, `index.ts`, `support/runtime-support/services.ts`, and `support/runtime-support/schema.ts`
- Bulk-reprice worker lane in `deployables/platform-worker/src/main.ts`; retain Marketplace's source value
- Tables `pricing_bulk_reprice_job_inputs`, `pricing_bulk_reprice_jobs`, `pricing_bulk_reprice_job_events`, `pricing_bulk_reprice_rows`, and `pricing_bulk_reprice_create_rate_limit_buckets`
- The feature migration and `pricing.bulk-reprice-ingestion` policy
- Bulk-reprice localization keys and feature documentation
- Pricing context route, slice, noun, and worker-graph entries

## Keep

- Marketplace chunked listing throughput and the `bulk-reprice` `changeSource` enum value until all retained consumers migrate
- `/account/desk/repricing` prefill parser and `PolicyEditorDrawer` flow
- The Inventory account-SKU resolution endpoint and its owning Inventory contract
- Pricing source-share history and the sunset policy/runbook

## Exact mount inventory

Remove the `/account/bulk-reprice` API mount, `/bulk-reprice` web route, and `bulk-reprice-ingestion` feature flag. Remove the following composition/client references, not the whole composition files:

- `bounded-contexts/pricing/api.ts`
- `bounded-contexts/pricing/server.ts`
- `bounded-contexts/pricing/support/runtime-support/services.ts`
- `bounded-contexts/pricing/support/runtime-support/schema.ts`
- `bounded-contexts/pricing/support/request-support/inventory-sku-gateway.ts`
- `bounded-contexts/pricing/support/request-support/api-client.ts`
- `bounded-contexts/pricing/routes/marketplace/bulk-reprice.tsx`
- `bounded-contexts/pricing/support/route-support/bulk-reprice/loader.ts`
- `bounded-contexts/pricing/support/route-support/bulk-reprice/action.ts`

Remove the bulk entries in `bounded-contexts/pricing/context.json`, `bounded-contexts/pricing/tests/worker-graph.contract.json`, `contracts/localization/locales/en/pricing.ts`, `bounded-contexts/pricing/docs/bulk-reprice-ingestion.md`, and `bounded-contexts/pricing/features/bulk-reprice-ingestion/api/README.md`. Retire the feature-local migration ledger entries including `20260716_pricing_bulk_reprice_one_active_job_per_account` and `20261022_pricing_bulk_reprice_nudge_job_lookup` only with the future table-drop migration. Do not remove `pricing.bulk-reprice-sunset`.
