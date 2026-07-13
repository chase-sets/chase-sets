# Google Shopping Operations

This runbook owns the operator checklist for Chase Sets Google Merchant Center / Google Shopping integration. It is secret-safe: do not paste real credentials, private keys, account screenshots containing private seller data, or raw provider payloads into this file.

## Operator Surface And Evidence Links

The launch evidence output from `pnpm run ops google-shopping:launch-readiness-evidence` includes this runbook path as `runbook.path`. Store that JSON output or its private evidence reference with the Google Shopping readiness record so release reviewers can jump from the machine gate to the human operating guide.

The same output includes `privateEvidenceRecord.requiredSections`, which is the checklist the private launch record must satisfy: Merchant Center marketplace/multi-seller approval, Merchant API data source setup, shipping/returns/policy/Tax posture, feed quality sweep, production crawl posture, diagnostics snapshot, dry-run sync, and production live-sync approval. Keep provider screenshots, seller details, account ids, data-source ids, and credential references in the private evidence record only; public issues and PRs should use the external evidence reference plus the redacted gate summary.

The Google Shopping admin/operator surface should link to this runbook with the label `Google Shopping Operations` near sync status, diagnostics, and pause/rollback controls. The surface should not copy credentials, private Merchant Center screenshots, or raw provider payloads into the UI; it should show redacted status, row identifiers, evidence references, and the next operator action from this runbook.

## Account Posture

The integration targets Google's marketplace/multi-seller account model. Chase Sets rows use one Google offer per public Marketplace Listing and include an external seller id derived from the Chase Sets Account id.

Production submission remains blocked until Ops records a private evidence reference showing:

- Google Merchant Center account is approved for marketplace or multi-seller use.
- API data source exists for product uploads.
- Target country, content language, feed label, and destination settings are approved.
- Free-listings policy requirements have been reviewed.
- Seller-level policy handling for `external_seller_id` is understood.

If approval is not available, keep `GOOGLE_MERCHANT_SYNC_ENABLED=false` or `GOOGLE_MERCHANT_DRY_RUN=true`.

## First Launch Checklist

Complete these steps in order before live production Merchant writes:

1. Confirm Merchant Center approval, API data source creation, target country, content language, feed label, free-listings destination, shipping settings, returns settings, and marketplace/multi-seller handling in a private evidence record.
2. Confirm production worker variables are present with `GOOGLE_MERCHANT_SYNC_ENABLED=true`, `GOOGLE_MERCHANT_DRY_RUN=true`, `CHASE_SETS_MARKETPLACE_INDEXING=true`, and a credential secret reference that points to the bound service-account JSON variable.
3. Run the feed row evidence sweep and verify non-zero eligible rows, zero blocking row issues, representative sample payloads, HTTPS images, production listing links, seller external ids, and policy fields.
4. Run `pnpm run ops google-shopping:crawl-posture-evidence` against `https://marketplace.chasesets.com` with sampled eligible listing links and verify `merchantFeedSubmissionAllowed=true`.
5. Enqueue a full dry-run sync, wait for completion, and confirm `failed=0`, expected submitted/deleted/excluded counts, and a concrete job reference.
6. Refresh diagnostics in dry-run/live-read mode as appropriate, then capture `/google-shopping/diagnostics/snapshot?limit=500` with zero P0 disapproved submitted rows.
7. Run `pnpm run ops google-shopping:launch-readiness-evidence --expected-mode dry-run` and store the passing output reference.
8. Obtain production sync approval from Ops and policy owners, including the evidence reference that authorizes changing from dry-run to live writes.
9. Change production to `GOOGLE_MERCHANT_DRY_RUN=false` only after the dry-run evidence, diagnostics snapshot, crawl posture, policy references, and production approval are complete. Deploy `GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE` with the production sync approval reference in the same change; the worker refuses to start in live mode without it.
10. Run `pnpm run ops google-shopping:launch-readiness-evidence --expected-mode live --production-sync-approval-reference <reference>` and do not launch if `passesGoogleShoppingLaunchReadinessGate` is false.
11. Enqueue a small live sync batch first when possible, inspect provider responses and diagnostics, then scale to the normal full sync batch.
12. Monitor the next scheduled maintenance and diagnostics windows before declaring launch complete.

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
| `GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE` | Yes when `GOOGLE_MERCHANT_DRY_RUN=false` | Production sync approval evidence reference. The worker refuses to start with live Merchant writes unless this is a real, non-placeholder reference; keep it unset or empty while `GOOGLE_MERCHANT_DRY_RUN=true`. |
| `GOOGLE_SHOPPING_MAINTENANCE_INTERVAL_MS` | No | Defaults to 24 hours. Set to `0` to disable scheduled refresh/cleanup scans. |
| `GOOGLE_SHOPPING_MAINTENANCE_BATCH_SIZE` | No | Defaults to 100 rows per scheduled scan. |
| `GOOGLE_SHOPPING_REFRESH_WINDOW_DAYS` | No | Defaults to 25 days so accepted/submitted products refresh before the 30-day Merchant freshness window. |
| `GOOGLE_SHOPPING_DIAGNOSTICS_INTERVAL_MS` | No | Defaults to 24 hours. Set to `0` to disable scheduled processed-product diagnostics refresh. |
| `GOOGLE_SHOPPING_DIAGNOSTICS_BATCH_SIZE` | No | Defaults to 100 submitted rows per diagnostics refresh job. |
| `GOOGLE_SHOPPING_DIAGNOSTICS_PREVIOUS_ISSUE_CHUNK_SIZE` | No | Defaults to 100 previous diagnostic issues per reconciliation chunk. |

