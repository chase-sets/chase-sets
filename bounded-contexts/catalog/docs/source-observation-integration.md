# Source Observation Integration

Catalog owns provider-fed product facts through a review-first Source Observation workflow. The broader provider integration boundary is documented in [Catalog Integration Control Plane](./catalog-integration-control-plane.md), source-to-source field authority is documented in [Source Conflict Resolution](./source-conflict-resolution.md), job idempotency/concurrency guarantees are documented in [Catalog Integration Job Consistency](./catalog-integration-job-consistency.md), and Source Observation record compatibility is documented in [Catalog Integration Schema Compatibility](./catalog-integration-schema-compatibility.md).
Catalog-owned provider-neutral scope planning is documented in [Catalog Sync Scope Planning](./catalog-sync-scope-planning.md).

## Policy

External providers never write canonical Catalog Items directly. Provider integrations write Source Observations, and Catalog operators promote or reject those observations after reviewing provenance, conflicts, normalized fields, and image assets.

Catalog sync begins before provider execution with a `CatalogSyncScope` and a provider participation preview. The preview resolves the provider-neutral scope, such as Pokemon TCG / English / Expansion, into selected provider units and child `SourceObservationIntegrationJobScope` values. Those child scopes are still provider execution scopes; they do not grant providers authority to mutate Catalog Items or Products. In the later merged-candidate review, `delete` means rejecting or ignoring a candidate, not removing canonical Catalog truth.

## First Provider

TCGdex is the first provider.

The integration imports one configured Pokemon TCG expansion in one language from live TCGdex REST endpoints. TCGdex names this provider resource `set`; Catalog maps it to Pokemon's official `Expansion` language. Endpoint paths, supported languages, lookup scopes, variant mapping, promotion keys, provider reference attributes, marketplace identifier extraction, ambiguity policy, normalized observation mapping, hash material, and merge identity are seeded in the executable TCGdex Catalog Provider Integration Profile version; the registered TCGdex ProviderAdapter only fetches provider JSON and reports transport diagnostics:

- `https://api.tcgdex.net/v2/{language}/series`
- `https://api.tcgdex.net/v2/{language}/series/{seriesId}`
- `https://api.tcgdex.net/v2/{language}/sets`
- `https://api.tcgdex.net/v2/{language}/sets/{setId}`
- `https://api.tcgdex.net/v2/{language}/cards/{cardId}`

The Catalog Integrations admin import flow preloads Catalog-facing language and optional Series choices through the provider-neutral Integration Options query before provider pull jobs. Operators choose a language and may narrow to one Series; leaving Series as `All Series` imports every TCGdex Expansion for that language. Row-level resync imports one provider, language, and Expansion scope from the existing integration summary. Import jobs are enqueued through the typed Integration Jobs route.

Catalog exposes provider-specific import lookup data through a provider-neutral Integration Options query. The query is scoped by provider and option kind, then accepts provider-specific parent inputs such as language or Series. Provider profiles declare supported query aliases, parent requirements, named transport operations, and option DTO output selectors. TCGdex currently supports `providers`, `languages`, `series`, and `expansions`; the live language/Series/Expansion calls run through the TCGdex ProviderAdapter rather than direct runtime fetch branches. TCGplayer supports `product-lines` and `set-names` through the same resolver. Future providers should add new profile-backed option kinds behind the same Source Observations API instead of adding deployable-owned lookup routes. Option values may remain provider IDs, but visible labels should use Catalog-facing language such as Language, Series, and Expansion.

When a provider has multiple active profile units, Integration Options queries must select the active profile by profile key or ingestion-unit key, or by the unique active profile that declares the requested query kind. The option-query cache key includes profile key and ingestion-unit key so same-provider units cannot shadow each other's lookup results.

Import also ensures the Pokemon Reference Type and Reference Record hierarchy for the selected Expansion before recording Source Observations. Promotion still verifies the same hierarchy as a replay-safe safeguard. The hierarchy is provisioned from the active provider profile and its executable mapping evidence: Reference Types, static root records, provider-derived records, provider attributes, and relationships are data rules rather than TCGdex transport branches. Existing Reference Records are reused by Catalog keys or by provider attributes so replaying imports or importing another language for the same provider Series/Expansion does not create duplicate provider reference facts.

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

