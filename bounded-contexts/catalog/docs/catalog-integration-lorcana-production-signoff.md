# Catalog Integration Lorcana Production Signoff

This document is the production activation start gate for Disney Lorcana
Catalog sync from LorcanaJSON, Lorcast, Scrydex, and the existing Chase Sets
TCGplayer provider path.

Tracking:

- Milestone: #50 Disney Lorcana catalog provider production sync
- Parent tracker: #2463
- Source authority: #2464 and #2466
- Required staging UAT: #2481
- Downstream projection smoke: #2486

Production activation is not approved until this signoff is complete and the
staging UAT passes from the Chase Sets interface. Operators must not use
handcrafted URLs, direct API calls, CLI commands, SQL, Postman, browser console
commands, manual provider endpoint access, or hidden Admin/API routes for the
UAT.

## Provider Authority

| Provider | Production role | Catalog authority | Explicitly not Catalog truth |
| --- | --- | --- | --- |
| LorcanaJSON | Preferred free bulk-first reference source for sets, cards, languages, variants, image URI evidence, metadata, and official deck files where approved | Set/chapter identifiers, card print identifiers, collector numbers, printed names and versions, rarity, ink, classifications, properties, language facts, image URI evidence when approved, bulk metadata, generated-on, checksum, and freshness evidence | Marketplace product ids as canonical Catalog identity, prices, seller or account facts, raw provider bodies, and unapproved provider imagery copies |
| Lorcast | Free supplemental source for set/card option queries, image URIs, TCGplayer ids, legalities, and lightweight price evidence where approved | Set-scoped card lookup evidence, supplemental image URI evidence, TCGplayer id bridge candidates, legality diagnostics, lightweight price diagnostics when approved, cache and pacing diagnostics | Canonical winner when LorcanaJSON or official validation disagrees, prices as Catalog identity, raw provider bodies, and provider imagery copies without retained-data approval |
| TCGplayer | Lorcana marketplace product, SKU, group/set, sealed-product, variant, and price-reference evidence through the existing Chase Sets automation path | Product id external-reference candidates, SKU external-product-reference candidates after selected Options validate, group/set-name matching evidence, condition/language/printing/sealed-form evidence, marketplace product image URI evidence when approved | Prices as Catalog identity, market prices as Catalog truth, latest sales, seller/account facts, inventory, listings, orders, messages, cookies, session material, and TCGCSV as a production provider |
| Scrydex | Paid supplemental Lorcana source where its coverage is better for cards, sets, variants, sealed products, image evidence, price-reference evidence, and freshness signals | Card and variant identifiers, set identifiers, sealed product identifiers and packaging labels, image URI evidence when approved, provider freshness, usage, credit, and cache diagnostics | API keys or team ids, per-game Scrydex credential settings, seller facts, inventory quantities, listings, orders, raw provider bodies, and unapproved price-history bodies |
| Disney Lorcana/Ravensburger official | Canonical validation reference only unless legal/source-authority approval explicitly permits ingestion | Manual validation reference, source-disagreement evidence after redaction, and operator checklist evidence that provider records align with official release information | Raw official page text, official imagery copies, scraped payload bodies, and automated ingestion facts without explicit approval |

Provider adapters collect observed facts and sanitized diagnostics. They do not
write Catalog Items, Products, Reference Records, External Catalog Item
References, or External Product References directly. Catalog Source
Observations, promotion, conflict policy, duplicate prevention, and operator
review own the transition into Catalog truth.

TCGCSV is not a production provider for this milestone. TCGplayer evidence must
come from the existing Chase Sets TCGplayer automation provider and the same
secure credential/redaction posture used by the other product lines.

## Official Validation

Ravensburger and official Disney Lorcana pages are validation-only references
for this milestone. They may confirm:

- set names, set codes, release and prerelease dates;
- printed totals, total counts, and card-gallery presence;
- official product lineup, pack counts, starter decks, troves, gift sets, and
  other sealed-product labels;
- official app references and release-family membership.

Representative validation checks must cover the operator-selected current or
most recent main set and the stable older `The First Chapter` (`TFC`) set before
production signoff. Official references may be recorded only as redacted
validation labels and source-disagreement diagnostics. The evidence must not
retain raw official text, official imagery copies, scraped payload bodies, or
hidden provider URLs.

## Scrydex Credit Policy

Scrydex API requests consume paid credits. Scrydex Lorcana imports must be
bulk-first and credit-aware:

- use bulk/list/search pagination for cards, variants, sets, sealed products,
  approved price-reference evidence, and freshness evidence whenever possible;
- use the highest safe Scrydex-supported page size for the selected import unit
  unless measured response size, provider behavior, or documented rate/credit
  guidance requires a smaller page;
- request only fields needed by the selected import unit;
- serve safe fresh or stale cached option pages instead of repeating live option
  queries during operator navigation;
