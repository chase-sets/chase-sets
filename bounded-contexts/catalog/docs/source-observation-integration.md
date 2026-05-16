# Source Observation Integration

Catalog owns provider-fed product facts through a review-first Source Observation workflow.

## Policy

External providers never write canonical Catalog Items directly. Provider integrations write Source Observations, and Catalog operators promote or reject those observations after reviewing provenance, conflicts, normalized fields, and image assets.

## First Provider

TCGdex is the first provider.

The first implementation imports one configured Pokemon set in one language from live TCGdex REST endpoints:

- `https://api.tcgdex.net/v2/{language}/sets/{setId}`
- `https://api.tcgdex.net/v2/{language}/cards/{cardId}`

TCGdex card image asset bases are stored as source-backed image URLs using low and high webp variants. The importer does not download or cache image bytes.

## Ownership

Catalog owns:

- Source Observations
- provider keys and external keys
- normalized candidate Catalog facts
- source record hashes
- review status
- promotion into Catalog Item commands

Discovery consumes promoted Catalog facts through projections. Pricing may later consume provider pricing as Price Signals, but TCGdex pricing fields are not Catalog truth. Inventory owns seller-held copy facts and is not created by provider imports.

Stored TCGdex source payloads are sanitized before persistence; provider pricing fields are stripped from the observation payload and from the source-record hash.

## Promotion

Promotion creates a draft Catalog Item for the observed Pokemon card print, assigns the Pokemon card blueprint, sets card identity fields, assigns the Singles category, records TCGdex source mapping, and attaches source-backed image URLs.

Promoted Catalog Items remain drafts so operators can verify blueprint fields, product resolution, and downstream display before publishing.

Operators may bulk promote explicitly selected Source Observations from the admin list screen. Bulk promotion is still a review action: it only accepts selected observation IDs, promotes records that are still `observed`, and reports terminal or missing records as skipped or failed instead of changing them.

## Conflict Pressure Tests

- Re-importing an observed source record updates the Source Observation while it remains `observed`.
- Re-importing the same observed source hash is idempotent and does not append a duplicate source-observation event.
- Promoted or rejected observations cannot be refreshed in place; a future implementation should create a changed-observation review if provider data changes after terminal review.
- Provider IDs are scoped by provider, language, and external key.
- Missing images are valid observations and should not block review.
- TCGdex pricing data must stay out of Catalog payload storage and promotion.
