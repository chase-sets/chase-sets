# Catalog Integration One Piece Production Signoff

This document is the production activation start gate for One Piece Catalog sync
from Scrydex and the existing Chase Sets TCGplayer provider path.

Tracking:

- Milestone: #46 One Piece catalog provider production sync
- Parent tracker: #2268
- Start gate: #2269, #2270, and #2287
- Required staging UAT: #2285

Production activation is not approved until this signoff is complete and the
staging UAT passes from the Chase Sets interface. Operators must not use
handcrafted URLs, direct API calls, CLI commands, SQL, Postman, browser console
commands, manual provider endpoint access, or hidden Admin/API routes for the
UAT.

## Provider Authority

| Provider | Production role | Catalog authority | Explicitly not Catalog truth |
| --- | --- | --- | --- |
| Scrydex | Preferred paid One Piece seed provider for cards, variants, expansions, sealed products, approved price-history evidence, and webhook freshness where source authority approves the data class | Card and variant identifiers, expansion/set identifiers, sealed product identifiers and packaging labels, image URI evidence when approved, freshness and usage diagnostics | Seller facts, inventory quantities, listings, orders, raw provider bodies, API keys, team ids, and price history except as approved evidence outside Catalog truth |
| TCGplayer | One Piece marketplace product, SKU, group/set, and price-reference evidence through the existing provider path | Product id external-reference candidates, SKU external-product-reference candidates after selected Options validate, group/set-name matching evidence, condition/language/printing/sealed-form evidence | Prices as Catalog identity, market prices as Catalog truth, latest sales, seller/account facts, inventory, listings, orders, messages, cookies, and session material |
| Bandai official One Piece Card Game | Canonical validation reference only unless legal/source-authority approval explicitly permits ingestion | Manual validation reference, source-disagreement evidence, and operator checklist evidence that provider records align with official release information | Raw official page text, official imagery copies, scraped payload bodies, and automated ingestion facts without explicit approval |
| Fallback/community/free sources | Comparison-only or fallback evidence after governance approval | Source-disagreement diagnostics, coverage-gap analysis, and fallback identifiers only when a separate approval names the source and data class | Default production authority, raw community payloads, unapproved images, and unreviewed price or gameplay facts |

Provider adapters collect observed facts and sanitized diagnostics. They do not
write Catalog Items, Products, Reference Records, External Catalog Item
References, or External Product References directly. Catalog Source
Observations, promotion, conflict policy, duplicate prevention, and operator
review own the transition into Catalog truth.

Representative validation checks must cover at least one card, one expansion,
and one sealed product before production signoff. Bandai official references
may be used only as redacted validation labels and source-disagreement
diagnostics. Fallback/community sources may be used only after named source
approval and remain comparison-only. Each disagreement diagnostic must name the
provider key, ingestion unit, comparison source key, redacted external id, and
field class; it must not retain raw official/community payload text, official
imagery copies, provider imagery, or scraped payload bodies.

## Scrydex Credit Policy

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

## Governed Data Classes

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

## Activation Signoff Checklist

Production activation for any One Piece provider is blocked until all applicable
items below are complete:

- [ ] Provider-data policy/legal approval is recorded for Scrydex One Piece,
  TCGplayer One Piece, Bandai validation use, and any approved fallback source.
- [ ] Retained-data exceptions exist for every retained real-provider sample,
  fixture body, dry-run body, provider imagery evidence view, usage export, or
  export package.
- [ ] Scrydex credential, team, subscription, credit, rate-limit, redaction, and
  operator-safe readiness surfacing are approved.
- [ ] Active profile versions exist for selected One Piece ingestion units and
  every active profile has executable mapping-contract and fixture coverage.
- [ ] Scrydex card, expansion, sealed-product, and approved price/freshness
  import units have bulk-first call-budget tests.
- [ ] Provider option queries have cache, stale-state, pagination, retry,
  provider-unavailable, credit estimate, and backpressure behavior visible to
  operators.
- [ ] Rollout controls can independently block provider transport, option
  queries, import, promotion, reapply, activation, worker processing, and broad
  read/write access for Scrydex and TCGplayer.
- [ ] Conflict policy explains Scrydex, TCGplayer, Bandai validation, and
  fallback source authority, losing evidence retention, duplicate-prevention
  order, and manual-review blockers.
- [ ] #2285 staging UAT passes from the Chase Sets interface without direct
  URLs, APIs, CLI, SQL, Postman, browser console commands, provider endpoints,
  or hidden Admin/API routes, and proves One Piece, Pokemon, and MTG source
  scopes can sync through the same importer.
- [ ] `CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE` names the
  accepted provider-data approval and #2285 UAT evidence before
  production-like One Piece imports, promotions, reapply, or activation are
  opened.
- [ ] Launch evidence records the selected One Piece source scope, provider
  runs, profile versions, source hashes or approved hash omissions, job ids,
  Scrydex estimated/actual call counts, page counts, cache hit/miss counts,
  usage diagnostics, dry-run results, promotion outcomes, conflicts/duplicates,
  rollback controls, and emergency-stop readiness.

## Work Allowed Before Signoff

These workstreams may proceed behind disabled or dry-run-only controls before
production activation:

- ingestion-unit identity and provider profile shape;
- Scrydex and TCGplayer One Piece adapters and mapping contracts;
- synthetic or approved-redacted fixtures;
- dry-run normalization, diagnostics, conflict previews, duplicate previews,
  and Scrydex call-budget proofs;
- option-query UI and API behavior when live transport is disabled or
  cache-only;
- promotion planning and read-model work that cannot write production Catalog
  truth until rollout controls permit it;
- operator UI surfaces for readiness, usage estimates, dry run, import planning,
  job progress, diagnostics, and evidence.

These actions remain blocked until signoff:

- production activation of Scrydex runtime registration;
- production activation of TCGplayer One Piece import or promotion profiles;
- live retained provider sampling;
- retained real-provider payload bodies or provider imagery evidence views;
- promotion into production Catalog truth;
- provider-data export packages containing provider-controlled content.

## Required UAT Evidence

The staging UAT must demonstrate one One Piece source scope synced from Scrydex
and the existing TCGplayer provider path through normal operator navigation in
the Chase Sets interface. It must also demonstrate one Pokemon set and one MTG
set synced through the same source-scope importer so the One Piece rollout
cannot regress existing operator workflows.

Evidence must include:

- selected One Piece, Pokemon, and MTG source scopes;
- Scrydex and TCGplayer readiness state;
- Scrydex credential, team, credit/rate, cache, and usage readiness state;
- option-query cache/freshness state;
- preflight estimated Scrydex calls/credit impact or an
  `estimate-unavailable` diagnostic with a reason;
- import job ids, profile versions, ingestion units, source hashes or approved
  hash omissions, and actual Scrydex request/page/cache/usage evidence;
- proof that the normal Scrydex import path used bulk/search pagination and did
  not make one provider call per card, variant, or sealed product;
- Source Observation counts, promotion preview counts, promotion outcomes, and
  read-model visibility;
- TCGplayer external reference and SKU attachment results without forbidden
  commerce facts;
- conflict and duplicate-prevention outcomes;
- screenshots or operator-visible artifacts for emergency stop, imports
  disabled, promotion disabled, reapply disabled, dry-run-only, and cache-only
  option-query controls;
- proof that One Piece, Pokemon, and MTG are selected from the shared
  source-scope interface without a product-line-specific sync area.

## Related Issues

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
