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
| `GOOGLE_SHOPPING_DIAGNOSTICS_INTERVAL_MS` | No | Defaults to 24 hours. Set to `0` to disable scheduled processed-product diagnostics refresh. |
| `GOOGLE_SHOPPING_DIAGNOSTICS_BATCH_SIZE` | No | Defaults to 100 submitted rows per diagnostics refresh job. |

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
- sampled eligible listing URLs are present in `https://marketplace.chasesets.com/sitemap.xml`,
- sampled eligible listing pages return matching canonical URLs,
- sampled production-public image URLs and crawlability checks,
- sampled seller external ids,
- public returns policy URL and Merchant Center return policy label,
- Merchant Center shipping settings evidence reference,
- Tax readiness evidence reference confirming Google-facing tax posture does not contradict checkout,
- payload hash freshness,
- dry-run sync result.

## Crawl Posture Evidence

Before live Merchant writes, run the focused crawl posture proof against the public marketplace origin with a small sample of eligible feed links:

```bash
pnpm run google-shopping:crawl-posture-evidence -- \
  --base-url https://marketplace.chasesets.com \
  --expect-indexing true \
  --sample-url https://marketplace.chasesets.com/listings/<listing-slug>
```

The proof records:

- `robots.txt` allows crawlers and declares the marketplace sitemap;
- `sitemap.xml` contains each sampled eligible feed link;
- each sampled listing page returns HTTP 200 and renders a canonical URL equal to the feed `link`;
- `merchantFeedSubmissionAllowed=true` only for `https://marketplace.chasesets.com` with indexing enabled.

For staging/proof, run the same command with `--expect-indexing false` and the staging base URL. A passing noindex proof requires `Disallow: /` and records `merchantFeedSubmissionAllowed=false`; do not use that environment as evidence for live Merchant submission.

## Launch Readiness Evidence

Before changing production from dry-run to live Merchant writes, produce a redacted Google Shopping readiness report and run:

```bash
pnpm run google-shopping:launch-readiness-evidence -- \
  --readiness-report ./secure/google-shopping-readiness.json \
  --expected-mode live \
  --reference GOOGLE-SHOPPING-LAUNCH-2026-06-04 \
  --production-sync-approval-reference GOOGLE-SHOPPING-SYNC-APPROVAL-2026-06-04
```

Use `--expected-mode disabled` when proving that Google Shopping submission is intentionally off, `--expected-mode dry-run` when proving the integration is configured but must not write live Merchant data, and `--expected-mode live` only for the final production launch gate. The command emits `passesGoogleShoppingLaunchReadinessGate`, `readinessStatus`, `merchantFeedSubmissionAllowed`, per-area gate summaries, errors, and warnings as JSON suitable for PR and release review.

The redacted readiness report should include:

- production environment values for `GOOGLE_MERCHANT_SYNC_ENABLED`, `GOOGLE_MERCHANT_DRY_RUN`, `CHASE_SETS_MARKETPLACE_INDEXING`, and the required Merchant account/data-source/target/feed/credential-secret variable names;
- feed quality counts: total, eligible, excluded, exclusion reasons, image eligibility counts, blocking issue counts, representative sample payloads, and sampled image HTTP checks;
- crawl posture output from `google-shopping:crawl-posture-evidence`;
- policy references for Merchant account approval, API data source, policy review, Merchant shipping settings, Merchant returns settings, Tax readiness, public shipping URL, public returns URL, and return policy label;
- diagnostics snapshot totals and launch-impact flags from `/google-shopping/diagnostics/snapshot`;
- the latest dry-run sync result with job reference, completion timestamp, total/submitted/skipped/deleted/excluded/failed counts.

Live mode blocks rollout when any P0 item is missing:

