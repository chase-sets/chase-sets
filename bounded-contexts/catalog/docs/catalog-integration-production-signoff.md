# Catalog Integration Production Signoff

This document is the production activation start gate for catalog provider
integrations, organized per product domain. Each product-domain section states
its own production authority, the governed data classes that apply to its
providers, the policy/legal approval gate that blocks activation, and the
milestone/UAT references that prove the rollout works through the shared Chase
Sets importer.

The active provider profile/unit registry
(`catalogProviderIntegrationProfileVersions` in
`bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts`)
is the executable source of truth for which product domains and provider units
can participate in the complete production Catalog synchronization. Every active
production-capable unit in that registry must be covered by exactly one
product-domain section below. The
`scripts/check-structure/catalog-integration-production-signoff-coverage.ts` reconciles the registry
against this document and the provider-sync runbook, so a future
production-capable domain or provider unit that lacks signoff coverage fails
visibly instead of relying on a hardcoded issue table. Validation-only,
comparison-only, test, gated, deprecated, and retired units classify out of
required coverage and cannot enter the production launch manifest.

Production activation is not approved for any game until that game's signoff is
complete and its staging UAT passes from the Chase Sets interface. Operators
must not use handcrafted URLs, direct API calls, CLI commands, SQL, Postman,
browser console commands, manual provider endpoint access, or hidden Admin/API
routes for the UAT.

## Product-domain signoffs

