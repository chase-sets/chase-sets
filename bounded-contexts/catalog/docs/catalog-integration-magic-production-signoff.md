# Catalog Integration Magic Production Signoff

This document is the production activation start gate for Magic: The Gathering
Catalog sync from MTGJSON, Scryfall, and TCGplayer.

Tracking:

- Milestone: #42 Magic: The Gathering catalog provider production sync
- Parent tracker: #2024
- Start gate: #2025
- Required staging UAT: #2039

Production activation is not approved until this signoff is complete and the
staging UAT passes from the Chase Sets interface. Operators must not use
handcrafted URLs, direct API calls, CLI commands, SQL, Postman, browser console
commands, manual provider endpoint access, or hidden Admin/API routes for the
UAT.

## Provider Authority

| Provider | Production role | Catalog authority | Explicitly not Catalog truth |
| --- | --- | --- | --- |
| Scryfall | Primary Magic card-print and image-evidence source | Card-print identifiers, Oracle/Card ids, set code and name evidence, collector number, language, rarity, finishes, layout, image status, image URI evidence, TCGplayer cross-reference evidence | Prices, legalities, rulings, user/account data, provider availability signals beyond diagnostics |
| MTGJSON | Magic set/reference-data and cross-check source | Set code, set name, release date, set metadata, card UUIDs, identifiers, collector number, language/print metadata, cross-provider disagreement evidence | Prices, legalities, rulings, deck/format analysis, non-Catalog gameplay facts unless a later owner contract accepts them |
| TCGplayer | Magic marketplace product, SKU, sealed-product, and external-reference identity source | Product ids, SKU ids, product-line/category evidence, set-name matching evidence, product names as matching evidence, barcode/sealed-form evidence, External Catalog Item Reference and External Product Reference candidates | Prices, market prices, latest sales, seller facts, account facts, inventory, listings, quantities, orders, messages, session/cookie material |

Provider adapters collect observed facts and sanitized transport diagnostics.
They do not write Catalog Items, Products, Reference Records, or external
references directly. Catalog Source Observations, promotion, conflict policy,
duplicate prevention, and operator review own the transition into Catalog truth.

## Governed Data Classes

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

## Allowed Fact Policy

### Scryfall

Scryfall may feed normalized Source Observation facts for Magic card prints and
image evidence. Allowed retained summaries include provider key, ingestion unit,
profile version, Scryfall card id, Oracle id, set code, set name, collector
number, language, rarity, finishes, layout, image status, bounded image role,
TCGplayer product cross-reference evidence, source hash, job id, and diagnostic
codes.

Scryfall prices, legalities, rulings, raw response bodies, full provider URLs in
logs, and non-Catalog gameplay facts stay out of Catalog truth unless a later
bounded-context issue changes ownership.

### MTGJSON

MTGJSON may feed normalized Source Observation facts for Magic set references
and card-print reference data. Allowed retained summaries include provider key,
ingestion unit, profile version, set code, set name, release date, set metadata
needed by Catalog Reference Records, card UUID, collector number, language,
print identifiers, source hash, job id, and diagnostic codes.

MTGJSON prices, legalities, rulings, raw set files, raw bulk files, and
non-Catalog gameplay facts stay out of Catalog truth unless a later
bounded-context issue changes ownership.

### TCGplayer Magic

TCGplayer Magic may feed normalized Source Observation facts for external
marketplace identity. Allowed retained summaries include provider key,
ingestion unit, profile version, product id, SKU id, product-line/category
evidence, set-name matching evidence, product name as matching evidence,
barcode/sealed-form evidence, selected-option evidence after validation,
source hash, job id, credential readiness state, source kind, and diagnostic
codes.

The following TCGplayer facts are forbidden in Catalog truth, retained payload
hash material, screenshots, logs, metrics, CI artifacts, and issue comments:

- price, market price, latest sale, listing, inventory, quantity, order, and
  message facts;
- seller ids, seller names, seller keys, seller emails, account identifiers, and
  marketplace account facts;
- cookies, session material, authorization headers, tokens, and secrets;
- raw automation-app request or response bodies.

TCGplayer Product ids map to External Catalog Item Reference candidates.
TCGplayer SKU ids map to External Product Reference candidates only after the
selected Options validate against the active Catalog Product schema.

## Activation Signoff Checklist

Production activation for any Magic provider is blocked until all applicable
items below are complete:

- [ ] Provider-data policy/legal approval is recorded for MTGJSON, Scryfall, and
  TCGplayer Magic.
- [ ] Retained-data exceptions exist for every retained real-provider sample,
  fixture body, dry-run body, provider imagery evidence view, or export package.
- [ ] TCGplayer Magic credential/session storage, rotation, redaction, and
  operator-safe readiness surfacing are approved.
- [ ] Active production profile versions exist for the selected Magic ingestion
  units and every active profile has executable mapping-contract and fixture
  coverage.
