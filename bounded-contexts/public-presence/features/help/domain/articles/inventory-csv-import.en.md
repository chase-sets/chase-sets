---
slug: inventory-csv-import
title: "Import inventory from a CSV file"
description: Use the review-first inventory import to bring stock into Chase Sets from a native CSV, understand seller-SKU resolution and quantity modes, and turn accepted rows into draft listings.
audience: seller
category: selling
citedPolicies: []
relatedFlows: ["listing-confirmation"]
claimCategories: []
reviewedAt: "2026-07-13"
promiseTable:
  - claim: Inventory imports validate every row in a review-first batch, resolve rows by seller SKU or catalog identifier, and keep unknown or duplicate rows in review instead of guessing.
    issues: ["#4358"]
    tests:
      [
        "bounded-contexts/inventory/features/import-batches/domain/import-source-adapters.test.ts",
        "bounded-contexts/inventory/features/import-batches/api/runtime.test.ts",
      ]
  - claim: Committing an import can create inventory items and draft listings while preserving rejected rows for review, and publication stays a separate listing action.
    issues: ["#4358"]
    tests:
      [
        "bounded-contexts/inventory/features/import-batches/api/runtime.test.ts",
        "bounded-contexts/inventory/features/import-batches/ui/import-batch-page.test.tsx",
      ]
---

## How importing works

Inventory imports are review-first. You upload a CSV, Chase Sets validates every row before anything changes, and you review accepted and rejected rows on the [Inventory imports](/account/inventory/imports) page. Nothing enters your inventory or goes live until you commit the accepted rows, so a bad row is never guessed into stock.

This guide covers the **native Chase Sets CSV**. To move a TCGplayer or eBay export instead, use the provider profiles described in the [seller migration guide](/help/selling/seller-migration-tcgplayer-ebay); the review, SKU, and commit behavior below is the same.

## The native template

From the [Inventory imports](/account/inventory/imports) page you can download a native template that already has the required headers and one example row for each active storage location on your account. Archived locations are not included.

A native row uses these columns:

- `catalogItemId` — the Chase Sets catalog item, or leave it out when the row resolves by seller SKU.
- `storageLocation` — the visible name of an active storage location. `storageLocationId` is also accepted.
- `totalQuantity` — the stock count, interpreted by the quantity mode you choose at upload.
- Option columns such as `option:form` and `option:condition` — use catalog dimension ids or their visible labels, and option ids, codes, or visible labels for the values.
- `acquisitionCostAmount` — what you paid, when you want to track cost.
- `sellerSku` — your own SKU for the row (see below).
- `listingPriceAmount` and `listingQuantityCap` — include both when you want the commit to create a draft listing.
- `rowNote` — a free-text note for your own reference during review.

An example header and row:

- Header: `catalogItemId,storageLocation,totalQuantity,option:form,option:condition,acquisitionCostAmount,sellerSku,listingPriceAmount,listingQuantityCap,rowNote`
- Row: `cat_seed_charizard_base_set,Main shelf,2,Raw,Near Mint,75.00,box-a-001,125.00,1,Base Set restock`

## Seller SKUs and how rows resolve

If you already have a seller-SKU mapping, a native row can use `sellerSku` (or the header `Seller SKU`) with no `catalogItemId`. Seller SKUs are owned by Inventory and scoped to your account, so the same SKU text can safely map to different products for different sellers. Unknown or duplicate SKU mappings stay in import review rather than resolving to the wrong product.

A SKU-only row therefore looks like this:

- Header: `Seller SKU,storageLocation,totalQuantity,acquisitionCostAmount,listingPriceAmount,listingQuantityCap,rowNote`
- Row: `box-a-001,Main shelf,2,75.00,125.00,1,Restock by account SKU`

Keep your SKU scheme stable if you plan to reprice or re-import by SKU later.

## Quantity modes

At upload you choose how `totalQuantity` is read:

- **add** treats the number as a signed adjustment to existing stock.
- **replace** treats the number as the exact count to sync to.

Choose **replace** when the file represents your exact current stock — for example when you re-upload an edited current-inventory export. Choose **add** only when the rows are deliberate stock adjustments. You can export your current inventory from the same [Inventory imports](/account/inventory/imports) page; that export already uses native headers and exact counts, so it round-trips cleanly with **replace**.

## Commit and review the result

Committing writes the accepted rows into inventory. When a row includes both a listing price and a quantity cap, the commit can also create a **draft** listing next to the inventory item. Rejected rows stay on the review page so you can fix a catalog or option choice and re-run them; they are never committed silently.

Publishing is always a separate step. Open [your listings](/account/listings) to inspect each draft before it goes live, and confirm it meets the [condition and photo standards](/help/selling/condition-and-photo-standards). Your locked sales fee is shown at that point; the live schedule is on [Marketplace sales and checkout fees](/sales-fees).

## Import checklist

- Download the native template or export your current inventory as the starting file.
- Use `sellerSku` for rows you want resolved by your own SKU, and keep that scheme stable.
- Choose **replace** for an exact stock snapshot and **add** only for deliberate adjustments.
- Review rejected rows and fix catalog or option choices before committing.
- Treat any listings the commit creates as drafts until you inspect and publish them.
