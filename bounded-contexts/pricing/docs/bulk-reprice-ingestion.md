# Bulk Reprice Ingestion (`features/bulk-reprice-ingestion/`)

## Purpose

The bulk on-ramp for sellers who reprice via spreadsheet or their own pricing algorithm today, while the
real destination -- signal-driven Repricing Policies (`features/repricing-policies/`) -- comes online.
Diff-first: rows whose price already matches the current listing price are dropped with an `unchanged`
outcome before anything is written, so a typical re-upload of a mostly-unchanged 250k-row file costs close
to nothing.

See issue #4328 and epic #4335 for the full design brief.

## Design constraint: this feature is a removable on-ramp, not load-bearing

Per the m113 milestone thesis, bulk ingestion is explicitly a **temporary, deletable** feature -- a sunset
gate (#4334, a later slice) measures when it can be removed entirely once Repricing Policies covers seller
demand. To keep that promise honest, `features/bulk-reprice-ingestion/` is built so removal is small and
mechanical:

- **Everything this feature owns lives in that directory**: domain (CSV parsing, policy dials), read-model
  (job tables, row-outcome table), api (job engine, HTTP routes), ui (the upload/status page).
- **Nothing outside that directory imports from it**, except the handful of documented mount points listed
  below. Verified by `bounded-contexts/pricing/tests/bulk-reprice-ingestion-removability.test.ts`, which
  greps the whole repo for imports of the feature directory and fails if anything beyond the documented
  mount points shows up.
- **The throughput machinery this feature calls (chunked-append, terms-session, no-op suppression) lives
  OUTSIDE that directory**, in Marketplace's listings feature (#4325/#4326/#4327) -- that machinery serves
  the Repricing Policy engine too and is permanent. This feature only ever calls it through the injected
  `BulkRepriceMarketplaceListingGateway` port; it never appends events itself.
- **Native-SKU resolution reuses Inventory's import-batches machinery (m71)** through a small, dedicated
  batch-resolution endpoint (`POST /api/inventory/import-batches/account-sku-mappings/resolve-inventory-items`)
  rather than re-implementing SKU-mapping/ambiguity rules here.
- **Mount gate is a policy boolean** (`domain/policy.ts`'s `enabled` field), following the same
  policy-boolean-at-route-layer precedent as `marketplace/features/seller-metrics/domain/behavioral-metrics-policy.ts`.

## What it does

1. **Ingestion surface**: CSV upload (multipart or raw `csvText`) or JSON row batch via
   `POST /api/marketplace/account/bulk-reprice`. Rows are `(sellerSku or listingId, newPrice)`.
2. **Diff-first**: every wave resolves rows to a listing and its current price via Pricing's own local
   `pricing_market_listing_inputs` read model (already projected from Marketplace's listing events) before
   ever calling Marketplace -- unchanged rows never leave this feature.
3. **Chunked apply**: deltas are pushed through Marketplace's `applyBulkListingPriceUpdates` port (the same
   one `pricing/features/recommendations` uses), one Marketplace call per wave, respecting the chunk-size
   and yield-interval dials this feature declares independently in `domain/policy.ts`.
4. **Per-row outcomes**: every row's final state (`applied` / `unchanged` / `failed` + reason) is persisted
   to `pricing_bulk_reprice_rows` and downloadable as a results CSV
   (`GET /api/marketplace/account/bulk-reprice/jobs/:jobId/results.csv`).
5. **Guardrails**: one active job per account and a create-job rate limit, both declared in
   `domain/policy.ts` / `api/route.ts`; mid-run cancellation is checked at wave boundaries so a cancelled
   job stops promptly instead of finishing every remaining wave.

## Removal checklist

Deleting this feature is one directory plus a small, fully-enumerated set of mount-point edits -- nothing
else in the codebase references the feature's internals.

### 1. Delete the directory

```
rm -rf bounded-contexts/pricing/features/bulk-reprice-ingestion/
```

This removes all domain logic, the read-model schema (job tables + row-outcome table), the job engine, the
HTTP routes, and the UI page.

### 2. Remove the mount points (all outside that directory)

| File | Change |
| --- | --- |
| `bounded-contexts/pricing/api.ts` | Remove the `createBulkRepriceIngestionRoutes` import and the `app.route("/account/bulk-reprice", ...)` line. |
| `bounded-contexts/pricing/support/runtime-support/services.ts` | Remove the `createBulkRepriceIngestionRuntime` import, the `bulkRepriceIngestion` field on `PricingServices`, and its construction. |
| `bounded-contexts/pricing/support/runtime-support/schema.ts` | Remove the `pricingBulkRepriceIngestionSchemaSql` import and its entry in `pricingSchemaSql` (the DDL is dropped with it -- add a migration to `DROP TABLE` the three owned tables if historical data must be purged, otherwise leaving inert tables is safe). Keep `platformPolicySchemaSql` if any other Pricing feature has since adopted platform-policy. |
| `bounded-contexts/pricing/support/request-support/inventory-sku-gateway.ts` | Delete this file (it exists only to implement this feature's inventory port). |
| `bounded-contexts/pricing/support/request-support/api-client.ts` | Remove the `createBulkRepriceJob` / `getBulkRepriceJob` / `cancelBulkRepriceJob` methods and the `BulkRepriceJobStatus` import. |
| `bounded-contexts/pricing/routes/marketplace/bulk-reprice.tsx` | Delete this file (the UI route mount). |
| `bounded-contexts/pricing/support/route-support/bulk-reprice/` | Delete this directory (the route's loader/action). |
| `bounded-contexts/pricing/features/recommendations/ui/recommendation-list-page.tsx` | Remove the "Bulk reprice" `LinkButton` (a plain href, not an import -- safe to delete independently). |
| `bounded-contexts/pricing/context.json` | Remove the `bulk-reprice-ingestion` entries from `slices`, `directoryIntent`, `mutationConsistencyInventory`, `deployableContributions`; remove `bulk-reprice-job` from `ownedNouns`; remove `route-support` from `allowedSupportDirectories` if nothing else in Pricing uses it; remove `@chase-sets/inventory` from `allowedContextDependencies` if nothing else in Pricing depends on it. |
| `bounded-contexts/pricing/package.json` | Remove the `@chase-sets/inventory` dependency (same condition as above). |
| `bounded-contexts/pricing/GLOSSARY.md` | Remove the "Bulk Reprice Job" entry. |
| `bounded-contexts/pricing/docs/bulk-reprice-ingestion.md` | Delete this doc. |
| `contracts/localization/locales/en/pricing.ts` | Remove the `pricing.features.bulkRepriceIngestion.*` and `pricing.routes.marketplace.bulkReprice.*` keys (and the one added `pricing.features.recommendations.ui.recommendationListPage.bulk.reprice` key). |
| `deployables/platform-worker/src/main.ts` | Remove `createBulkRepriceIngestionJobRunners` and its call site. |
| `deployables/platform-worker/src/config.ts` | Remove the three `pricingBulkRepriceJob*` config fields. |
| `deployables/platform-worker/.env.example` | Remove the three `PRICING_BULK_REPRICE_JOB_*` env lines. |
| `bounded-contexts/inventory/features/import-batches/read-model/account-sku-mappings.ts`, `api/runtime.ts`, `api/route.ts`, `client.ts`, `server.ts`, `support/request-support/api-client.ts` | The batch SKU-resolution endpoint (`resolveAccountSellerSkusToInventoryItems` and its HTTP surface) may be kept -- it is Inventory-owned, general-purpose, and has no dependency back on this feature -- or removed if nothing else has adopted it by then. |
| `bounded-contexts/pricing/tests/bulk-reprice-ingestion-removability.test.ts` | Delete this guard test along with the feature. |

### 3. Verify

Run `pnpm --filter @chase-sets/pricing run test`, `pnpm --filter @chase-sets/inventory run test` (if the
Inventory endpoint was also removed), and `pnpm run check:structure` to confirm no dangling references
remain.
