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
| `GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME` | Yes | Secret reference name only; never inline JSON. |

Startup fails when sync is enabled without complete required config.

## Feed Row Evidence

Before enabling production writes, collect a private evidence record with:

- total export rows,
- eligible rows,
- excluded rows by exclusion reason,
- tombstoned rows waiting for delete,
- rows missing title, description, image, price, condition, shipping policy, returns policy, or crawlability,
- sampled eligible listing URLs,
- sampled seller external ids,
- payload hash freshness,
- dry-run sync result.

## Staging And Proof

Use staging/proof in this order:

1. Keep `GOOGLE_MERCHANT_SYNC_ENABLED=false` while schema and projection changes deploy.
2. Enable dry-run with `GOOGLE_MERCHANT_SYNC_ENABLED=true` and `GOOGLE_MERCHANT_DRY_RUN=true`.
3. Verify row counts, exclusion reasons, URL crawlability, sitemap/robots posture, and JSON-LD alignment.
4. Confirm Merchant account/data-source approval outside the repo.
5. Enable non-production writes only when Google account policy and data-source setup are ready.
6. Keep production writes blocked until launch evidence gates pass.

## Incident Response

If Google disapproves rows or reports seller-level issues:

- Keep the row identity stable; do not change offer ids to escape diagnostics.
- Use `external_seller_id` to identify the affected Chase Sets Account.
- Pause affected listings or seller availability through Marketplace/Identity-owned workflows.
- Let Discovery project the exclusion or tombstone state and let sync submit deletes for withdrawn rows.
- Record policy appeal or account approval evidence outside public docs when it contains private seller/provider data.