Startup fails when sync is enabled without complete required config. Startup also fails when `GOOGLE_MERCHANT_DRY_RUN=false` and `GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE` is missing or a placeholder value: the worker will not boot into live Merchant writes on config alone, so flipping `GOOGLE_MERCHANT_DRY_RUN` to `false` without also deploying a real approval reference is a hard failure, not a silent live-write risk.

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
pnpm run ops google-shopping:crawl-posture-evidence \
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
pnpm run ops google-shopping:launch-readiness-evidence \
  --readiness-report ./secure/google-shopping-readiness.json \
  --expected-mode live \
  --reference GOOGLE-SHOPPING-LAUNCH-2026-06-04 \
  --production-sync-approval-reference GOOGLE-SHOPPING-SYNC-APPROVAL-2026-06-04
```

Use `--expected-mode disabled` when proving that Google Shopping submission is intentionally off, `--expected-mode dry-run` when proving the integration is configured but must not write live Merchant data, and `--expected-mode live` only for the final production launch gate. The command emits `passesGoogleShoppingLaunchReadinessGate`, `readinessStatus`, `merchantFeedSubmissionAllowed`, per-area gate summaries, errors, and warnings as JSON suitable for PR and release review.

The redacted readiness report should include:

- production environment values for `GOOGLE_MERCHANT_SYNC_ENABLED`, `GOOGLE_MERCHANT_DRY_RUN`, `CHASE_SETS_MARKETPLACE_INDEXING`, and the required Merchant account/data-source/target/feed/credential-secret variable names;
- this runbook reference, either from `runbook.path` in the launch evidence output or from the private Google Shopping readiness record;
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

## Recurring Operating Cadence

Daily:

- Review the latest sync job results for failed rows, provider retry exhaustion, unexpected delete spikes, and rows stuck in pending diagnostics.
- Review diagnostics snapshot totals for any P0 disapproved row, unknown issue code, or P1 issue-volume warning.
- Confirm scheduled maintenance and diagnostics jobs are running when `GOOGLE_MERCHANT_SYNC_ENABLED=true`.

Weekly:

- Sample eligible feed rows and compare public listing pages, canonical URLs, image URLs, JSON-LD condition/availability, shipping policy URL, returns policy URL, and sitemap membership.
- Review exclusion reason trends with Catalog, Marketplace, Public Presence, and Ops owners so avoidable exclusions do not become launch-supply drift.
- Check Merchant Center account, API data source, shipping, returns, and policy status for notices that are not yet visible in row diagnostics.

Monthly:

- Reconfirm Merchant Center account access for the service account and remove stale human access.
- Re-run crawl posture evidence against production with fresh sampled listing URLs.
- Review Tax readiness and public policy references for any changes that could affect Google-facing disclosures.
- Confirm row sync state and diagnostics retention still satisfy the 90-day post-withdrawal evidence expectation.

After every release touching Catalog, Marketplace, Discovery, Public Presence, Ordering/Fulfillment, Tax, Identity, Platform Runtime, or public routing:

- Run a dry-run sync or maintenance preview for representative rows affected by the release.
- Refresh diagnostics if any submitted row shape, policy field, listing URL, image URL, price, availability, seller identity, shipping, returns, or crawl posture changed.
- Store the release-specific evidence reference when the change affects launch readiness or incident recovery.

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

## Diagnostics Owner Routing

| Symptom or issue family | Primary owner | First operator action |
| --- | --- | --- |
| Missing title, description, category, product identity, or selected option facts | Catalog | Fix canonical Catalog item data, replay/refresh Discovery projections, then dry-run sync the affected rows. |
| Missing or non-crawlable image URL, image fallback drift, or product asset issue | Catalog | Correct catalog imagery or fallback selection, confirm HTTPS public access, then refresh the affected feed rows. |
| Listing withdrawn, paused, seller availability disabled, price invalid, quantity unavailable, or stale buyable state | Marketplace | Correct listing lifecycle, price, quantity, or seller availability; let Discovery project the row tombstone/exclusion and submit deletes when needed. |
| Incorrect public listing URL, canonical URL mismatch, robots noindex, sitemap miss, or policy page link issue | Public Presence | Repair public routing, canonical metadata, robots/sitemap posture, or policy page availability before submitting live rows. |
| Shipping speed/cost mismatch, fulfillment destination limitation, or Merchant shipping settings conflict | Ordering/Fulfillment with Ops | Confirm checkout shipping behavior and Merchant Center shipping settings agree; update private Merchant settings or public policy evidence. |
| Tax disclosure, tax collection posture, or jurisdiction evidence conflict | Tax | Refresh Tax readiness evidence and ensure Google-facing tax posture does not contradict checkout. |
| Seller identity, account suspension, closed account, or `external_seller_id` traceability issue | Identity | Resolve account status or identity projection facts; Marketplace may pause seller availability while Identity remediation completes. |
| Sync job lease loss, worker startup config failure, credential secret missing, provider retry exhaustion, or scheduler lag | Platform Runtime | Fix worker configuration, credentials, scheduling, or provider client behavior; keep sync disabled or dry-run until stable. |
| Merchant account approval, API data-source approval, marketplace policy, item disapproval appeal, or unknown Google issue code | Ops / Google Merchant Center | Open Merchant Center/support escalation with redacted row identifiers, provider issue codes, and private evidence; keep offer ids stable. |
| Feed eligibility, payload hash, Merchant offer id, diagnostics normalization, or incremental request drain defect | Discovery | Fix projection/sync contracts, rerun focused tests, rebuild projections if needed, then dry-run sync before live writes. |

Unknown provider issue codes are P1 until classified. Route the first investigation through Ops/Google and Discovery together: Ops confirms the Merchant Center meaning, while Discovery decides whether the code maps to a known owner or remains a provider-only escalation.

## Emergency Pause And Withdrawal

Use this sequence when live Google Shopping writes could create buyer confusion, policy risk, or stale buyable rows:

1. Set `GOOGLE_MERCHANT_DRY_RUN=true` for the fastest write stop when the worker must keep producing dry-run evidence, or set `GOOGLE_MERCHANT_SYNC_ENABLED=false` when all Google Shopping sync and diagnostics jobs must stop.
2. If rows are currently buyable in Google but should be withdrawn, do not stop after disabling sync. First pause or withdraw the affected Marketplace listings, disable seller availability, or fix upstream facts so Discovery projects tombstones or exclusions.
3. Re-enable dry-run sync if needed and run a maintenance preview to confirm the stale submitted rows appear as cleanup candidates.
4. When it is safe to contact Merchant Center, temporarily allow live cleanup with `GOOGLE_MERCHANT_SYNC_ENABLED=true` and `GOOGLE_MERCHANT_DRY_RUN=false`, then enqueue a focused maintenance/full sync batch that submits `productInputs.delete` for stale rows.
5. Confirm the job result has the expected `deleted` count and `failed=0`. Refresh diagnostics until the withdrawn rows no longer appear as approved buyable products or the provider records their removal.
6. Return production to `GOOGLE_MERCHANT_DRY_RUN=true` or `GOOGLE_MERCHANT_SYNC_ENABLED=false` after cleanup if the incident is still active.
7. Record the private incident reference, affected row ids, Merchant offer ids, listing ids, operator, timestamps, config changes, sync job ids, and final diagnostics snapshot.

Do not change Merchant offer ids to escape a disapproval or stale row. Stable ids are required for provider diagnostics, cleanup deletes, evidence correlation, and seller/account traceability.

## Rollback And Recovery

Rollback to disabled:

1. Pause new live writes by setting `GOOGLE_MERCHANT_DRY_RUN=true` or `GOOGLE_MERCHANT_SYNC_ENABLED=false`.
2. Withdraw affected Marketplace listings or seller availability only when the public marketplace should also stop selling them.
3. For Google-only withdrawal, keep public listings active but run live cleanup for submitted rows that must leave Merchant Center.
4. Verify cleanup with sync job results and diagnostics snapshots before declaring rollback complete.
5. Store a rollback evidence reference and link it from the release or incident record.

Recover to dry-run:

1. Restore worker configuration with `GOOGLE_MERCHANT_SYNC_ENABLED=true` and `GOOGLE_MERCHANT_DRY_RUN=true`.
2. Run maintenance preview, full dry-run sync, crawl posture evidence, and diagnostics snapshot.
3. Fix all P0 blockers and review P1 warnings with the owner matrix above.

Recover to live:

1. Re-run launch readiness evidence in `dry-run` mode and confirm the private approval reference still applies.
2. Change `GOOGLE_MERCHANT_DRY_RUN=false`.
3. Re-run launch readiness evidence in `live` mode with the production sync approval reference.
4. Submit a bounded live batch before returning to the normal cadence.

## Incident Response

If Google disapproves rows or reports seller-level issues:

- Keep the row identity stable; do not change offer ids to escape diagnostics.
- Use `external_seller_id` to identify the affected Chase Sets Account.
- Pause affected listings or seller availability through Marketplace/Identity-owned workflows.
- Let Discovery project the exclusion or tombstone state and let sync submit deletes for withdrawn rows.
- Record policy appeal or account approval evidence outside public docs when it contains private seller/provider data.

Escalation paths:

- Merchant account, API data source, marketplace/multi-seller approval, and policy appeal issues: Ops owns the Google Merchant Center support path and keeps private approval references current.
- Credential, OAuth, retry, scheduler, deploy, or worker startup failures: Platform Runtime owns the incident and should keep live writes disabled or dry-run until the worker is healthy.
- Public crawlability, robots, sitemap, canonical, and policy page failures: Public Presence owns the public fix; Ops reruns crawl posture evidence before live writes resume.
- Source data or listing lifecycle failures: route through the owner matrix above and rerun dry-run sync before live writes.
- Any incident that affects buyer-visible availability or could leave Google with stale buyable rows: Marketplace and Ops jointly decide whether to pause public listings, submit Merchant deletes, or both.