| Product domain | Production providers | Section |
| --- | --- | --- |
| Magic | MTGJSON, Scryfall, TCGplayer | [Magic](#magic) |
| Pokemon | TCGdex, TCGplayer | [Pokemon](#pokemon) |
| Yu-Gi-Oh! | YGOPRODeck, YGOJSON, TCGplayer | [Yu-Gi-Oh!](#yu-gi-oh) |
| One Piece | Scrydex, TCGplayer, Bandai (validation-only) | [One Piece](#one-piece) |
| Lorcana | LorcanaJSON, Lorcast, Scrydex, TCGplayer | [Lorcana](#lorcana) |

## Shared signoff contract

Every product-domain signoff below asserts the same template. Read this section
once; the per-domain sections then bind it to that domain's providers and issue
numbers.

A signoff asserts:

- **Provider authority table.** Each game declares a provider-authority table
  with one row per provider and these columns: `Provider`, `Production role`,
  `Catalog authority` (the facts that provider is allowed to feed into Catalog
  truth), and `Explicitly not Catalog truth` (the facts that provider may never
  contribute, e.g. prices, market prices, latest sales, seller/account facts,
  inventory, listings, orders, messages, cookies, session material, raw provider
  bodies, secrets, and unapproved imagery). Provider adapters collect observed
  facts and sanitized transport diagnostics; they do not write Catalog Items,
  Products, Reference Records, External Catalog Item References, or External
  Product References directly. Catalog Source Observations, promotion, conflict
  policy, duplicate prevention, and operator review own the transition into
  Catalog truth.
- **Governed data classes.** Each game's production sync follows the base
  provider-data policy in
  [Catalog Integration Data Governance](./catalog-integration-data-governance.md).
  The governed-data-class table sets the default handling and activation
  requirement for each class: raw provider payload body, sampled provider
  payload, fixture payload body, dry-run input body, dry-run output evidence,
  provider image evidence, export package, and source hash material (plus a
  provider usage summary row for games with paid/metered providers). Raw bodies
  are request-only and require policy/legal approval plus a retained-data
  exception before any retained body exists; source hash material is limited to
  normalized Catalog facts and stable provider ids only.
- **Policy/legal approval gate.** Production activation is blocked until
  provider-data policy/legal approval is recorded for every named provider,
  retained-data exceptions exist for every retained sample/fixture/dry-run
  body/imagery view/export, rollout controls can independently stop each
  provider and unit, conflict policy explains field authority and
  duplicate-prevention order, and a per-game
  `CATALOG_INTEGRATION_<GAME>_PRODUCTION_SIGNOFF_REFERENCE` names the accepted
  approval and UAT evidence before any production-like import, promotion,
  reapply, or activation is opened.
- **UAT / rollout reference.** Each game references a required staging UAT that
  must demonstrate the game's source scope syncing from each active provider
  through normal operator navigation, plus the previously shipped product lines
  syncing through the same shared source-scope importer so the new rollout
  cannot regress existing operator workflows, all without a
  product-line-specific sync area. Work allowed before signoff (adapters,
  synthetic/redacted fixtures, dry-run normalization, cache-only option queries,
  promotion planning that cannot write production truth, operator readiness UI)
  proceeds behind disabled or dry-run-only controls; live retained sampling,
  retained real-provider bodies/imagery views, promotion into production Catalog
  truth, and provider-controlled export packages remain blocked until signoff.

## Magic

Production activation start gate for Magic: The Gathering Catalog sync from
MTGJSON, Scryfall, and TCGplayer.

Tracking:

- Milestone: #42 Magic: The Gathering catalog provider production sync
- Parent tracker: #2024
- Start gate: #2025
- Required staging UAT: #2039

### Provider authority

| Provider | Production role | Catalog authority | Explicitly not Catalog truth |
| --- | --- | --- | --- |
| Scryfall | Primary Magic card-print and image-evidence source | Card-print identifiers, Oracle/Card ids, set code and name evidence, collector number, language, rarity, finishes, layout, image status, image URI evidence, TCGplayer cross-reference evidence | Prices, legalities, rulings, user/account data, provider availability signals beyond diagnostics |
| MTGJSON | Magic set/reference-data and cross-check source | Set code, set name, release date, set metadata, card UUIDs, identifiers, collector number, language/print metadata, cross-provider disagreement evidence | Prices, legalities, rulings, deck/format analysis, non-Catalog gameplay facts unless a later owner contract accepts them |
| TCGplayer | Magic marketplace product, SKU, sealed-product, and external-reference identity source | Product ids, SKU ids, product-line/category evidence, set-name matching evidence, product names as matching evidence, barcode/sealed-form evidence, External Catalog Item Reference and External Product Reference candidates | Prices, market prices, latest sales, seller facts, account facts, inventory, listings, quantities, orders, messages, session/cookie material |

TCGplayer Product ids map to External Catalog Item Reference candidates.
TCGplayer SKU ids map to External Product Reference candidates only after the
selected Options validate against the active Catalog Product schema. Scryfall
prices, legalities, rulings, raw response bodies, full provider URLs in logs,
and non-Catalog gameplay facts stay out of Catalog truth unless a later
bounded-context issue changes ownership; the same exclusion applies to MTGJSON
prices, legalities, rulings, raw set files, and raw bulk files.

### Governed data classes

Magic production sync follows the base provider-data policy in
[Catalog Integration Data Governance](./catalog-integration-data-governance.md).

| Data class | Default for Magic providers | Activation requirement |
| --- | --- | --- |
| Raw provider payload body | Request only; do not store, log, show, export, or hash as retained evidence | Policy/legal approval plus retained-data exception before any retained raw body exists |
| Sampled provider payload | Not retained by default | Policy/legal approval, owner, retention window, deletion/rotation plan, and removal criteria |
| Fixture payload body | Redacted or synthetic by default | Real provider body fixtures require policy/legal approval and retained-data exception |
| Dry-run input body | Request only | Retained bodies require policy/legal approval and retained-data exception |
| Dry-run output evidence | Retained redacted summary only | May include normalized facts, counts, provider key, unit key, source hash, diagnostics, and bounded evidence ids |
| Provider image evidence | URI/status evidence only by default | Retained provider imagery in evidence requires policy/legal approval; promoted Catalog assets must be Catalog-owned |
| Export package | Redacted summary only by default | Reviewed evidence package approval required before provider-controlled content is exported |
| Source hash material | Allowed normalized Catalog facts and stable provider ids only | Must exclude raw bodies, secrets, seller/account facts, prices, inventory, listings, orders, messages, and session/cookie material |

### Policy/legal approval status

Production activation for any Magic provider is blocked until provider-data
policy/legal approval is recorded for MTGJSON, Scryfall, and TCGplayer Magic;
retained-data exceptions exist for every retained sample, fixture body, dry-run
body, provider imagery evidence view, or export package; TCGplayer Magic
credential/session storage, rotation, redaction, and operator-safe readiness
surfacing are approved; rollout controls can independently block provider
transport, option queries, import, promotion, reapply, activation, worker
processing, and broad read/write access for MTGJSON, Scryfall, and TCGplayer;
conflict policy explains Scryfall, MTGJSON, and TCGplayer field authority,
losing evidence retention, duplicate-prevention order, and manual-review
blockers; and `CATALOG_INTEGRATION_MAGIC_PRODUCTION_SIGNOFF_REFERENCE` names the
accepted provider-data approval and #2039 UAT evidence before production-like
MTGJSON, Scryfall, or TCGplayer Magic imports, promotions, reapply, or
activation are opened.

### Milestone / UAT

The #2039 staging UAT was accepted after PR #2108 / merge
`07d7f99cb604da2dd682e0e38b05b8f5e796d7f1` with interface-only proof that one
Magic set synced from MTGJSON, Scryfall, and TCGplayer through normal operator
navigation, and one Pokemon set synced through the same source-scope importer so
the Magic rollout cannot regress the existing Pokemon operator workflow.
Validation-only Scrydex/Scryfall-style Magic proof paths are retired from this
UAT and remain only as explicit test-scoped contract evidence.

Related issues:

- #2025 Complete provider-data governance and production activation signoff
- #2029 Promote Scryfall to production card-print and image-evidence sync
- #2030 Promote MTGJSON to production set and card reference sync
- #2031 Add TCGplayer Magic single-card product and SKU sync profile
- #2032 Add TCGplayer Magic sealed-product sync profile
- #2039 Staging UAT: sync one Magic set from all three providers and one Pokemon
  set through the shared interface

## Pokemon

Production activation start gate for Pokemon Trading Card Game Catalog sync from
TCGdex and the existing Chase Sets TCGplayer provider path. Pokemon is the
foundational Catalog product line established by the initial Catalog integration
milestones and used as the shared-importer regression baseline for every later
product-domain rollout, so its production authority is stated here explicitly
rather than inferred from that history.

Tracking:

- Foundational Catalog integration milestones: #2 config/data-driven migration
  and #4 admin management
- Regression-baseline UAT evidence: #2039 (Magic UAT synced one Pokemon set),
  #2285 (One Piece UAT Pokemon regression), and milestone #50
  `all-provider-regression` run `28279080021` (Pokemon TCGdex regression)

### Provider authority

| Provider | Production role | Catalog authority | Explicitly not Catalog truth |
| --- | --- | --- | --- |
| TCGdex | Primary free Pokemon card-print and image-evidence source for series, expansions, cards, languages, and image URI evidence where approved | Series/expansion identifiers, card-print identifiers, collector/local numbers, printed names, language facts, rarity, variant facts, image URI evidence when approved, and freshness diagnostics | Prices, market prices, seller or account facts, raw provider bodies, and unapproved provider imagery copies |
| TCGplayer | Pokemon marketplace product, SKU, group/set, sealed-product, and external-reference identity source through the existing Chase Sets automation path | Product id external-reference candidates, SKU external-product-reference candidates after selected Options validate, group/set-name matching evidence, condition/language/printing/sealed-form evidence, marketplace product image URI evidence when approved | Prices as Catalog identity, market prices as Catalog truth, latest sales, seller/account facts, inventory, listings, orders, messages, cookies, and session material |

TCGplayer Product ids map to External Catalog Item Reference candidates;
TCGplayer SKU ids map to External Product Reference candidates only after the
selected Options validate against the active Catalog Product schema. TCGdex and
TCGplayer are the only Pokemon sources approved for retained image URI evidence
in the production sync path. Official Pokemon (pokemon.com) pages remain a
validation-only reference cited as redacted validation labels only, never raw
official text, imagery copies, or scraped payload bodies.

### Governed data classes

Pokemon production sync follows the base provider-data policy in
[Catalog Integration Data Governance](./catalog-integration-data-governance.md).

| Data class | Default for Pokemon providers | Activation requirement |
| --- | --- | --- |
| Raw provider payload body | Request only; do not store, log, show, export, or hash as retained evidence | Policy/legal approval plus retained-data exception before any retained raw body exists |
| Sampled provider payload | Not retained by default | Policy/legal approval, owner, retention window, deletion/rotation plan, and removal criteria |
| Fixture payload body | Redacted or synthetic by default | Real provider body fixtures require policy/legal approval and retained-data exception |
| Dry-run input body | Request only | Retained bodies require policy/legal approval and retained-data exception |
| Dry-run output evidence | Retained redacted summary only | May include normalized facts, counts, provider key, unit key, source hash, diagnostics, and bounded evidence ids |
| Provider image evidence | URI/status evidence only by default | Retained provider imagery in evidence requires policy/legal approval; promoted Catalog assets must be Catalog-owned |
| Export package | Redacted summary only by default | Reviewed evidence package approval required before provider-controlled content is exported |
| Source hash material | Allowed normalized Catalog facts and stable provider ids only | Must exclude raw bodies, secrets, seller/account facts, prices, inventory, listings, orders, messages, and session/cookie material |

### Policy/legal approval status

Production activation for any Pokemon provider is blocked until provider-data
policy/legal approval is recorded for TCGdex and TCGplayer Pokemon;
retained-data exceptions exist for every retained sample, fixture body, dry-run
body, provider imagery evidence view, or export package; TCGplayer Pokemon
credential/session storage, rotation, redaction, and operator-safe readiness
surfacing are approved; rollout controls can independently block provider
transport, option queries, import, promotion, reapply, activation, worker
processing, and broad read/write access for TCGdex and TCGplayer, including
unit-scoped stops that block Pokemon TCGplayer units without blocking Magic,
Yu-Gi-Oh!, One Piece, or Lorcana TCGplayer units; conflict policy explains
TCGdex and TCGplayer field authority, losing evidence retention,
duplicate-prevention order, and manual-review blockers; asset policy evidence
proves approved TCGdex/TCGplayer images are rehosted into Catalog-owned Product
Asset Sets without leaking provider image URLs; and
`CATALOG_INTEGRATION_POKEMON_PRODUCTION_SIGNOFF_REFERENCE` names the accepted
provider-data approval and regression-baseline UAT evidence before
production-like TCGdex or TCGplayer Pokemon imports, promotions, reapply, or
activation are opened.

Approved TCGdex or TCGplayer image evidence is shown as normalized image URI
evidence only; promotion downloads approved images into Catalog-owned Product
Asset Sets following `catalog-product-image-retention-v1` and publishes only
Chase Sets asset URLs as compatibility `imageUrls`. Takedown or
source-revocation requests use the Catalog asset takedown path in
[Catalog Asset Storage](../../../docs/runbooks/catalog-asset-storage.md).

### Milestone / UAT

Pokemon carries no dedicated production milestone because it is the pre-existing
importer baseline. Its production proof is the recurring cross-domain regression
requirement: every later product-domain UAT must sync one Pokemon set through
the same shared source-scope importer and reach downstream Catalog Items
projection without a Pokemon-specific sync area. The accepted evidence includes
the #2039 Magic UAT Pokemon set, the #2285 One Piece UAT Pokemon regression, and
the milestone #50 `all-provider-regression` run `28279080021`, all through
normal operator navigation without direct provider URLs, direct APIs, SQL,
browser console commands, hidden routes, raw provider payloads, provider
imagery, or secrets. Future revalidation must use the same normal operator
navigation and the same shared importer controls.

## Yu-Gi-Oh!

Production activation start gate for Yu-Gi-Oh! Trading Card Game Catalog sync
from YGOPRODeck, YGOJSON, and the existing Chase Sets TCGplayer provider path.

Tracking:

- Milestone: #44 Yu-Gi-Oh! catalog provider production sync
- Parent tracker: #2111
- Source authority: #2112 and #2113
- Asset policy: #2119
- Rollout controls / observability / runbook: #2125
- Required staging UAT: #2126
- Validation-only retirement and doc finalization: #2127

### Provider authority

| Provider | Production role | Catalog authority | Explicitly not Catalog truth |
| --- | --- | --- | --- |
| YGOPRODeck | Preferred free card-level baseline source for cards, printings, sets, image URI evidence, archetypes, and banlist/format reference facts where approved | Card-print identifiers, set/printing identifiers, printed names, collector/set codes, language facts, rarity, archetype and banlist/format reference facts, image URI evidence when approved, and freshness diagnostics | Prices, low-confidence vendor price hints as Catalog truth, seller or account facts, raw provider bodies, and unapproved provider imagery copies |
| YGOJSON | Free structured Yu-Gi-Oh! set, product, sealed-product, and pack-metadata reference source, and normalization cross-check | Set/product identifiers, sealed-product identifiers and packaging labels, pack-content and pack structure reference facts, cross-provider disagreement evidence, and bulk metadata/freshness evidence | Prices, gameplay analysis beyond reference facts, seller/account facts, raw provider bodies, and unapproved imagery copies |
| TCGplayer | Yu-Gi-Oh! marketplace product, SKU, group/set, and price-reference identity source through the existing Chase Sets automation path | Product id external-reference candidates, SKU external-product-reference candidates after selected Options validate, group/set-name matching evidence, condition/language/printing/edition evidence, marketplace product image URI evidence when approved | Prices as Catalog identity, market prices as Catalog truth, latest sales, seller/account facts, inventory, listings, orders, messages, cookies, and session material |

TCGplayer Product ids map to External Catalog Item Reference candidates;
TCGplayer SKU ids map to External Product Reference candidates only after the
selected Options validate against the active Catalog Product schema. YGOPRODeck
and TCGplayer are the sources approved for retained image URI evidence in the
production sync path. Official Konami Yu-Gi-Oh! database pages remain a
validation-only reference cited as redacted validation labels and
source-disagreement diagnostics only, never raw official text, imagery copies,
or scraped payload bodies.

### Governed data classes

Yu-Gi-Oh! production sync follows the base provider-data policy in
[Catalog Integration Data Governance](./catalog-integration-data-governance.md).

| Data class | Default for Yu-Gi-Oh! providers | Activation requirement |
| --- | --- | --- |
| Raw provider payload body | Request only; do not store, log, show, export, or hash as retained evidence | Policy/legal approval plus retained-data exception before any retained raw body exists |
| Sampled provider payload | Not retained by default | Policy/legal approval, owner, retention window, deletion/rotation plan, and removal criteria |
| Fixture payload body | Redacted or synthetic by default | Real provider body fixtures require policy/legal approval and retained-data exception |
| Dry-run input body | Request only | Retained bodies require policy/legal approval and retained-data exception |
| Dry-run output evidence | Retained redacted summary only | May include normalized facts, counts, provider key, unit key, source hash, diagnostics, and bounded evidence ids |
| Provider image evidence | URI/status evidence only by default | Retained provider imagery in evidence requires policy/legal approval; promoted Catalog assets must be Catalog-owned |
| Export package | Redacted summary only by default | Reviewed evidence package approval required before provider-controlled content is exported |
| Source hash material | Allowed normalized Catalog facts and stable provider ids only | Must exclude raw bodies, secrets, seller/account facts, prices, inventory, listings, orders, messages, and session/cookie material |

### Policy/legal approval status

Production activation for any Yu-Gi-Oh! provider is blocked until provider-data
policy/legal approval is recorded for YGOPRODeck, YGOJSON, and TCGplayer
Yu-Gi-Oh!; retained-data exceptions exist for every retained sample, fixture
body, dry-run body, provider imagery evidence view, or export package; TCGplayer
Yu-Gi-Oh! credential/session storage, rotation, redaction, and operator-safe
readiness surfacing are approved; rollout controls can independently block
provider transport, option queries, import, promotion, reapply, activation,
worker processing, and broad read/write access for YGOPRODeck, YGOJSON, and
TCGplayer, including unit-scoped stops that block Yu-Gi-Oh! TCGplayer units
without blocking Magic, Pokemon, One Piece, or Lorcana TCGplayer units; conflict
policy explains YGOPRODeck, YGOJSON, and TCGplayer field authority, losing
evidence retention, duplicate-prevention order, and manual-review blockers;
asset policy evidence proves approved YGOPRODeck/TCGplayer images are rehosted
into Catalog-owned Product Asset Sets without leaking provider image URLs; and
`CATALOG_INTEGRATION_YUGIOH_PRODUCTION_SIGNOFF_REFERENCE` names the accepted
provider-data approval and #2126 UAT evidence before production-like YGOPRODeck,
YGOJSON, or TCGplayer Yu-Gi-Oh! imports, promotions, reapply, or activation are
opened.

Approved YGOPRODeck or TCGplayer image evidence is shown as normalized image URI
evidence only; promotion downloads approved images into Catalog-owned Product
Asset Sets following `catalog-product-image-retention-v1` and publishes only
Chase Sets asset URLs as compatibility `imageUrls`. Takedown or
source-revocation requests use the Catalog asset takedown path in
[Catalog Asset Storage](../../../docs/runbooks/catalog-asset-storage.md).

### Milestone / UAT

The #2126 staging UAT must demonstrate one Yu-Gi-Oh! source scope synced from
YGOPRODeck, YGOJSON, and the existing TCGplayer provider path through normal
operator navigation, and one Pokemon set, one MTG set, and one One Piece set
synced through the same source-scope importer so the Yu-Gi-Oh! rollout cannot
regress existing operator workflows, all without a product-line-specific sync
area. The public YGOPRODeck and YGOJSON paths must use bulk/list/search or
set-file ingestion instead of one provider call per card, printing, or sealed
product. Milestone #44 issues #2116, #2117, and #2118 completed the YGOPRODeck,
YGOJSON, and TCGplayer promotion units; #2127 retired the validation-only
Yu-Gi-Oh! paths after proof.

Related issues:

- #2112 Complete provider-data governance and source-authority signoff
- #2113 Define provider roles, product-line identity, and existing TCGplayer
  scope
- #2116 Promote YGOPRODeck to production card, set, archetype, banlist, and
  image-evidence sync
- #2117 Promote YGOJSON and YAML Yugi to production structured product metadata
  sync
- #2118 Extend existing TCGplayer provider for Yu-Gi-Oh! marketplace product,
  SKU, and price-reference sync
- #2119 Add Yu-Gi-Oh! asset ingestion, image rehosting, and retention policy
- #2126 Staging UAT: sync Yu-Gi-Oh! provider scope through the shared importer
- #2127 Retire validation-only Yu-Gi-Oh! paths and finalize production docs

## One Piece

Production activation start gate for One Piece Catalog sync from Scrydex and the
existing Chase Sets TCGplayer provider path.

Tracking:

- Milestone: #46 One Piece catalog provider production sync
- Parent tracker: #2268
- Start gate: #2269, #2270, and #2287
- Required staging UAT: #2285

### Provider authority

| Provider | Production role | Catalog authority | Explicitly not Catalog truth |
| --- | --- | --- | --- |
| Scrydex | Preferred paid One Piece seed provider for cards, variants, expansions, sealed products, approved price-history evidence, and webhook freshness where source authority approves the data class | Card and variant identifiers, expansion/set identifiers, sealed product identifiers and packaging labels, image URI evidence when approved, freshness and usage diagnostics | Seller facts, inventory quantities, listings, orders, raw provider bodies, API keys, team ids, and price history except as approved evidence outside Catalog truth |
| TCGplayer | One Piece marketplace product, SKU, group/set, and price-reference evidence through the existing provider path | Product id external-reference candidates, SKU external-product-reference candidates after selected Options validate, group/set-name matching evidence, condition/language/printing/sealed-form evidence | Prices as Catalog identity, market prices as Catalog truth, latest sales, seller/account facts, inventory, listings, orders, messages, cookies, and session material |
| Bandai official One Piece Card Game | Canonical validation reference only unless legal/source-authority approval explicitly permits ingestion | Manual validation reference, source-disagreement evidence, and operator checklist evidence that provider records align with official release information | Raw official page text, official imagery copies, scraped payload bodies, and automated ingestion facts without explicit approval |
| Fallback/community/free sources | Comparison-only or fallback evidence after governance approval | Source-disagreement diagnostics, coverage-gap analysis, and fallback identifiers only when a separate approval names the source and data class | Default production authority, raw community payloads, unapproved images, and unreviewed price or gameplay facts |

Representative validation checks must cover at least one card, one expansion,
and one sealed product before production signoff. Bandai official references may
be used only as redacted validation labels and source-disagreement diagnostics.
Fallback/community sources may be used only after named source approval and
remain comparison-only. Each disagreement diagnostic must name the provider key,
ingestion unit, comparison source key, redacted external id, and field class; it
must not retain raw official/community payload text, official imagery copies,
provider imagery, or scraped payload bodies.

### Scrydex credit policy

Scrydex API requests consume paid credits. Scrydex One Piece imports must be
bulk-first and credit-aware:

- use bulk/list/search pagination for cards, variants, expansions, sealed
  products, and approved price/freshness evidence whenever possible;
- use the highest safe Scrydex-supported page size for the selected import unit
  unless measured response size, provider behavior, or documented rate/credit
  guidance requires a smaller page;
- request only fields needed by the selected import unit;
- serve safe fresh or stale cached option pages instead of repeating live option
  queries during operator navigation;
- treat one-call-per-card, one-call-per-variant, and one-call-per-sealed-product
  as forbidden normal import behavior;
- allow per-record calls only when no bulk/list/search endpoint can supply the
  required field or relationship, and only when the fallback is documented,
  tested, preflighted with call impact, and visible to the operator before
  execution.

Scrydex One Piece price-history sync is not active for this milestone. The
current provider shape exposes price history as per-card evidence, and One
Piece source authority excludes unapproved price-history bodies from Catalog
truth. The adapter may surface a redacted source-authority-gated diagnostic, but
no price-history ingestion unit may run until a later approval names the data
class and adds the most efficient supported query shape, call-budget proof, and
operator-visible fallback policy.

Scrydex and TCGplayer are the only One Piece sources approved for retained image
URI evidence in the production sync path. Bandai official and fallback/community
sources may be cited as redacted validation labels only.

### Governed data classes

One Piece production sync follows the base provider-data policy in
[Catalog Integration Data Governance](./catalog-integration-data-governance.md).

| Data class | Default for One Piece providers | Activation requirement |
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

### Policy/legal approval status

Production activation for any One Piece provider is blocked until provider-data
policy/legal approval is recorded for Scrydex One Piece, TCGplayer One Piece,
Bandai validation use, and any approved fallback source; retained-data
exceptions exist for every retained sample, fixture body, dry-run body, provider
imagery evidence view, usage export, or export package; Scrydex credential,
team, subscription, credit, rate-limit, redaction, and operator-safe readiness
surfacing are approved; Scrydex card, expansion, sealed-product, and approved
price/freshness import units have bulk-first call-budget tests; rollout controls
can independently block provider transport, option queries, import, promotion,
reapply, activation, worker processing, and broad read/write access for Scrydex
and TCGplayer, including unit-scoped stops that block Scrydex One Piece or
TCGplayer One Piece without blocking TCGplayer Pokemon or Magic units; conflict
policy explains Scrydex, TCGplayer, Bandai validation, and fallback source
authority, losing evidence retention, duplicate-prevention order, and
manual-review blockers; asset policy evidence proves approved Scrydex/TCGplayer
images are rehosted into Catalog-owned Product Asset Sets without leaking
provider image URLs; and
`CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE` names the accepted
provider-data approval and #2285 UAT evidence before production-like One Piece
imports, promotions, reapply, or activation are opened.

Approved Scrydex or TCGplayer image evidence is shown as normalized image URI
evidence only; promotion downloads approved images into Catalog-owned Product
Asset Sets following `catalog-product-image-retention-v1` and publishes only
Chase Sets asset URLs as compatibility `imageUrls`. Takedown or
source-revocation requests use the Catalog asset takedown path in
[Catalog Asset Storage](../../../docs/runbooks/catalog-asset-storage.md), with
removal targeted within 30 days of approval.

### Milestone / UAT

The #2285 staging UAT must demonstrate one One Piece source scope synced from
Scrydex and the existing TCGplayer provider path through normal operator
navigation, and one Pokemon set and one MTG set synced through the same
source-scope importer so the One Piece rollout cannot regress existing operator
workflows. Evidence must prove the normal Scrydex import path used bulk/search
pagination and did not make one provider call per card, variant, or sealed
product.

Related issues:

- #2269 Complete provider-data governance and source-authority signoff
- #2270 Define provider roles, product-line identity, and Scrydex credential
  posture
- #2273 Promote Scrydex One Piece cards, variants, expansions, and
  price-history sync
- #2274 Promote Scrydex One Piece sealed-product sync
- #2276 Extend existing TCGplayer provider for One Piece marketplace product,
  SKU, and price-reference sync
- #2285 Staging UAT: sync One Piece provider scope through the shared importer
  and verify Pokemon/MTG regression
- #2287 Enforce Scrydex bulk-first, credit-aware import behavior

## Lorcana

Production activation start gate for Disney Lorcana Catalog sync from
LorcanaJSON, Lorcast, Scrydex, and the existing Chase Sets TCGplayer provider
path.

Tracking:

- Milestone: #50 Disney Lorcana catalog provider production sync
- Parent tracker: #2463
- Source authority: #2464 and #2466
- Required staging UAT: #2481
- Downstream projection smoke: #2486

### Provider authority

| Provider | Production role | Catalog authority | Explicitly not Catalog truth |
| --- | --- | --- | --- |
| LorcanaJSON | Preferred free bulk-first reference source for sets, cards, languages, variants, image URI evidence, metadata, and official deck files where approved | Set/chapter identifiers, card print identifiers, collector numbers, printed names and versions, rarity, ink, classifications, properties, language facts, image URI evidence when approved, bulk metadata, generated-on, checksum, and freshness evidence | Marketplace product ids as canonical Catalog identity, prices, seller or account facts, raw provider bodies, and unapproved provider imagery copies |
| Lorcast | Free supplemental source for set/card option queries, image URIs, TCGplayer ids, legalities, and lightweight price evidence where approved | Set-scoped card lookup evidence, supplemental image URI evidence, TCGplayer id bridge candidates, legality diagnostics, lightweight price diagnostics when approved, cache and pacing diagnostics | Canonical winner when LorcanaJSON or official validation disagrees, prices as Catalog identity, raw provider bodies, and provider imagery copies without retained-data approval |
| TCGplayer | Lorcana marketplace product, SKU, group/set, sealed-product, variant, and price-reference evidence through the existing Chase Sets automation path | Product id external-reference candidates, SKU external-product-reference candidates after selected Options validate, group/set-name matching evidence, condition/language/printing/sealed-form evidence, marketplace product image URI evidence when approved | Prices as Catalog identity, market prices as Catalog truth, latest sales, seller/account facts, inventory, listings, orders, messages, cookies, session material, and TCGCSV as a production provider |
| Scrydex | Paid supplemental Lorcana source where its coverage is better for cards, sets, variants, image evidence, price-reference evidence, and freshness signals; sealed-product sync remains gated/test-only for this milestone | Card and variant identifiers, set identifiers, image URI evidence when approved, provider freshness, usage, credit, and cache diagnostics; sealed-product identifiers and packaging labels only after the gated unit is separately approved | API keys or team ids, per-game Scrydex credential settings, seller facts, inventory quantities, listings, orders, raw provider bodies, unapproved price-history bodies, and unapproved sealed-product promotion |
| Disney Lorcana/Ravensburger official | Canonical validation reference only unless legal/source-authority approval explicitly permits ingestion | Manual validation reference, source-disagreement evidence after redaction, and operator checklist evidence that provider records align with official release information | Raw official page text, official imagery copies, scraped payload bodies, and automated ingestion facts without explicit approval |

TCGCSV is not a production provider for this milestone. TCGplayer evidence must
come from the existing Chase Sets TCGplayer automation provider and the same
secure credential/redaction posture used by the other product lines.

Ravensburger and official Disney Lorcana pages are validation-only references
for this milestone (set names/codes, release/prerelease dates, printed totals
and card-gallery presence, official product lineup and sealed-product labels,
official app references and release-family membership). Representative validation
checks must cover the operator-selected current or most recent main set and the
stable older `The First Chapter` (`TFC`) set before production signoff. Official
references may be recorded only as redacted validation labels and
source-disagreement diagnostics, never raw official text, imagery copies,
scraped payload bodies, or hidden provider URLs.

### Scrydex credit policy

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

### Conflict and duplicate policy

Lorcana card identity requires set/chapter identity, collector number, printed
name, version, language, and material variant facts such as foil or special
treatment when present. Sealed-product identity requires set/release family,
product name, language, and sealed-product form so booster packs, sleeved
boosters, displays, cases, starter decks, troves, gift sets, prerelease boxes,
and collections do not collapse into one Catalog Item. Promotion reuses an
existing Catalog Item when exactly one safe candidate is found by external
Catalog Item reference, provider source link, or deterministic Lorcana identity.
Marketplace-only TCGplayer products remain review evidence until a deterministic
Catalog Item bridge exists. Conflicts between LorcanaJSON, Lorcast, Scrydex,
TCGplayer, official validation, or an approved fallback source are reviewable
diagnostics that name provider/source, field class, decision path, and redacted
evidence summaries.

### Governed data classes

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

### Policy/legal approval status

Production activation for any Lorcana provider is blocked until provider-data
policy/legal approval is recorded for LorcanaJSON, Lorcast, Scrydex Lorcana,
TCGplayer Lorcana, official validation use, and any approved fallback source;
retained-data exceptions exist for every retained sample, fixture body, dry-run
body, provider imagery evidence view, usage export, or export package; Scrydex
Lorcana card, set, and approved price/freshness import units have
shared-credential and bulk-first call-budget tests; the Scrydex Lorcana
sealed-product profile remains inactive test evidence until source authority,
rollout controls, and UAT separately approve that unit; rollout controls can
independently block provider transport, option queries, import, promotion,
reapply, activation, worker processing, and broad read/write access for every
Lorcana unit, including unit-scoped stops that do not disable the same provider
for other product lines; conflict policy explains LorcanaJSON, Lorcast, Scrydex,
TCGplayer, official validation, and fallback source authority, losing evidence
retention, duplicate-prevention order, and manual-review blockers; asset policy
evidence proves approved provider images are rehosted into Catalog-owned Product
Asset Sets when promoted without leaking provider image URLs; the #2486
downstream smoke proves one promoted/reapplied Lorcana item or set projects into
a representative downstream read model or UI; and
`CATALOG_INTEGRATION_LORCANA_PRODUCTION_SIGNOFF_REFERENCE` names the accepted
provider-data approval, #2481 UAT evidence, and #2486 smoke evidence before
production-like Lorcana imports, promotions, reapply, or activation are opened.

For milestone #50, the accepted provider-data approval is recorded on #2464 and
#2466. The accepted interface-only UAT and downstream smoke evidence is on
`0fc9f20279428b78d19c079cb61085a7f6d0cfd6`: `lorcana-launch` run
`28278540059`, second same-SHA `lorcana-launch` run `28278807826`, and
`all-provider-regression` run `28279080021`. Those runs completed the active
Lorcana provider units, One Piece/Pokemon/MTG regression units, and downstream
Catalog Items projection without direct provider URLs, direct APIs, SQL, browser
console commands, hidden routes, raw provider payloads, provider imagery, or
secrets. The downstream row observed was `Abu - Mischievous Monkey ... The First
Chapter ... English Lorcana Card Print ... lorcanajson, tcgplayer ... draft`.

LorcanaJSON, Lorcast, Scrydex, and TCGplayer may provide image URI evidence only
when the provider-data signoff permits that evidence class; official Disney
Lorcana/Ravensburger images are validation labels only. Promotion downloads
approved images into Catalog-owned Product Asset Sets following
`catalog-product-image-retention-v1` and publishes only Chase Sets asset URLs as
compatibility `imageUrls`. Takedown or source-revocation requests use the
Catalog asset takedown path in
[Catalog Asset Storage](../../../docs/runbooks/catalog-asset-storage.md).

### Milestone / UAT

The #2481 staging UAT and #2486 downstream smoke are accepted for milestone #50
on SHA `0fc9f20279428b78d19c079cb61085a7f6d0cfd6`:

- `28278540059` (`lorcana-launch`) completed one Lorcana set/source scope from
  each active Lorcana provider profile and verified downstream Catalog Items
  projection.
- `28278807826` (`lorcana-launch`) repeated the same proof on the same SHA so
  reruns are not poisoned by prior promotions.
- `28279080021` (`all-provider-regression`) completed Lorcana plus One Piece,
  Pokemon, and MTG shared-importer regression scopes and verified downstream
  Lorcana projection again.

The active Lorcana launch profile set is LorcanaJSON card/set reference data,
Lorcast card/set reference data, Scrydex card/set reference data, and TCGplayer
card/sealed-product source observations. The gated Scrydex sealed-product
profile is not part of the active launch profile set. Future revalidation must
use the same normal operator navigation and must prove normal LorcanaJSON and
active Scrydex paths use bulk/list/search or set-file ingestion instead of one
provider call per card, variant, or active sealed-product unit.

Related issues:

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
- #2482 Retire validation-only/stub paths and finalize production docs after
  proof
- #2486 Smoke one promoted Lorcana item through downstream catalog projection
