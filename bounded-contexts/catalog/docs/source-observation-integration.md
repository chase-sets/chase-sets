# Source Observation Integration

Catalog owns provider-fed product facts through a review-first Source Observation workflow.

## Policy

External providers never write canonical Catalog Items directly. Provider integrations write Source Observations, and Catalog operators promote or reject those observations after reviewing provenance, conflicts, normalized fields, and image assets.

## First Provider

TCGdex is the first provider.

The integration imports one configured Pokemon TCG expansion in one language from live TCGdex REST endpoints. TCGdex names this provider resource `set`; Catalog maps it to Pokemon's official `Expansion` language:

- `https://api.tcgdex.net/v2/{language}/series`
- `https://api.tcgdex.net/v2/{language}/series/{seriesId}`
- `https://api.tcgdex.net/v2/{language}/sets`
- `https://api.tcgdex.net/v2/{language}/sets/{setId}`
- `https://api.tcgdex.net/v2/{language}/cards/{cardId}`

The Source Observations admin import flow preloads Catalog-facing language, Series, and Expansion choices before card import. Operators choose a language, then a Series, then an Expansion; the UI submits the selected Expansion's TCGdex set ID to the existing import command. Raw expansion IDs remain accepted at the API boundary for compatibility and scripted operations, but routine admin loading should not require manually looking up provider IDs.

Catalog exposes provider-specific import lookup data through a provider-neutral Integration Options query. The query is scoped by provider and option kind, then accepts provider-specific parent inputs such as language or Series. TCGdex currently supports `languages`, `series`, and `expansions`; future providers should add new option kinds behind the same Source Observations API instead of adding deployable-owned lookup routes. Option values may remain provider IDs, but visible labels should use Catalog-facing language such as Language, Series, and Expansion.

Import also ensures the Pokemon Reference Type and Reference Record hierarchy for the selected Expansion before recording Source Observations. Promotion still verifies the same hierarchy as a replay-safe safeguard. Existing Reference Records are reused by Catalog keys or by TCGdex provider attributes so replaying imports or importing another language for the same provider Series/Expansion does not create duplicate provider reference facts.

TCGdex card image asset bases are source provenance only. During import, Source Observations may display the provider's high quality `high.webp` image URL, but Catalog does not mirror those bytes into Chase Sets asset storage and does not generate public Source Observation bucket keys. This keeps pre-promotion review tied to provider provenance and prevents public Chase Sets URLs from revealing provider, language, or external card identifiers.

During promotion, Catalog downloads the high quality provider image, stores a Catalog Item-owned Source Asset, generates a Product Asset Set of Chase Sets-owned WebP variants under `catalog/items/{catalog_item_id}`, and records both the structured Product Asset Set and compatibility normalized image URLs on the promoted Catalog Item. The low quality TCGdex variant is intentionally not imported in this pass.

If TCGdex declares an image but the high quality asset cannot be downloaded, processed, or stored during promotion, that promotion fails and can be retried. Missing provider image data is still a valid observation and promotes without a Product Asset Set or image URLs.

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

Promotion creates a draft Catalog Item for the observed Pokemon card print variant unless the same provider, language, and external key already resolve to an existing Catalog Item that is not archived or removed. Existing source-linked Catalog Items are refreshed in place so repeated promotion cannot create duplicates. Promotion assigns the Pokemon card blueprint, sets card identity fields, assigns the Singles category for newly created drafts, records TCGdex source mapping, generates and attaches the Catalog Item-owned Product Asset Set when provider imagery exists, and keeps Chase Sets-owned image URLs as a migration compatibility projection.

Promoted Catalog Items remain drafts so operators can verify blueprint fields, product resolution, and downstream display before publishing.

Promotion sets the Catalog Item's `Expansion` field as a Reference Record value. The Expansion Reference Record carries reusable release facts such as release date, card count, abbreviation, TCGdex source ID, and a relationship to its Series. Series records relate to the Pokemon Trading Card Game Product Line, which relates to the Manufacturer/Publisher reference.

Each true TCGdex card variant is imported as its own Source Observation because Source Observation review status, retry behavior, and promotion are one-to-one with Catalog Item creation. The primary variant keeps the provider card's original external key so existing main-card observations refresh into the primary variant. Secondary variant observation external keys append the normalized variant key, such as `swsh3-136:reverse-holo`, so a single provider card can create multiple Catalog Items without colliding with `UNIQUE (provider_key, language_code, external_key)`.

Known TCGdex variant keys are translated into official Pokemon set-bucket language before they become Catalog facts. Provider keys remain in `cardVariantSourceKey`; Catalog-facing labels avoid provider shorthand:

- `normal` -> `Standard Set`
- `holo` -> `Standard Set Foil`
- `reverse` -> `Parallel Set - Reverse Foil`
- `firstEdition` / `1stEdition` -> `1st Edition`
- `pokeBall` / `pokeball` -> `Premium Parallel Set - Poke Ball`
- `masterBall` / `masterball` -> `Premium Parallel Set - Master Ball`

