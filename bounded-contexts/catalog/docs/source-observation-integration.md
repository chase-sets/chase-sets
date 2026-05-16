# Source Observation Integration

Catalog owns provider-fed product facts through a review-first Source Observation workflow.

## Policy

External providers never write canonical Catalog Items directly. Provider integrations write Source Observations, and Catalog operators promote or reject those observations after reviewing provenance, conflicts, normalized fields, and image assets.

## First Provider

TCGdex is the first provider.

The first implementation imports one configured Pokemon TCG expansion in one language from live TCGdex REST endpoints. TCGdex names this provider resource `set`; Catalog maps it to Pokemon's official `Expansion` language:

- `https://api.tcgdex.net/v2/{language}/sets/{setId}`
- `https://api.tcgdex.net/v2/{language}/cards/{cardId}`

TCGdex card image asset bases are source provenance only. During import, Catalog downloads the high quality `high.webp` card image as the Source Asset, generates a Product Asset Set of Chase Sets-owned WebP variants, and records both the structured Product Asset Set and compatibility normalized image URLs. The low quality TCGdex variant is intentionally not imported in this pass.

If TCGdex declares an image but the high quality asset cannot be downloaded, processed, or stored, that card observation fails and can be retried. Missing provider image data is still a valid observation and records no Product Asset Set or image URLs.

Generated variants are fixed by role rather than by embedded DPI/PPI metadata:

- `thumbnail`: 96w and 192w WebP for compact art surfaces.
- `search-card`: 160w and 320w WebP for search/catalog cards.
- `catalog-detail`: 480w and 960w WebP for item detail and admin review.
- `source`: original high-quality WebP for provenance and regeneration.

## Ownership

Catalog owns:

- Source Observations
- provider keys and external keys
- normalized candidate Catalog facts
- normalized Product Asset Sets derived from high quality provider assets
- source record hashes
- review status
- promotion into Catalog Item commands

Discovery consumes promoted Catalog facts through projections. Pricing may later consume provider pricing as Price Signals, but TCGdex pricing fields are not Catalog truth. Inventory owns seller-held copy facts and is not created by provider imports.

Stored TCGdex source payloads are sanitized before persistence; provider pricing fields are stripped from the observation payload and from the source-record hash.

## Promotion

Promotion creates a draft Catalog Item for the observed Pokemon card print, assigns the Pokemon card blueprint, sets card identity fields, assigns the Singles category, records TCGdex source mapping, attaches the Product Asset Set, and keeps Chase Sets-owned image URLs as a migration compatibility projection.

Promoted Catalog Items remain drafts so operators can verify blueprint fields, product resolution, and downstream display before publishing.

Promotion sets the Catalog Item's `Expansion` field as a Reference Record value. The Expansion Reference Record carries reusable release facts such as release date, card count, abbreviation, TCGdex source ID, and a relationship to its Series. Series records relate to the Pokemon Trading Card Game Product Line, which relates to the Manufacturer/Publisher reference. TCGdex `variants.reverse` is represented with Pokemon checklist terminology as `Parallel set` availability.

Operators may bulk promote explicitly selected Source Observations from the admin list screen. Bulk promotion is still a review action: it only accepts selected observation IDs, promotes records that are still `observed`, and reports terminal or missing records as skipped or failed instead of changing them.

Operators may also promote all eligible Source Observations matching the current reviewed list filters after spot checking a large import. Filter-scoped promote-all must show a confirmation summary before execution, including the target filter scope and expected count, and must still promote through the same per-observation Catalog behavior. It must not silently promote every observed Source Observation globally or rely on hidden "last import" session state.

The Source Observations list exposes the TCGdex set ID as a durable filter so large set imports can be reviewed and promoted by explicit scope instead of page selection. TCGdex import sets the reviewed scope to the imported language, set ID, and `observed` status.

## Conflict Pressure Tests

- Re-importing an observed source record updates the Source Observation while it remains `observed`.
- Re-importing the same observed source hash is idempotent and does not append a duplicate source-observation event.
- Promoted or rejected observations cannot be refreshed in place; a future implementation should create a changed-observation review if provider data changes after terminal review.
- Provider IDs are scoped by provider, language, and external key.
- Missing images are valid observations and should not block review.
- Declared image assets must normalize successfully before an observation is recorded; do not fall back to TCGdex display URLs.
- Re-importing an unchanged image writes to the same deterministic source-hash object keys.
- TCGdex pricing data must stay out of Catalog payload storage and promotion.
