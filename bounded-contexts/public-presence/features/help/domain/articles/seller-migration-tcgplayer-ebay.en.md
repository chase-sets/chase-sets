---
slug: seller-migration-tcgplayer-ebay
title: "Seller migration from TCGplayer or eBay: a bulk-listing on-ramp"
description: Move an existing TCGplayer or eBay CSV into Chase Sets, review the result, create draft listings, and reprice them in bulk without overstating what beta supports.
audience: seller
category: selling
reviewedAt: "2026-07-12"
citedPolicies:
  ["commercial-terms.marketplace-sales-fee-schedule", "settlement.clearance-window", "settlement.payout-bounds"]
relatedFlows: ["listing-confirmation", "payout-setup"]
claimCategories: ["fees", "payouts"]
promiseTable:
  - claim: The TCGplayer importer recognizes TCGplayer SKU first and Product ID as a fallback, infers condition when it can, and keeps unresolved rows in review.
    issues: ["#4085"]
    tests:
      [
        "bounded-contexts/inventory/features/import-batches/domain/import-source-adapters.test.ts",
        "bounded-contexts/inventory/features/import-batches/api/runtime.test.ts",
      ]
  - claim: The eBay importer accepts listing and variation identifiers, custom labels, catalog identifiers, quantities, and prices as mapping candidates without silently publishing rows.
    issues: ["#4085"]
    tests:
      [
        "bounded-contexts/inventory/features/import-batches/domain/import-source-adapters.test.ts",
        "bounded-contexts/inventory/features/import-batches/api/runtime.test.ts",
      ]
  - claim: Inventory import review can commit accepted rows into inventory and draft listings while preserving rejected rows for review; publication remains a separate listing action.
    issues: ["#4085"]
    tests:
      [
        "bounded-contexts/inventory/features/import-batches/api/runtime.test.ts",
        "bounded-contexts/inventory/features/import-batches/ui/import-batch-page.test.tsx",
      ]
  - claim: Bulk repricing accepts seller SKU or listing ID rows, suppresses unchanged prices before Marketplace, records applied, unchanged, and failed outcomes, and exports a results CSV.
    issues: ["#4085", "#4328"]
    tests:
      [
        "bounded-contexts/pricing/features/bulk-reprice-ingestion/tests/bulk-reprice-ingestion.db.test.ts",
        "bounded-contexts/pricing/features/bulk-reprice-ingestion/domain/csv.test.ts",
      ]
  - claim: Bulk repricing enforces one active job per account, supports cancellation, and applies the live upload-row ceiling rather than an unbounded batch.
    issues: ["#4328"]
    tests:
      [
        "bounded-contexts/pricing/features/bulk-reprice-ingestion/tests/bulk-reprice-ingestion.db.test.ts",
        "bounded-contexts/pricing/features/bulk-reprice-ingestion/domain/policy.test.ts",
      ]
  - claim: Payout requests stay blocked until payout setup and its destination are ready, and available sale proceeds still follow delivery and clearance rules.
    issues: ["#4085", "#4287"]
    tests:
      [
        "bounded-contexts/settlement/features/payout-readiness/ui/payout-setup-page.test.tsx",
        "bounded-contexts/settlement/features/payouts/api/runtime.test.ts",
        "bounded-contexts/settlement/features/wallets/read-model/queries.db.test.ts",
      ]
---

## The short version

Chase Sets has two separate bulk tools for a seller moving an existing catalog. Use the review-first inventory import to bring over stock and create draft listings. Use the bulk reprice on-ramp afterward when you want to change prices on listings that already exist. The reprice tool does not create listings.

This is a beta on-ramp, not a promise of a one-click marketplace migration or a provider sync. The current importer accepts CSV files; it does not store your TCGplayer or eBay credentials or schedule later provider syncs.

## Before you upload

Keep a copy of the source export. Decide which active Chase Sets storage location should receive the rows. For an export that represents the exact current stock, choose **replace** quantity mode; use **add** only when the file contains intentional stock adjustments.

The seller-facing flow is [Inventory imports](/account/inventory/imports). You can upload from that page, choose the matching source profile, review accepted and rejected rows, fix rows that need a catalog or option choice, and commit the accepted rows.

## Move TCGplayer inventory