- `GOOGLE_MERCHANT_SYNC_ENABLED=true`, `GOOGLE_MERCHANT_DRY_RUN=false`, and `CHASE_SETS_MARKETPLACE_INDEXING=true` are not present together;
- required Merchant config variables are missing or not aligned to `US` / `en` / `US`;
- production sync approval reference is missing or a placeholder;
- the feed has no rows, no eligible rows, invalid sample payloads, failed sample image checks, or non-zero blocking issue counts;
- crawl posture does not pass or does not allow Merchant feed submission on `https://marketplace.chasesets.com`;
- account/data-source/policy/shipping/returns/Tax references or public policy URLs are missing;
- diagnostics include any disapproved submitted row;
- dry-run sync did not complete, processed zero rows, or recorded any failed rows.

Warnings still require operator review before launch but do not fail the P0 gate by themselves: fewer than three sample payloads, pending diagnostics rows, unknown provider issue codes, or P1 diagnostics launch-impact reasons.

## Staging And Proof

Use staging/proof in this order:

1. Keep `GOOGLE_MERCHANT_SYNC_ENABLED=false` while schema and projection changes deploy.
2. Enable dry-run with `GOOGLE_MERCHANT_SYNC_ENABLED=true` and `GOOGLE_MERCHANT_DRY_RUN=true`.
3. Verify row counts, exclusion reasons, URL crawlability, sitemap/robots posture, and JSON-LD alignment.
4. Verify image eligibility counts, sampled image crawlability, condition mapping, shipping settings, returns policy label, and Tax readiness posture.
5. Confirm Merchant account/data-source approval outside the repo.
6. Run `google-shopping:launch-readiness-evidence -- --expected-mode dry-run` and store the output reference in the private launch record.
7. Enable non-production writes only when Google account policy and data-source setup are ready.
8. Keep production writes blocked until `google-shopping:launch-readiness-evidence -- --expected-mode live` passes.

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

## Diagnostics

Diagnostics refresh reads Merchant API processed product status for submitted rows and persists normalized status on the Google Shopping feed row:

- `diagnostic_status`: `approved`, `approved_with_issues`, `disapproved`, `pending`, or `unknown`.
- `diagnostic_destination_statuses`: normalized provider destination status data.
- `diagnostic_issues`: active and resolved item-level issues with code, severity, resolution, attribute, reporting context, remediation text/URL, applicable countries, first seen, last seen, resolved at, and known/unknown code classification.
- `last_diagnostic_at`: the last processed-product diagnostic attempt.

Operators with `security.manage` can refresh diagnostics on demand:

```http
POST /google-shopping/diagnostics/refresh-jobs
Content-Type: application/json

{ "mode": "dry-run", "batchSize": 100 }
```

Use live mode only when Google Merchant sync is enabled and dry-run is disabled. Dry-run diagnostics prepares Merchant API `products.get` requests but does not mutate row diagnostic state.

The launch evidence snapshot is available at:

```http
GET /google-shopping/diagnostics/snapshot?limit=500
```

The snapshot includes approval/disapproval counts, active issue severity counts, unknown provider issue-code count, launch-impact flags, and row-level traceability to listing id, account id, catalog item id, product id, external seller id, and Merchant offer id. Store the snapshot output or evidence reference in the private launch evidence record; do not paste raw provider payloads or private seller data into public issues.

Launch-impact thresholds:

- P0: any submitted row has `diagnostic_status=disapproved`.
- P1: any active unknown provider issue code is present.
- P1: five or more submitted rows have active Merchant issues, even if not disapproved.

Raw provider payload retention remains bounded and secret-safe: sync job/event history is pruned after seven days, and feed rows keep only normalized diagnostics plus redacted provider response summaries.

## Incident Response

If Google disapproves rows or reports seller-level issues:

- Keep the row identity stable; do not change offer ids to escape diagnostics.
- Use `external_seller_id` to identify the affected Chase Sets Account.
- Pause affected listings or seller availability through Marketplace/Identity-owned workflows.
- Let Discovery project the exclusion or tombstone state and let sync submit deletes for withdrawn rows.
- Record policy appeal or account approval evidence outside public docs when it contains private seller/provider data.
