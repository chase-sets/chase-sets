# Seller migration and bulk-listing proof walkthrough

This is the proof companion for issue #4085. It records the shipped Inventory import and Pricing bulk-reprice flows that the seller article describes. It is not a performance report and it does not turn an API surface into a provider-sync promise.

## What is shipped

The migration path has two commands with different ownership:

1. Inventory's review-first Import Batch accepts CSV text or parsed rows. The `tcgplayer-csv` and `ebay-csv` profiles normalize provider fields, resolve Catalog references, and leave unresolved rows in review. Committing accepted rows creates or adjusts Inventory Items and can create draft Listings when listing fields are present.
2. Pricing's m113 bulk-reprice on-ramp accepts CSV or JSON rows for existing listings. It resolves `sellerSku` or `listingId`, suppresses unchanged prices, sends only deltas through Marketplace's bulk price-update port, records row outcomes, and exposes a results CSV.

There is no shipped CSV command that publishes every imported listing, no stored TCGplayer/eBay credential connection, and no scheduled provider sync in this flow.

## Operator prerequisites

Use an authenticated account with the relevant seller permissions and a known storage-location id. The examples use `BASE_URL` and `COOKIE_JAR` placeholders so they can run against a local or staging deployment without putting session credentials in a document.

```bash
export BASE_URL="https://staging.example.invalid"
export COOKIE_JAR="./seller-session.cookies.txt"
```

The same flow is available in the signed-in UI at `/account/inventory/imports` and `/account/bulk-reprice`.

## TCGplayer import proof

The following is the actual Inventory API surface. The profile accepts the provider headers used below; `quantityMode: replace` makes the example an exact snapshot rather than an increment.

```bash
cat > tcgplayer-migration.csv <<'CSV'
TCGplayer SKU,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price,Seller SKU
tcg_sku_1,Charizard,Base Set,Near Mint,2,125.00,box-a-001
CSV

curl --fail-with-body -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/inventory/import-batches/sources"

CREATE_JSON=$(curl --fail-with-body -sS -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/inventory/import-batches" \
  --data-binary @- <<'JSON'
{
  "sourceKey": "tcgplayer-csv",
  "quantityMode": "replace",
  "defaultStorageLocationId": "<storage-location-id>",
  "sourceFilename": "tcgplayer-migration.csv",
  "csvText": "TCGplayer SKU,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price,Seller SKU\ntcg_sku_1,Charizard,Base Set,Near Mint,2,125.00,box-a-001"
}
JSON
)
CREATE_JOB_ID=$(jq -r '.jobId' <<<"$CREATE_JSON")
VALIDATED_JSON=$(curl --fail-with-body -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/inventory/import-batches/jobs/$CREATE_JOB_ID"
)
BATCH_ID=$(jq -r '.result.batch.batch_id' <<<"$VALIDATED_JSON")
```

Poll the job until its public `status` is `completed`. The completed response contains `result.batch`; record its `batch_id`, inspect the accepted and rejected rows, resolve any row that needs a Catalog or option choice, and then commit the accepted rows:

```bash
curl --fail-with-body -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/inventory/import-batches/$BATCH_ID"

COMMIT_JSON=$(curl --fail-with-body -sS -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/inventory/import-batches/$BATCH_ID/commit" \
  --data '{}'
)
COMMIT_JOB_ID=$(jq -r '.jobId' <<<"$COMMIT_JSON")
curl --fail-with-body -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/inventory/import-batches/jobs/$COMMIT_JOB_ID"
```

The validation job's response is a durable snapshot. If it reports a rejected reference, do not treat the batch as a failed all-or-nothing upload: open the batch, fix or resolve the row, and commit only accepted rows. The commit result identifies any `committed_inventory_item_id` and `committed_listing_id`; a listing id here is a draft-listing result, not proof of publication.

## eBay import proof

Run the same Import Batch flow with `sourceKey: ebay-csv` and the fields the eBay export contains. The shipped profile recognizes `Item ID`, `Variation ID`, `Custom label` or `SKU`, `ePID`, `GTIN`/`UPC`, `Available quantity`, `Current price`, and `Condition`.

