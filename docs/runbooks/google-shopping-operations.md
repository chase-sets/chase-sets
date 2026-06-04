# Google Shopping Operations

This runbook owns the operator checklist for Chase Sets Google Merchant Center / Google Shopping integration. It is secret-safe: do not paste real credentials, private keys, account screenshots containing private seller data, or raw provider payloads into this file.

## Account Posture

The integration targets Google's marketplace/multi-seller account model. Chase Sets rows use one Google offer per public Marketplace Listing and include an external seller id derived from the Chase Sets Account id.

Production submission remains blocked until Ops records a private evidence reference showing:

- Google Merchant Center account is approved for marketplace or multi-seller use.
- API data source exists for product uploads.
- Target country, content language, feed label, and destination settings are approved.
- Free-listings policy requirements have been reviewed.
- Seller-level policy handling for `external_seller_id` is understood.

If approval is not available, keep `GOOGLE_MERCHANT_SYNC_ENABLED=false` or `GOOGLE_MERCHANT_DRY_RUN=true`.

## Worker Configuration

Platform Worker reads these environment variables:

| Variable | Required when sync enabled | Notes |
| --- | --- | --- |
| `GOOGLE_MERCHANT_SYNC_ENABLED` | No | Defaults to disabled. |
| `GOOGLE_MERCHANT_DRY_RUN` | No | Defaults to true. Keep true for staging/proof until row quality is verified. |
| `GOOGLE_MERCHANT_ACCOUNT_ID` | Yes | Merchant account id only; no credentials. |
| `GOOGLE_MERCHANT_API_DATA_SOURCE_ID` | Yes | API product upload data source id. |
| `GOOGLE_MERCHANT_TARGET_COUNTRY` | Yes | ISO country code, such as `US`. |
| `GOOGLE_MERCHANT_CONTENT_LANGUAGE` | Yes | Language code, such as `en`. |
| `GOOGLE_MERCHANT_FEED_LABEL` | Yes | Feed label aligned with Merchant Center setup. |
| `GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME` | Yes | Secret reference name only; never inline JSON. The worker reads the service-account JSON from the environment variable named by this value. |
| `GOOGLE_SHOPPING_MAINTENANCE_INTERVAL_MS` | No | Defaults to 24 hours. Set to `0` to disable scheduled refresh/cleanup scans. |
| `GOOGLE_SHOPPING_MAINTENANCE_BATCH_SIZE` | No | Defaults to 100 rows per scheduled scan. |
| `GOOGLE_SHOPPING_REFRESH_WINDOW_DAYS` | No | Defaults to 25 days so accepted/submitted products refresh before the 30-day Merchant freshness window. |

Startup fails when sync is enabled without complete required config.

Live sync uses a Google service-account JSON private key to exchange a signed JWT for an OAuth access token with the Merchant API content scope. The service account must be granted access to the Merchant Center account outside the repo. Dry-run sync does not request a token.

## Feed Row Evidence

Before enabling production writes, collect a private evidence record with:

- total export rows,
- eligible rows,
- excluded rows by exclusion reason,
- image eligibility status counts and image exclusion reasons,
- tombstoned rows waiting for delete,
- rows missing title, description, image, price, condition, shipping policy, returns policy, or crawlability,
- sampled eligible listing URLs,
- sampled production-public image URLs and crawlability checks,
- sampled seller external ids,
- public returns policy URL and Merchant Center return policy label,
- Merchant Center shipping settings evidence reference,
- Tax readiness evidence reference confirming Google-facing tax posture does not contradict checkout,
- payload hash freshness,
- dry-run sync result.

## Staging And Proof

Use staging/proof in this order:

1. Keep `GOOGLE_MERCHANT_SYNC_ENABLED=false` while schema and projection changes deploy.
2. Enable dry-run with `GOOGLE_MERCHANT_SYNC_ENABLED=true` and `GOOGLE_MERCHANT_DRY_RUN=true`.
3. Verify row counts, exclusion reasons, URL crawlability, sitemap/robots posture, and JSON-LD alignment.
4. Verify image eligibility counts, sampled image crawlability, condition mapping, shipping settings, returns policy label, and Tax readiness posture.
5. Confirm Merchant account/data-source approval outside the repo.
6. Enable non-production writes only when Google account policy and data-source setup are ready.
7. Keep production writes blocked until launch evidence gates pass.

## Merchant API Client Behavior

Platform Worker submits Google Shopping rows through the Merchant API v1 client. The client uses the validated worker config for the Merchant account id, API data source id, target country, content language, feed label, and dry-run setting.

The client supports:

- full `productInputs:insert` submissions for eligible feed rows;
- focused `productInputs.patch` updates for price and availability changes;
- `productInputs.delete` withdrawals for tombstoned rows;
- processed `products.get` reads for destination status and item-level issue correlation.

Dry-run mode returns the intended method, redacted URL, body, and update mask without requesting credentials or calling Google. Keep dry-run enabled until the feed evidence and account approval checks above are complete.

Transient provider responses are retried with backoff for HTTP 408, 409, 425, 429, and 5xx responses. Validation, policy, authentication, authorization, and not-found responses are surfaced as permanent provider failures for the durable sync job to record and expose to operators.

The client redacts Authorization headers, access tokens, credential secret names, Merchant account ids, and API data-source ids from request summaries, error details, and logger payloads. Do not paste raw Google request URLs, OAuth tokens, service account JSON, private keys, or unredacted provider errors into runbooks, issue comments, or sync state.

## Full Feed Sync

