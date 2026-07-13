# Seller migration campaign assets

This is the content handoff for issue #4085. It records the guide, proof walkthrough, and the two downstream campaign placements requested by #4073 and #4083. A listed recording is not evidence that the video has been produced, and a mail handoff is not evidence that the nurture sequence has shipped.

## Assets

| Asset | Surface | Status | Canonical link or source |
| --- | --- | --- | --- |
| Seller migration guide | Public Help | Published with #4085 | [/help/selling/seller-migration-tcgplayer-ebay](/help/selling/seller-migration-tcgplayer-ebay) |
| Bulk-listing proof walkthrough | Public Presence operator/content reference | Published with #4085 | [seller-migration-bulk-listing-proof.md](../../bounded-contexts/public-presence/docs/seller-migration-bulk-listing-proof.md) |
| Bulk-listing demo clip | #4073 offer-flow/content asset list | Ready to record; not yet recorded | Use the proof walkthrough's TCGplayer import, eBay import, and bulk-reprice shot list below |
| Seller migration link in wave-1 admission mail | #4083 nurture sequence | Copy handoff ready; sequence implementation remains #4083 | `https://chasesets.com/help/selling/seller-migration-tcgplayer-ebay?utm_source=email&utm_medium=drip&utm_campaign=wave1_admission&utm_content=seller_migration_guide` |

## #4073 demo clip shot list

Record a short, seller-facing screen capture with test or staging data only:

1. Open Inventory imports, choose TCGplayer CSV, upload a small export, and pause on accepted and rejected rows.
2. Show the review step and commit accepted rows; keep the resulting listing visibly in draft state.
3. Repeat the source-profile choice for eBay CSV, then show the same review-first behavior.
4. Open Bulk reprice for an existing listing, upload the three-column template, and show applied, unchanged, or failed results plus the results CSV.
5. End on the migration guide. Do not show credentials, claim provider sync, imply automatic publication, or quote throughput until staging evidence exists.

The clip should demonstrate the beta workflow, not promise a one-click provider migration or a completion time. The proof walkthrough contains the exact API shapes and the operator-pending benchmark command.

## #4083 admission-mail handoff

The admission message should link the guide from the first-listing walkthrough section using the tracked URL in the asset table. Keep the surrounding offer language conditional on the account's actual admission event and current terms; the guide intentionally avoids repeating pre-launch offer claims. The message should continue to carry the referral link and the existing unsubscribe treatment required by #4083.