Source Observation recording keeps the complete sanitized provider evidence in event history. When one record event would exceed Catalog's bounded event target, the aggregate emits a metadata header followed by ordered base64 payload-chunk events in the same atomic stream append. Aggregate replay reassembles the original JSON value, and the Source Observation projector materializes the public read-model row only after the final chunk; small observations retain the inline event shape for historical compatibility.

TCGdex marketplace identifiers are mapping evidence, not pricing truth. When TCGdex exposes unambiguous TCGplayer or Cardmarket Product IDs for a card variant, promotion links them as Catalog Item-level external references such as `tcgplayer:product:490001` or `cardmarket:product:880001`. TCGplayer SKUs remain separate Product-level references because they identify sellable provider SKUs with selected options; TCGdex Product IDs must not be used as SKU mappings.

The profile marks these extracted marketplace IDs as Catalog Item-level references. Product-level SKU references are linked separately through Catalog Item Product references, where the selected Product options are known. This distinction lets Inventory imports resolve a TCGplayer Product ID to the card print and a TCGplayer SKU to the exact sellable Product without requiring sellers to pick products row by row.

Promotion checks exact external Catalog Item references first, then existing
Source Observation links, then deterministic Pokemon card evidence: language,
product line, expansion/set, card number, normalized name, and variant. A single
match refreshes the existing Catalog Item; multiple matches block promotion for
review so an import cannot create another plausible duplicate.

The direct TCGplayer integration uses the automation-app client contract in
[TCGplayer Automation Client Contract](./tcgplayer-automation-client-contract.md).
Its fixture-backed executable `test` profile maps provider product and SKU
evidence as Source Observations while the registered TCGplayer ProviderAdapter
owns option and import transport. The adapter serves product-line, set-name,
product, and SKU options, plans Product and Set Name import scopes, fetches
automation-app Product Detail payloads, attaches source provenance, and reports
credential/session, domain, retry, and rate-limit diagnostics without exposing
production cookies. Credential readiness is reported separately from profile
semantic readiness according to
[Catalog Integration Credential Readiness](./catalog-integration-credential-readiness.md).
It must not use official TCGplayer API documentation as the
provider contract for this workstream, and it must not store price, latest sale,
listing, order, message, or seller inventory facts as Catalog truth or source
hash material. TCGplayer SKU evidence remains review evidence until a SKU's
selected options validate against the active Catalog Product schema; only then
may `sku:<id>` become an External Product Reference.

The implemented production TCGplayer ingestion unit is
`tcgplayer:mtg:single-card:source-observation-import`. The older
`tcgplayer:pokemon:single-card:source-observation-import` automation profile is
retained as test lifecycle contract evidence. Future TCGplayer sealed product or
One Piece units must add separate profile versions before runtime import enables
them. Existing TCGplayer normalization helpers for product form, barcode, source
hash, selected Options, duplicate-prevention evidence, and promotion readiness
are reviewed Catalog semantic extension points until profile interpretation can
express those decisions safely. Replacing one requires complete deletion of the
old helper, tests, fixtures, seeds, documentation, runbooks, release notes, and
operator instructions.