- treat one-call-per-card, one-call-per-variant, and
  one-call-per-sealed-product as forbidden normal import behavior;
- allow per-record calls only when no bulk/list/search endpoint can supply the
  required field or relationship, and only when the fallback is documented,
  tested, preflighted with call impact, and visible to the operator before
  execution.

Configure Scrydex once per environment through `SCRYDEX_API_KEY` and
`SCRYDEX_TEAM_ID`. Do not add Lorcana-specific or game-specific Scrydex secret
names. UAT and launch evidence may show redacted credential readiness, team
readiness, cache state, usage-check state, estimated request count, actual
request count, page count, cache hit/miss count, and credit/degraded
diagnostics.

## Governed Data Classes

Lorcana production sync follows the base provider-data policy in
[Catalog Integration Data Governance](./catalog-integration-data-governance.md).

| Data class | Default for Lorcana providers | Activation requirement |
| --- | --- | --- |
| Raw provider payload body | Request only; do not store, log, show, export, or hash as retained evidence | Policy/legal approval plus retained-data exception before any retained raw body exists |
| Sampled provider payload | Not retained by default | Policy/legal approval, owner, retention window, deletion/rotation plan, and removal criteria |
| Fixture payload body | Redacted or synthetic by default | Real provider body fixtures require policy/legal approval and retained-data exception |
| Dry-run input body | Request only | Retained bodies require policy/legal approval and retained-data exception |
| Dry-run output evidence | Retained redacted summary only | May include normalized facts, counts, provider key, unit key, source hash, diagnostics, and bounded evidence ids |
| Provider usage summary | Retained redacted summary only | May include estimated request count, actual request count, page count, cache hit/miss count, usage-check state, and credit/degraded diagnostics |
| Provider image evidence | URI/status evidence only by default | Retained provider imagery in evidence requires policy/legal approval; promoted Catalog assets must be Catalog-owned |
| Export package | Redacted summary only by default | Reviewed evidence package approval required before provider-controlled content is exported |
| Source hash material | Allowed normalized Catalog facts and stable provider ids only | Must exclude raw bodies, secrets, seller/account facts, prices, inventory, listings, orders, messages, and session material |

## Image Evidence And Rehosting

LorcanaJSON, Lorcast, Scrydex, and TCGplayer may provide image URI evidence
only when the provider-data signoff permits that evidence class. Official
Disney Lorcana/Ravensburger images are validation labels only; they must not be
linked, cached, transformed, rehosted, retained in fixtures, or shown in
operator evidence unless a separate legal/source approval changes that source
role.

Approved provider image evidence may be shown in shared Catalog importer/review
surfaces as normalized image URI evidence. Promotion must not publish provider
image URLs as product-facing imagery. When an approved image is used for
Catalog Item imagery, Catalog downloads it into owned asset storage, stores the
source plus WebP display variants as a Product Asset Set, and publishes only
Chase Sets asset URLs as compatibility `imageUrls`.

Product Asset Set metadata follows `catalog-product-image-retention-v1`: retain
staging/production assets while referenced, expire preview assets after 90 days,
store only source provider key, source URL host/hash, source content type,
rehosting behavior, and removal metadata, and avoid storing the full provider
image URL in retained asset metadata. Takedown or source-revocation requests use
the Catalog asset takedown path in
[Catalog Asset Storage](../../../docs/runbooks/catalog-asset-storage.md).

## Conflict And Duplicate Policy

Lorcana card identity requires set/chapter identity, collector number, printed
name, version, language, and material variant facts such as foil or special
treatment when present. Sealed-product identity requires set/release family,
product name, language, and sealed-product form so booster packs, sleeved
boosters, displays, cases, starter decks, troves, gift sets, prerelease boxes,
and collections do not collapse into one Catalog Item.

Promotion reuses an existing Catalog Item when exactly one safe candidate is
found by external Catalog Item reference, provider source link, or deterministic
Lorcana identity. Marketplace-only TCGplayer products remain review evidence
until a deterministic Catalog Item bridge exists. Conflicts between
LorcanaJSON, Lorcast, Scrydex, TCGplayer, official validation, or an approved
fallback source are reviewable diagnostics that name provider/source, field
class, decision path, and redacted evidence summaries.

## Activation Signoff Checklist

Production activation for any Lorcana provider is blocked until all applicable
items below are complete:

- [ ] Provider-data policy/legal approval is recorded for LorcanaJSON, Lorcast,
  Scrydex Lorcana, TCGplayer Lorcana, official validation use, and any approved
  fallback source.
- [ ] Retained-data exceptions exist for every retained real-provider sample,
  fixture body, dry-run body, provider imagery evidence view, usage export, or
  export package.
- [ ] Active profile versions exist for selected Lorcana ingestion units and
  every active profile has executable mapping-contract and fixture coverage.
- [ ] Scrydex Lorcana card, set, sealed-product, and approved price/freshness
  import units have shared-credential and bulk-first call-budget tests.