- [ ] Provider option queries have cache, stale-state, pagination, retry,
  provider-unavailable, and backpressure behavior visible to operators.
- [ ] Rollout controls can independently block provider transport, option
  queries, import, promotion, reapply, activation, worker processing, and broad
  read/write access for MTGJSON, Scryfall, and TCGplayer.
- [ ] Conflict policy explains Scryfall, MTGJSON, and TCGplayer field authority,
  losing evidence retention, duplicate-prevention order, and manual-review
  blockers.
- [ ] #2039 staging UAT passes from the Chase Sets interface without direct
  URLs, APIs, CLI, SQL, Postman, browser console commands, provider endpoints,
  or hidden Admin/API routes, and proves both one Magic set and one Pokemon set
  can sync through the same source-scope importer.
- [ ] `CATALOG_INTEGRATION_MAGIC_PRODUCTION_SIGNOFF_REFERENCE` names the
  accepted provider-data approval and #2039 UAT evidence before production-like
  MTGJSON, Scryfall, or TCGplayer Magic imports, promotions, reapply, or
  activation are opened.
- [ ] Launch evidence records the selected Magic set, provider runs, profile
  versions, source hashes or approved hash omissions, job ids, dry-run results,
  promotion outcomes, conflicts/duplicates, rollback controls, and emergency
  stop readiness.
- [ ] Production import enablement evidence names the exact provider or provider
  list to enable, proves the other Magic providers can remain stopped or open
  independently, and records current rollout-control state from Integration
  health.
- [ ] Production promotion enablement evidence includes reviewed promotion
  preview counts for eligible, blocked, skipped, conflicting, duplicate
  prevention, and failed outcomes, plus the owner decision for every nonzero
  blocked/conflicting/duplicate count.
- [ ] Production monitoring evidence links the launch slice to provider
  availability, option-query freshness/cache-only/stale states, job lag,
  failure rate, blocked promotions, conflict counts, duplicate-prevention
  blocks, and emergency-stop state.

## Work Allowed Before Signoff

These workstreams may proceed behind disabled or dry-run-only controls before
production activation:

- ingestion-unit identity and provider profile shape;
- MTGJSON, Scryfall, and TCGplayer Magic adapters and mapping contracts;
- synthetic or approved-redacted fixtures;
- dry-run normalization, diagnostics, conflict previews, and duplicate previews;
- option-query UI and API behavior when live transport is disabled or cache-only;
- promotion planning and read-model work that cannot write production Catalog
  truth until rollout controls permit it;
- operator UI surfaces for readiness, dry run, import planning, job progress,
  diagnostics, and evidence.

These actions remain blocked until signoff:

- production activation of MTGJSON or Scryfall runtime registration;
- production activation of TCGplayer Magic import or promotion profiles;
- live retained provider sampling;
- retained real-provider payload bodies or provider imagery evidence views;
- promotion into production Catalog truth;
- provider-data export packages containing provider-controlled content.

## Required UAT Evidence

The staging UAT must demonstrate one Magic set synced from MTGJSON, Scryfall,
and TCGplayer through normal operator navigation in the Chase Sets interface.
It must also demonstrate one Pokemon set synced through the same source-scope
importer so the Magic rollout cannot regress the existing Pokemon operator
workflow.

Evidence must include:

- selected Magic set, selected Pokemon set, and operator-visible source scope;
- MTGJSON, Scryfall, and TCGplayer Magic provider readiness state;
- Pokemon provider readiness state for the same source-scope importer;
- option-query cache/freshness state;
- dry-run diagnostics and semantic summary;
- import job ids, profile versions, ingestion units, and source hashes or
  approved hash omissions;
- promoted Magic set, promoted Pokemon set, and representative card-print
  records in Catalog read models;
- TCGplayer external reference and SKU attachment results without forbidden
  commerce facts;
- conflict and duplicate-prevention outcomes;
- screenshots or operator-visible artifacts for emergency stop, imports
  disabled, promotion disabled, reapply disabled, and dry-run-only controls.
- operator-visible artifacts for cache-only option-query behavior for MTGJSON,
  Scryfall, and TCGplayer, including at least one fresh or stale cached selector
  state and the empty-cache unavailable state where practical.
- proof that stopping one Magic provider leaves the other two providers'
  readiness and allowed actions visible in Integration health.
- proof that Magic and Pokemon are selected from the shared source-scope
  interface, without a product-line-specific sync area.

## Related Issues

- #2025 Complete provider-data governance and production activation signoff
- #2029 Promote Scryfall to production card-print and image-evidence sync
- #2030 Promote MTGJSON to production set and card reference sync
- #2031 Add TCGplayer Magic single-card product and SKU sync profile
- #2032 Add TCGplayer Magic sealed-product sync profile
- #2039 Staging UAT: sync one Magic set from all three providers and one Pokemon
  set through the shared interface