Unknown true variant keys are preserved as separate observations and humanized as `Unclassified Variant - <Label>` so imports remain forward-compatible while avoiding raw provider key casing and avoiding unsupported `parallel set` claims in Catalog titles, subtitles, and fields.

Promoted variant Catalog Items use the printed card name plus displayed card number as the title, such as `Abra 43/102`. The displayed card number uses the provider card number plus the official Expansion card count by default. If a set prints a different denominator or no denominator, operators can edit the Expansion Reference Record's `printed-card-count` attribute in Catalog admin Reference Data. A number or non-empty string overrides the denominator; `null` keeps the card number bare for promo-style numbering.

Promotion subtitles include the Expansion, meaningful variant label, and rarity with bullet separators, such as `Base Set • 1st Edition • Common`. The plain `Standard Set` variant label is omitted because it is the normal case; visible variants such as `1st Edition`, `Standard Set Foil`, reverse foil, and premium parallel labels remain in the subtitle and optional `Card Variant` field. If TCGdex provides only the shared card-number image, non-primary variants receive a description note that the image may not show the exact foil or pattern. The note is a Catalog Item presentation fact only; it does not change `catalog_item_id`, `product_id`, or Product option resolution.

Re-importing the same provider Expansion is the refresh path. Observations that are still `observed` refresh in place when the normalized provider facts or source payload hash changes. If a promoted Source Observation changes, the Source Observation moves to `changed` and keeps its promoted Catalog Item link so operators can review the updated provider facts before Catalog truth changes.

Operators may bulk promote explicitly selected Source Observations from the admin list screen. Bulk promotion is still a review action: it only accepts selected observation IDs, promotes records that are still `observed` or `changed`, resyncs explicitly selected records that are already `promoted`, and reports terminal or missing records as skipped or failed instead of changing them. Promoting an `observed` Source Observation creates a new draft Catalog Item only when no reusable source-linked Catalog Item exists. Promoting a `changed` Source Observation refreshes the already-linked Catalog Item through normal Catalog Item commands, preserving `catalog_item_id` and Product identity while updating descriptive metadata, mapped fields, tags, source references, and Catalog-owned image assets.

Operators may also promote all eligible Source Observations matching the current reviewed list filters after spot checking a large import. Filter-scoped promote-all must show a confirmation summary before execution, including the target filter scope and expected count, and must still promote through the same per-observation Catalog behavior. It must not silently promote every observed Source Observation globally or rely on hidden "last import" session state.

The Source Observations list exposes the TCGdex set ID as a durable filter so large set imports can be reviewed and promoted by explicit scope instead of page selection. TCGdex import sets the reviewed scope to the imported language, set ID, and `observed` status.

Mapping-only integration changes, such as improved title/subtitle formatting, may not change the provider source hash. Re-import remains idempotent for unchanged provider facts and must not silently mutate promoted Catalog Items. Operators reapply the current integration mapping from the Catalog Integrations surface for an explicit provider, language, and Expansion scope. Reapply only targets Source Observations that are already `promoted`, requires an existing promoted Catalog Item link, uses the same Catalog Item refresh mapper as changed-observation promotion, and never creates replacement Catalog Items. Explicitly promoting an already promoted Source Observation follows the same resync behavior.

The Catalog Integrations admin surface summarizes Source Observations by provider, language, Expansion, and Series. It is a read-model view over Catalog-owned observations, not a separate provider configuration aggregate. Operators use it to see what has already been pulled, how many records still need review, jump into the exact Source Observation scope for promotion or rejection, and reapply current integration mapping to promoted observations after mapping logic changes. Future provider integrations should appear in the same summary once they record Source Observations with stable provider, language, and source-scope facts.

## Conflict Pressure Tests

- Re-importing an observed source record updates the Source Observation while it remains `observed`.
- Re-importing the same observed source hash is idempotent and does not append a duplicate source-observation event.
- Re-importing a changed source hash for a promoted observation creates a `changed` review without mutating the Catalog Item.
- Re-importing the same changed source hash remains idempotent while waiting for review.
- Promoting a changed observation refreshes the existing promoted Catalog Item instead of creating a duplicate.
- Promoting an observed source that already has a Catalog Item source reference refreshes that Catalog Item instead of creating a duplicate, unless the existing item is archived or removed.
- Promoting an already promoted Source Observation resyncs its linked Catalog Item and does not create another promotion event.
- Reapplying promoted observations refreshes linked Catalog Items with current integration mapping without changing Source Observation status or creating duplicate Catalog Items.
- Reapply skips observations that are not promoted and fails promoted observations that are missing their linked Catalog Item.
- Rejected observations remain terminal in this pass; retrying a rejected source requires an intentional future new-observation workflow.
- Provider IDs are scoped by provider, language, and external key.
- Missing images are valid observations and should not block review or promotion.
- Declared image assets must normalize successfully before a Catalog Item is promoted; Source Observation review may show TCGdex display URLs, but promoted Catalog Items must publish only Catalog Item-owned Chase Sets asset URLs.
- Re-importing an unchanged observed card does not write Chase Sets asset objects; promotion writes deterministic source-hash object keys under the promoted Catalog Item path.
- TCGdex pricing data must stay out of Catalog payload storage and promotion.