Magic production sync uses the same Source Observation boundary. Scryfall,
MTGJSON, and TCGplayer Magic providers may record normalized Source Observation
facts, provenance, source hashes, and diagnostics, but they do not write Catalog
Items, Products, Reference Records, External Catalog Item References, or External
Product References directly. The production authority and retained-data rules
are tracked in [Catalog Integration Magic Production Signoff](./catalog-integration-production-signoff.md#magic):

- Scryfall is the primary Magic card-print and image-evidence source.
- MTGJSON is the Magic set/reference-data and cross-check source.
- TCGplayer Magic is limited to marketplace product, SKU, sealed-product, and
  external-reference identity.

TCGplayer Magic prices, market prices, latest sales, seller/account facts,
inventory, listings, quantities, orders, messages, cookies, session material,
and raw automation-app bodies are not Catalog truth, source-hash material,
operator evidence, logs, metrics, or screenshots. Production activation for any
Magic provider remains blocked until the Magic signoff is complete and the
interface-only staging UAT passes.

## Promotion

Promotion creates a draft Catalog Item for the observed Pokemon card print variant unless the active provider profile's ordered duplicate-prevention rules resolve a reusable Catalog Item. Existing source-linked Catalog Items are refreshed in place so repeated promotion cannot create duplicates. TCGdex duplicate prevention evaluates exact external Catalog Item references first, then source observation links, deterministic Pokemon card fields, and partial-draft retry evidence. Promotion then builds a reviewed Catalog Item command plan from the active provider profile's Catalog field, category, Reference Record, and external-reference mappings, and the runtime executes those commands against the Catalog Item aggregate. The TCGdex Pokemon plan assigns the Pokemon card blueprint, sets card identity fields, assigns the Singles category for newly created drafts, records TCGdex source mapping, generates and attaches the Catalog Item-owned Product Asset Set when provider imagery exists, and keeps Chase Sets-owned image URLs as a migration compatibility projection.

Provider-product Source Observations, including current TCGplayer automation imports, remain review evidence and are not promotable until their active profile declares Catalog Item promotion capability and a valid promotion command plan. The current TCGplayer executable profile is a `test` profile for mapping validation, not an active promotion profile. A blocked or ambiguous promotion plan returns diagnostics before any Catalog Item commands are written.

Promoted Catalog Items remain drafts so operators can verify blueprint fields, product resolution, and downstream display before publishing.

### Alias promotion

Promotion also turns reviewed alias candidates into Catalog-owned alias facts. Import records typed alias candidates per Source Observation; operators review them; promotion and reapply write the accepted ones as durable aliases on the resolved Catalog Item and Reference Record. Because the Catalog Item alias projection requires a resolved `catalog_item_id` before a row is written, promotion resolves the Catalog Item id and the Expansion/Series Reference Record ids first, then re-derives each accepted candidate against those ids so the deterministic `alias_hash` carries the resolved target. Reference Record aliases may stay key-only when set/series resolution lags, because the reference-record alias table allows a null `reference_record_id`.

Only `accepted` and `auto-accepted` candidates become publishable alias facts. Pending, generated, rejected, and revoked candidates never silently become Catalog truth: candidates that carry publication intent are proposed evidence-only as `pending`, and rejected or revoked candidates are not re-proposed at all. When a previously accepted alias's candidate is rejected or revoked in review, promotion and reapply drive a revoke so the published alias is retracted rather than left as a silent no-op, letting downstream search and display drop it. Provenance from the Source Observation and the producing profile mapping is preserved on every accepted alias fact.

Alias writes are idempotent: each alias is keyed by its `alias_hash`, so re-promoting or reapplying a scope refreshes aliases without duplicating facts. Changed provider evidence is handled review-first — affected candidates re-enter review as `pending` rather than silently mutating an alias an operator still accepts. When two accepted aliases share the same normalized text but disagree as official equivalents, promotion resolves the conflict by the alias source-precedence order (curated operator mapping over provider same-id endpoint, and so on); the precedence winner publishes and the rest are demoted to evidence-only.

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

Promoted variant Catalog Items keep printed card facts such as card name, card number, expansion, variant label, and rarity as Catalog Fields and Reference Records. Display Templates resolve the product-facing title and subtitle from those facts. For example, the default Pokemon single-card template can render `Abra 43/102` from `card-name`, `card-number`, and the Expansion Reference Record's `printed-card-count` attribute. If a set prints a different denominator or no denominator, operators edit the Expansion Reference Record's `printed-card-count` attribute in Catalog admin Reference Data instead of editing each Catalog Item title.

Promotion subtitles are likewise template-resolved from the Expansion, meaningful variant label, and rarity. The plain `Standard Set` variant label is omitted because it is the normal case; visible variants such as `1st Edition`, `Standard Set Foil`, reverse foil, and premium parallel labels remain in the subtitle and optional `Card Variant` field. If TCGdex provides only the shared card-number image, non-primary variants receive a description note that the image may not show the exact foil or pattern. The note is a Catalog Item presentation fact only; it does not change `catalog_item_id`, `product_id`, or Product option resolution.

Re-importing the same provider Expansion is the refresh path. Observations that are still `observed` refresh in place when the normalized provider facts or source payload hash changes. If the provider hash is unchanged, Catalog records a Source Observation refreshed fact instead of duplicating the original observation or mutating a promoted Catalog Item. That refreshed fact carries the current review state so Source Observation and Catalog Integrations read models can repair missing rows even when projection checkpoints are already caught up. If a promoted Source Observation changes, the Source Observation moves to `changed` and keeps its promoted Catalog Item link so operators can review the updated provider facts before Catalog truth changes. Broad provider pulls and row-level resyncs are background jobs so long TCGdex imports do not run in the browser request lifecycle.

Import, promote, reject, and sync jobs complete when their command/event work is durably written. They do not run Catalog projectors inline and do not guarantee that Integrations, Source Observation, Catalog Item, or Reference Data read models have caught up at the instant the job result is shown. Worker-hosted projector consumers advance those read models independently and publish admin invalidations as projections catch up. Operators should treat a completed job with stale list counts as projection lag or projector health to investigate, not as evidence that the browser page controls projection execution.

Background Source Observation jobs are deployment-tolerant. Worker turns are intentionally bounded and persist partial results after each batch before requeueing unfinished work. If a CI/CD deployment stops a worker, the next worker claims the queued or expired job and skips outcomes that were already durably recorded. Large promote-all, reject, import, and sync operations should therefore advance monotonically across repeated deployments rather than restarting from the first row. Import and reapply jobs also expose their profile snapshot, connector context, operator status, and consistency policy names so Admin workflows can distinguish queued, running, partial, failed, completed, stale, and retried states without parsing durable-job payload JSON.

Operators may bulk promote explicitly selected Source Observations from the admin list screen. Bulk promotion is still a review action: it only accepts selected observation IDs, promotes records that are still `observed` or `changed`, resyncs explicitly selected records that are already `promoted`, and reports terminal or missing records as skipped or failed instead of changing them. Promoting an `observed` Source Observation creates a new draft Catalog Item only when no reusable source-linked Catalog Item exists. Promoting a `changed` Source Observation refreshes the already-linked Catalog Item through normal Catalog Item commands, preserving `catalog_item_id` and Product identity while updating descriptive metadata, mapped fields, tags, source references, and Catalog-owned image assets.

Operators may also promote all eligible Source Observations matching the current reviewed list filters or the selected Catalog Integrations source scope after spot checking a large import. The selected-scope path starts from loaded provider options, such as TCGdex Language `Japanese`, Series `SV`, and Expansion `SV8`, then previews and promotes only observations matching that provider/unit/source-scope context. Filter-scoped promote-all must show a confirmation summary before execution, including the target filter scope and expected count, and must still promote through the same per-observation Catalog behavior. It must not silently promote every observed Source Observation globally or rely on hidden "last import" session state.

Operators may defer selected or filter-scoped Source Observations when provider evidence is not ready for a promote or reject decision. Deferral is a Catalog-owned review decision: it records the operator reason and durable job evidence, leaves `observed` observations as `observed`, leaves `changed` observations as `changed`, and keeps the rows in the review workflow. Deferral is not a terminal status, not a hidden skip list, and not a compatibility path for avoiding promotion requirements.

The Source Observations list exposes the TCGdex set ID as a durable filter so large set imports can be reviewed and promoted by explicit scope instead of page selection. TCGdex import sets the reviewed scope to the imported language, set ID, and `observed` status.

Mapping-only integration changes, such as improved title/subtitle formatting, may not change the provider source hash. Re-import remains idempotent for unchanged provider facts and must not silently mutate promoted Catalog Items. Operators sync promoted records from the Catalog Integrations surface for an explicit provider, language, and Expansion scope. Sync promoted runs as a background integration job, targets only Source Observations that are already `promoted`, requires an existing promoted Catalog Item link, uses the same Catalog Item refresh mapper as changed-observation promotion, and never creates replacement Catalog Items. Explicitly promoting an already promoted Source Observation follows the same resync behavior.

Reapply and replay previews use the shared [Catalog Integration Impact Analysis](./catalog-integration-impact-analysis.md) model. The preview reports matched, eligible, blocked, impacted Catalog Item, external-reference, active-job, and bounded sample evidence from committed Catalog state before the confirm action re-resolves the scope server-side. Reapply uses `current-active-profile` mode and snapshots the selected active provider profile/unit when the job is enqueued. Replay uses `original-source-profile` mode and must fail closed when the original Source Observation profile evidence is missing or carries a retired marker.

The Catalog Integrations admin surface summarizes Source Observations by provider, language, Expansion, and Series. It is a read-model view over Catalog-owned observations, not a separate provider configuration aggregate. Operators use it to load provider source options, select a concrete source scope, pull that selected scope, see what has already been pulled, promote all eligible observations in the selected scope, resync one set, jump into the exact Source Observation scope for record-level review or rejection, and sync current integration mapping to promoted observations after mapping logic changes. Future provider integrations should appear in the same summary once they record Source Observations with stable provider, language, and source-scope facts.

## Provider-Specific Runtime Cleanup Inventory

Preview, durable enqueue, target resolution, import, and reapply now share the
provider/unit/profile import planner. The planner resolves import targets from
the active or snapshotted Provider Integration Profile, asks the matching
ProviderAdapter for transport plans and payloads, then runs the executable
mapping contract before recording Source Observations. TCGdex Expansion fanout
and TCGplayer product-line/set-name fanout are profile option-query semantics,
not separate provider-key import workers.

TCGdex Reference Record hierarchy provisioning and alias candidate intake remain
named semantic helpers because the current executable mapping contract cannot
yet express those behaviors safely. They are invoked from the shared import path
only when the active profile declares the matching connector/capability, and
they remain fixture-backed clean launch extension points rather than alternate
provider import branches.

Import runs exclusively through the shared profile-driven integration path:
callers enqueue an integration job scope and the durable worker resolves import
targets, asks the matching ProviderAdapter for transport plans and payloads, and
runs the executable mapping contract before recording Source Observations. There
are no provider-key runtime service methods. New import, preview, enqueue,
promotion, reapply, or option-query behavior must add profile data, shared
interpreter support, or adapter transport methods instead of new provider-key
runtime branches.

## Conflict Pressure Tests

- Re-importing an observed source record updates the Source Observation while it remains `observed`.
- Re-importing the same observed source hash appends a refreshed Source Observation fact that preserves `observed` review state without duplicating the original recorded observation.
- Re-importing a changed source hash for a promoted observation creates a `changed` review without mutating the Catalog Item.
- Re-importing the same changed source hash appends a refreshed Source Observation fact that preserves `changed` review state while waiting for review.
- Promoting a changed observation refreshes the existing promoted Catalog Item instead of creating a duplicate.
- Promoting an observed source that already has a Catalog Item source reference refreshes that Catalog Item instead of creating a duplicate, unless the existing item is archived or removed.
- Promoting an already promoted Source Observation resyncs its linked Catalog Item and does not create another promotion event.
- Reapplying promoted observations refreshes linked Catalog Items with current integration mapping without changing Source Observation status or creating duplicate Catalog Items.
- Replaying promoted observations refreshes linked Catalog Items with the original Source Observation profile version and fails closed when that original profile evidence is missing or retired.
- Deferring observed or changed observations records a reason and keeps them in their existing review status.
- Reapply skips observations that are not promoted and fails promoted observations that are missing their linked Catalog Item.
- Rejected observations remain terminal in this pass; retrying a rejected source requires an intentional future new-observation workflow.
- Provider IDs are scoped by provider, language, and external key.
- Missing images are valid observations and should not block review or promotion.
- Declared image assets must normalize successfully before a Catalog Item is promoted; Source Observation review may show TCGdex display URLs, but promoted Catalog Items must publish only Catalog Item-owned Chase Sets asset URLs.
- Re-importing an unchanged observed card does not write Chase Sets asset objects; promotion writes deterministic source-hash object keys under the promoted Catalog Item path.
- TCGdex pricing data must stay out of Catalog payload storage and promotion.
- TCGplayer Product IDs link to Catalog Items; TCGplayer SKU IDs link to Products with selected Options.
- If TCGdex repeats the same marketplace Product ID across multiple variants in one card response, promotion must skip that external reference until a more precise provider mapping is available.
- Promoting a Source Observation persists its accepted item aliases on the resolved Catalog Item and its accepted expansion/series aliases on the resolved Reference Records.
- Re-promoting or reapplying a scope refreshes aliases without duplicating facts because each alias is keyed by its `alias_hash`.
- Pending, generated, and rejected alias candidates never become publishable aliases through promotion.
- Revoking or rejecting a previously accepted alias retracts it through promotion or reapply rather than leaving it published.
- Two accepted aliases with the same normalized text but disagreeing official-equivalent evidence resolve by alias source precedence; the winner publishes and the rest stay evidence-only.
