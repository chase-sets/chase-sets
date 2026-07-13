# Campaign Market-Data Series

This is the operating guide for issue #4073's weekly market-data posts. The generator reads Pricing's public m111 market-rollups API: weekly Daily Product Rollups derived from the Trades Tape plus the latest Market-State Snapshot. It never accepts hand-entered numbers.

## Truth boundary

- Each artifact covers one resolved product. `game` and `community` select the audience; they do not turn the result into a game-wide aggregate.
- Weekly medians are used only when Pricing returns a non-null `medianPriceAmount`, meaning the live Stat-Hygiene Policy's minimum sample cleared.
- Fixture and staging artifacts are hard-marked non-publishable. Only a production API run can produce `publication.publishable: true`, and operator review is still required.
- Per-grade comparisons are unavailable. Do not use “PSA 10,” “graded vs. raw,” or any other grade-specific market-data wording. The governing ruling is [Claim 5](./offer-economics-claims-substantiation.md#claim-5--market-data-numbers).
- Generated numbers and the source note are indivisible. If a number looks surprising, stop and inspect Pricing; do not “correct” the copy by hand.

## Rehearse from the committed fixture

The fixture is synthetic and exists only to prove deterministic rendering:

```powershell
pnpm run campaign:market-data -- `
  --input scripts/fixtures/campaign-market-data/weekly-product.json `
  --out artifacts/campaigns/market-data-fixture
```

This writes Markdown for review and JSON for provenance. Both outputs say `DO NOT PUBLISH`.

## Staging run

Staging currently provides representative commerce state, not public market evidence. Replace every `TODD_*` token with values read from the staging item's `/market/{slug}` page or its network responses:

```powershell
pnpm run campaign:market-data -- `
  --api-base-url https://marketplace.staging.chasesets.com/api/marketplace `
  --source-environment staging `
  --catalog-item-id TODD_CATALOG_ITEM_ID `
  --product-id TODD_PRODUCT_ID `
  --title "TODD_ITEM_TITLE" `
  --game "TODD_GAME" `
  --community "TODD_SUBREDDIT" `
  --from 2026-07-20 `
  --to 2026-07-26 `
  --as-of 2026-07-26 `
  --out artifacts/campaigns/market-data-staging
```

The API base is the marketplace same-origin proxy because Pricing is mounted at `/api/marketplace`. The generator binds `staging` and `production` labels to their canonical HTTPS API bases; an arbitrary or staging URL cannot produce a publishable artifact. The script requests only:

- `/market-rollups/{catalogItemId}/{productId}/series?...&granularity=weekly`
- `/market-rollups/{catalogItemId}/{productId}/stats`

Staging output remains rehearsal-only even when the numbers are internally consistent.

## Production publishing run

After production contains real trades, repeat the command against `https://marketplace.chasesets.com/api/marketplace` with `--source-environment production`, an explicit UTC date range, and an explicit `--as-of` date. Before posting, TODD must verify:

1. `publication.publishable` is `true` in the JSON artifact.
2. The subject and target community match; the selected item belongs to the named game.
3. The source note is present verbatim and no number was edited after generation.
4. No account identity, individual trade, grade-specific claim, or game-wide inference was added.
5. The artifact is retained under gitignored `artifacts/campaigns/` for the publishing run.

If no production row clears the median gate, publish the generator's “no price movement is claimed” version or skip the slot. Never substitute staging or fixture values.