```bash
CREATE_JSON=$(curl --fail-with-body -sS -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/inventory/import-batches" \
  --data-binary @- <<'JSON'
{
  "sourceKey": "ebay-csv",
  "quantityMode": "replace",
  "defaultStorageLocationId": "<storage-location-id>",
  "sourceFilename": "ebay-migration.csv",
  "csvText": "Item ID,Custom label,Title,Condition,Available quantity,Current price,ePID,UPC\n1001,box-a-001,Charizard,Near Mint,2,125.00,epid-1,012345678905"
}
JSON
)
CREATE_JOB_ID=$(jq -r '.jobId' <<<"$CREATE_JSON")
VALIDATED_JSON=$(curl --fail-with-body -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/inventory/import-batches/jobs/$CREATE_JOB_ID"
)
jq '.result.batch | {batch_id, accepted_count, rejected_count}' <<<"$VALIDATED_JSON"
```

The review and commit commands are the same as the TCGplayer example. The adapters and runtime tests prove both provider-specific normalization and the review-first commit behavior.

## Bulk-reprice proof

Download the template from the route mounted by Pricing, then submit a durable job. The template headers and the API request shape are shipped code, not an invented demo format.

```bash
curl --fail-with-body -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/marketplace/account/bulk-reprice/template.csv" \
  -o bulk-reprice.csv

cat > bulk-reprice.csv <<'CSV'
sellerSku,listingId,newPrice
box-a-001,,119.99
,<listing-id>,24.50
CSV

REPRICE_JSON=$(curl --fail-with-body -sS -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/marketplace/account/bulk-reprice" \
  --data-binary @- <<'JSON'
{
  "sourceFilename": "bulk-reprice.csv",
  "csvText": "sellerSku,listingId,newPrice\nbox-a-001,,119.99\n,<listing-id>,24.50"
}
JSON
)
REPRICE_JOB_ID=$(jq -r '.jobId' <<<"$REPRICE_JSON")
curl --fail-with-body -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/marketplace/account/bulk-reprice/jobs/$REPRICE_JOB_ID"
curl --fail-with-body -sS -b "$COOKIE_JAR" \
  "$BASE_URL/api/marketplace/account/bulk-reprice/jobs/$REPRICE_JOB_ID/results.csv" \
  -o bulk-reprice-results.csv
```

Use the status endpoint or the UI's durable-job stream until the job is terminal. If a job must stop, the shipped cancel command is:

```bash
curl --fail-with-body -sS -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/marketplace/account/bulk-reprice/jobs/$REPRICE_JOB_ID/cancel" \
  --data '{}'
```

The result CSV includes row number, source identifiers, requested and previous prices, resolved listing id, outcome, and an error message when applicable. A row whose requested price already matches the current listing is `unchanged` and never reaches the Marketplace gateway. The default upload ceiling is 250,000 rows, while the account concurrency rule permits one active job.

## Throughput evidence is operator-pending

The repository contains a deliberately skipped database benchmark for the #4328 acceptance shape. Its command is:

```bash
RUN_BULK_REPRICE_BENCHMARK=1 TEST_DATABASE_URL="<test-database-url>" \
  pnpm --filter @chase-sets/pricing exec vitest run \
  features/bulk-reprice-ingestion/tests/bulk-reprice-ingestion-throughput-benchmark.db.test.ts
```

That benchmark uses a near-zero-latency fake Marketplace gateway and measures this feature's overhead. It is not staging proof of end-to-end throughput or interactive latency. The 250,000-row figure is the launch upload ceiling and an issue target, not a measured rows-per-second result.

**Operator-pending:** run the 10k-row and 250k-row files in staging with realistic concurrent traffic, record wall time, unchanged-row suppression, append-lock impact using the #4163 metrics, and interactive latency, then attach the evidence to the issue or PR. Until that run exists, marketing and seller copy must not publish a completion-time or throughput number.

## Enforcing proof map

- TCGplayer/eBay field normalization: `bounded-contexts/inventory/features/import-batches/domain/import-source-adapters.test.ts`.
- Review, rejection preservation, idempotent commit, and draft-listing creation: `bounded-contexts/inventory/features/import-batches/api/runtime.test.ts`.
- Diff-first repricing, outcomes CSV, active-job cap, cancellation, and row ceiling: `bounded-contexts/pricing/features/bulk-reprice-ingestion/tests/bulk-reprice-ingestion.db.test.ts`.
- Bulk CSV shape: `bounded-contexts/pricing/features/bulk-reprice-ingestion/domain/csv.test.ts`.
- The full removable m113 feature and its mount points: `bounded-contexts/pricing/docs/bulk-reprice-ingestion.md`.