Operators with `security.manage` can enqueue a durable full sync through the Discovery API:

```http
POST /google-shopping/sync-jobs
Content-Type: application/json

{ "mode": "dry-run", "batchSize": 100 }
```

Use `mode: "dry-run"` first. Dry-run walks the same deterministic row scan and prepares Merchant API requests, but it does not update row submission metadata. Use `mode: "live"` only after launch evidence gates pass, `GOOGLE_MERCHANT_SYNC_ENABLED=true`, `GOOGLE_MERCHANT_DRY_RUN=false`, and the service-account secret is bound.

The job scans `discovery_google_shopping_feed_rows` by `row_id ASC` pages. It submits eligible rows when `payload_hash` differs from `last_submitted_payload_hash`, skips unchanged eligible rows, deletes rows that were previously submitted and are now tombstoned or excluded, and counts never-submitted excluded rows without calling Google.

Status is available at:

```http
GET /google-shopping/sync-jobs/{jobId}
GET /google-shopping/sync-jobs/{jobId}/events
```

Progress and final results include:

- `submitted`: eligible changed rows inserted or updated in Merchant Center, or prepared in dry-run.
- `skipped`: eligible rows whose payload hash already matches the last live submission.
- `deleted`: tombstoned or newly ineligible rows withdrawn from Merchant Center, or prepared for withdrawal in dry-run.
- `failed`: rows with local payload defects or provider failures. Failed rows do not stop unrelated rows.
- `excluded`: rows not eligible for Google Shopping and not previously submitted.

In live mode, row sync metadata records the last attempted time, sync status, submitted hash/time, delete time, provider operation, provider request id when available, a redacted provider response summary, and redacted failure code/message. Live jobs fail fast if the worker is still globally configured with `GOOGLE_MERCHANT_DRY_RUN=true`.

## Incremental Sync

Discovery refreshes the Google Shopping feed row and queues targeted sync when Marketplace or Catalog facts that affect a listing change:

- listing creation, publish, pause, and withdrawal;
- listing price, quantity cap, and purchase-limit facts;
- seller listing availability enable/disable;
- catalog title, description, selected option, image URL, product asset set, and fallback image changes that affect listing rows.

Incremental requests are stored in `discovery_google_shopping_incremental_sync_requests` with one row per listing id. Repeated changes before the debounce window expires merge their reasons into the same request instead of creating provider work for every event. The worker drains due requests into durable `incremental-sync` jobs and submits only those listing rows.

Price-only and availability-only incremental jobs prefer Merchant API `productInputs.patch` with an update mask for price and availability when the row was previously submitted. Broader changes, first submissions, resubmits after delete, tombstones, and newly ineligible rows use the same full insert/delete behavior as full sync.

Quota/rate-limit posture:

- Default debounce is 30 seconds per listing.
- The worker processes a bounded batch of due listing requests per incremental job.
- HTTP 429 and transient Google responses use the Merchant client retry/backoff path and are recorded as row failures if exhausted.
- If incremental jobs fall behind, keep writes in dry-run or disable sync, investigate provider errors, then run a full dry-run sync to re-baseline row state before returning to live writes.

## Scheduled Refresh And Cleanup

The Platform Worker schedules Google Shopping maintenance only when `GOOGLE_MERCHANT_SYNC_ENABLED=true`. If `GOOGLE_MERCHANT_DRY_RUN=true`, scheduled maintenance enqueues dry-run jobs; if dry-run is false, scheduled maintenance can enqueue live jobs.

Maintenance scans select:

- eligible live rows with a previous submission whose `last_accepted_at` or `last_submitted_at` is older than the refresh cutoff;
- rows with a previous submission that are now tombstoned or ineligible and have not yet recorded `delete_submitted_at`.

Cleanup candidates are prioritized ahead of refresh candidates within the batch. Scheduled refresh uses a full product input submission even when the payload hash is unchanged, so Merchant Center receives a freshness update before the 30-day window. Cleanup uses `productInputs.delete` through the same row processor used by full and incremental sync.

Operators with `security.manage` can preview exact candidates before enqueueing maintenance:

```http
GET /google-shopping/maintenance/preview?mode=dry-run&refreshWindowDays=25&limit=100
```

The preview response includes `refresh` and `cleanup` arrays with row ids, listing ids, Merchant offer ids, eligibility/tombstone state, payload hashes, and last submitted/accepted/delete timestamps.

To enqueue the current maintenance set:

```http
POST /google-shopping/maintenance/sync-jobs
Content-Type: application/json

{ "mode": "dry-run", "refreshWindowDays": 25, "limit": 100 }
```

Use live mode only after launch evidence gates pass and `GOOGLE_MERCHANT_DRY_RUN=false` is deployed. A request with no candidates returns the same summary and no job.

Retention decision:

- Durable Google Shopping sync job/event history follows the shared 7-day terminal job retention task.
- Google Shopping row sync state and diagnostics should remain available for 90 days after a Merchant withdrawal so Ops can correlate policy, crawl, and product issue evidence before later pruning work removes historical row state.

## Incident Response

If Google disapproves rows or reports seller-level issues:

- Keep the row identity stable; do not change offer ids to escape diagnostics.
- Use `external_seller_id` to identify the affected Chase Sets Account.
- Pause affected listings or seller availability through Marketplace/Identity-owned workflows.
- Let Discovery project the exclusion or tombstone state and let sync submit deletes for withdrawn rows.
- Record policy appeal or account approval evidence outside public docs when it contains private seller/provider data.