- [ ] Provider option queries have cache, stale-state, pagination, retry,
  provider-unavailable, credit estimate, and backpressure behavior visible to
  operators.
- [ ] Rollout controls can independently block provider transport, option
  queries, import, promotion, reapply, activation, worker processing, and broad
  read/write access for every Lorcana unit, including unit-scoped stops that do
  not disable the same provider for other product lines.
- [ ] Conflict policy explains LorcanaJSON, Lorcast, Scrydex, TCGplayer,
  official validation, and fallback source authority, losing evidence retention,
  duplicate-prevention order, and manual-review blockers.
- [ ] Asset policy evidence proves approved provider images are rehosted into
  Catalog-owned Product Asset Sets when promoted, provider image URLs do not
  leak into promoted compatibility image URLs, missing/stale images stay
  reviewable, and redacted fixtures exclude unapproved imagery, prices,
  inventory, seller/account facts, and raw provider bodies.
- [ ] #2481 staging UAT passes from the Chase Sets interface without direct
  URLs, APIs, CLI, SQL, Postman, browser console commands, provider endpoints,
  or hidden Admin/API routes, and proves Lorcana, Pokemon, MTG, and One Piece
  source scopes can sync through the same shared importer.
- [ ] #2486 downstream smoke proves one promoted/reapplied Lorcana item or set
  projects into a representative downstream read model or UI.
- [ ] `CATALOG_INTEGRATION_LORCANA_PRODUCTION_SIGNOFF_REFERENCE` names the
  accepted provider-data approval, #2481 UAT evidence, and #2486 smoke evidence
  before production-like Lorcana imports, promotions, reapply, or activation are
  opened.

## Work Allowed Before Signoff

These workstreams may proceed behind disabled or dry-run-only controls before
production activation:

- ingestion-unit identity and provider profile shape;
- LorcanaJSON, Lorcast, Scrydex, and TCGplayer Lorcana adapters and mapping
  contracts;
- synthetic or approved-redacted fixtures;
- dry-run normalization, diagnostics, conflict previews, duplicate previews,
  and Scrydex call-budget proofs;
- option-query UI and API behavior when live transport is disabled or
  cache-only;
- promotion planning and read-model work that cannot write production Catalog
  truth until rollout controls permit it;
- operator UI surfaces for readiness, usage estimates, dry run, import
  planning, job progress, diagnostics, and evidence.

These actions remain blocked until signoff:

- production activation of live retained provider sampling;
- retained real-provider payload bodies or provider imagery evidence views;
- promotion into production Catalog truth;
- provider-data export packages containing provider-controlled content;
- any Lorcana-specific importer area or route.

## Required UAT Evidence

The staging UAT must demonstrate one Lorcana set/source scope synced from each
active Lorcana provider profile through normal operator navigation in the Chase
Sets interface. It must also demonstrate one Pokemon set, one MTG set, and one
One Piece set synced through the same source-scope importer so the Lorcana
rollout cannot regress existing operator workflows.

Evidence must include:

- selected Lorcana, Pokemon, MTG, and One Piece source scopes;
- provider readiness state, fixture coverage, dry-run readiness, and profile
  versions;
- Scrydex shared credential, team, credit/rate, cache, and usage readiness
  state;
- option-query cache/freshness state;
- preflight estimated Scrydex calls/credit impact or an
  `estimate-unavailable` diagnostic with a reason;
- import job ids, profile versions, ingestion units, source hashes or approved
  hash omissions, and actual Scrydex request/page/cache/usage evidence;
- proof that normal LorcanaJSON and Scrydex paths used bulk/list/search or
  set-file ingestion and did not make one provider call per card, variant, or
  sealed product;
- Source Observation counts, promotion preview counts, promotion outcomes,
  conflicts/duplicates, and read-model visibility;
- TCGplayer external reference and SKU attachment results without forbidden
  commerce facts;
- downstream smoke identifiers for the promoted/reapplied Lorcana item or set;
- screenshots or operator-visible artifacts for emergency stop,
  imports-disabled, promotion-disabled, reapply-disabled, dry-run-only, and
  cache-only option-query controls;
- proof that Lorcana, Pokemon, MTG, and One Piece are selected from the shared
  source-scope interface without a product-line-specific sync area.

## Related Issues

- #2464 Complete provider-data governance and source-authority signoff
- #2466 Define provider roles, precedence, and product-line identity
- #2472 Promote Scrydex Lorcana supplement sync with shared credentials and
  credit-aware ingestion
- #2473 Add official Disney Lorcana/Ravensburger canonical validation checks
- #2474 Add Lorcana asset ingestion, image policy, and retention controls
- #2475 Implement Lorcana conflict policy, duplicate prevention, and source
  merge rules
- #2481 Staging UAT: sync Lorcana provider scopes through the shared importer
  and verify regressions
- #2486 Smoke one promoted Lorcana item through downstream catalog projection