1. Export your TCGplayer inventory as CSV and keep the provider's `TCGplayer SKU` or `Product ID` columns in the file. Include `Condition`, `Quantity`, and `TCG Marketplace Price` when you want stock, condition, and a starting listing price carried into review.
2. Open [Inventory imports](/account/inventory/imports), choose **TCGplayer CSV**, choose **replace** for an exact inventory export, select a storage location, and upload the file.
3. Review the batch. Chase Sets tries `TCGplayer SKU` first and falls back to `Product ID`. A `Product ID` row still needs an inferable condition or another option choice before it can be accepted. An unmapped reference stays rejected for review instead of being guessed.
4. Commit the accepted rows. If a row includes a listing price and quantity cap, the commit can create a **draft** listing alongside the inventory item. Publishing is a separate action in [your listings](/account/listings), so inspect the draft before it goes live.

The importer also carries a `Seller SKU` when present. When it is absent in a TCGplayer row, the source SKU is used as the account SKU candidate; keep your own SKU scheme stable if you plan to reprice by SKU later.

## Move eBay inventory

1. Export the eBay inventory or active-listing rows you want to migrate as CSV. Keep any identifiers your export provides: `Item ID`, `Variation ID`, `Custom label`, `ePID`, `GTIN`, `Quantity`, `Current price`, and `Condition`.
2. In [Inventory imports](/account/inventory/imports), choose **eBay CSV**, choose **replace** for an exact snapshot, choose a storage location, and upload the file.
3. Review the batch. The eBay profile tries listing and variation references, then seller SKU, catalog identifiers, and GTIN candidates. Condition is used for selected-option inference when available. Rows that do not resolve remain visible as rejected rows for correction.
4. Commit accepted rows, then review any resulting drafts in [your listings](/account/listings). The import does not silently publish an eBay row as a Chase Sets listing.

## Reprice listings in bulk

Once listings exist, open [Bulk reprice](/account/bulk-reprice). Download its template or use a CSV with these headers: `sellerSku`, `listingId`, and `newPrice`. Each row needs either `sellerSku` or `listingId`, plus a positive price.

The job resolves rows against your current listings first. A price that is already current becomes `unchanged` and is not sent to Marketplace. Other rows are applied in the durable job, with `applied`, `unchanged`, or `failed` outcomes and a downloadable results CSV. Only one active bulk-reprice job is allowed for an account, and you can cancel a queued or running job from the status page.

The launch policy's default upload ceiling is 250,000 rows. That is a validation ceiling, not a throughput promise. No wall-time, rows-per-second, or interactive-latency number is published here until an operator records a staging run; see the [bulk-listing proof walkthrough](https://github.com/chase-sets/chase-sets/blob/main/bounded-contexts/public-presence/docs/seller-migration-bulk-listing-proof.md) for the pending evidence and the exact shipped commands.

## Compare fees and check current terms

Use the [TCGplayer comparison page](/compare/tcgplayer) and [eBay comparison page](/compare/ebay) for dated side-by-side context. The [comparison calculator](/compare#calculator) lets you enter the same item price before comparing. Chase Sets' live fee schedule remains the canonical source for the fee you lock when you confirm a listing: [Marketplace sales and checkout fees](/sales-fees).

If you receive beta access, read the [Founders offer terms](/founders) and confirm that your account's current admission status makes the offer available before pricing your first listings. This migration guide does not reproduce offer values or eligibility rules; the terms page and current account state are authoritative. The [campaign claims record](https://github.com/chase-sets/chase-sets/blob/main/docs/campaigns/offer-economics-claims-substantiation.md) is the public-copy truth gate while the offer is pre-launch.

## Set up payouts before your first sale

Open [payout setup](/account/payouts/setup) and complete the account and payout-destination details in the Chase Sets setup page. Check the readiness state before you expect a payout. Once setup is ready, [Payouts](/account/payouts) shows what is available and lets you request a payout within the published bounds.

Sale proceeds do not become immediately available just because a buyer paid. Delivery must be recorded and the applicable clearance window must pass; support, fraud, chargeback, negative-balance, or stale-setup conditions can hold a request. [Getting paid](/help/selling/getting-paid) is the detailed payout reference.

## Migration checklist

- Preserve your source CSV and choose the correct source profile.
- Use **replace** for an exact inventory snapshot and **add** only for deliberate adjustments.
- Review rejected rows and selected condition or other options before committing.
- Treat imported listings as drafts until you inspect and publish them.
- Use bulk reprice only for existing listings, and keep its results CSV.
- Compare the same item price on the comparison pages and calculator.
- Complete payout setup before relying on sale proceeds.
