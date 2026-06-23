# Source Conflict Resolution

Catalog can ingest multiple provider observations for the same Catalog Item, reference, image, external reference, or Product evidence. When sources disagree, the Catalog Integration Engine owns the field winner decision. Provider adapters may supply timestamps, provenance, payload metadata, confidence inputs, and transport diagnostics, but they must not decide Catalog truth.

## Policy Scope

Conflict policies apply to updateable Catalog facts produced from Source Observations, including:

- display and identity-adjacent fields: name, title, subtitle, description, card number, rarity, release date, product metadata
- external references and provider identifiers
- Reference Record relationships: set, series, product line, manufacturer, parent/child, variant, language, printing, product category/form
- image evidence and media selection
- condition/certification evidence: raw, graded, signed, altered, damaged, grading company, grade, slab/cert number
- marketplace/SKU selected Option evidence
- price, market, listing, seller, inventory, order, message, and availability evidence only as rejected or routed evidence unless a future owning context explicitly consumes it

## Strategy Set

Each policy chooses one strategy for a field or category:

- `source-precedence`: a named provider or ingestion unit wins for a field/category.
- `latest-source-update-wins`: use trusted provider `sourceUpdatedAt` or equivalent.
- `latest-observation-wins`: use Catalog observation time when provider timestamps are absent or untrusted.
- `immutable-after-promotion`: never overwrite the field automatically after initial promotion.
- `manual-review-required`: block promotion/reapply until an operator resolves the disagreement.
- `additive-merge`: retain multiple values where facts can coexist, such as external references or evidence links.
- `confidence-rule`: choose by fixture-proven confidence, evidence count, verification status, or rule-specific score.
- `operator-override`: use an authorized admin decision with actor, reason, evidence, and audit trail.
- `stale-no-op`: ignore lower-priority, older, weaker, omitted, or stale facts without deleting retained evidence.

## Evaluation Order

1. Load the policy version for the profile/ingestion unit and Catalog fact category.
2. Gather current Catalog value, candidate provider values, observation provenance, source timestamps, fixture confidence, and prior overrides.
3. Reject unsafe evidence categories before winner selection.
4. Apply immutable and manual-review blockers before automatic strategies.
5. Apply additive merge where values can coexist.
6. Apply precedence, latest-source, latest-observation, or confidence rules.
7. Record stale/no-op decisions for rejected lower-priority evidence.
8. Return a conflict-aware promotion/reapply plan.

For a given profile version, policy version, observation set, current Catalog fact snapshot, and operator override set, evaluation must be deterministic.

## Decision Evidence Shape

Each promotion/reapply plan should carry:

- policy version and rule key
- provider key, profile version, and ingestion unit key
- affected Catalog record and field/category
- current Catalog value
- winning value and source observation
- losing values and source observations
- strategy used
- confidence or timestamp inputs when applicable
- action: `automatic`, `blocked`, `manual-review-required`, `additive`, `stale-no-op`, or `operator-override`
- diagnostics
- audit metadata

Losing evidence is retained unless provider-data retention policy requires redaction or deletion.

## Required Domain Defaults

Card name normalization:

- Pokemon TCG card names default to source precedence by ingestion unit until a field-specific policy says otherwise.
- MTGJSON/Scryfall validation must include a disagreement scenario and prove no provider-specific branch is needed.

Images:

- Image source selection should be explicit by image role and product domain.
- If the preferred source lacks usable media, fallback must record the fallback rule and losing/missing evidence.

Marketplace SKU and condition/certification:

- SKU condition, grading, signed, altered, damaged, and listing-specific evidence must not overwrite underlying card identity automatically.
- Valid selected Option evidence can become an External Product Reference only after Product schema validation.

Reference hierarchy:

- Hierarchy changes after promotion default to manual review unless a policy names the source as authoritative and replay impact is known.

Omissions:

- Provider omission defaults to stale/no-op. Deletion requires an explicit policy, evidence that the source is authoritative for absence, and audit.

External references:

- Multiple valid external Catalog Item references are additive unless a policy marks them mutually exclusive.
- Repeated provider identifiers across materially different observations block automatic promotion.

One Piece cross-provider identity:

- Scrydex and TCGplayer One Piece card or sealed-product observations reuse an existing Catalog Item when exactly one safe candidate is found by external Catalog Item reference or by deterministic One Piece identity. Card identity requires set, card number, printed name, language, and card type/variant. Sealed-product identity requires set, product name, language, and sealed-product form so booster packs, booster boxes, starter decks, and other packaging variants do not collapse into one Catalog Item.
- Marketplace-only TCGplayer products remain review evidence until a Scrydex, TCGplayer, or operator-approved deterministic path resolves exactly one Catalog Item. Bridge evidence without a unique candidate must not create a new Catalog Item automatically.
- Scrydex, TCGplayer, Bandai validation, or approved fallback disagreements are reviewable diagnostics. Admin-visible diagnostics identify provider/source, field class, and decision path, and use redacted provider-evidence summaries rather than raw provider payloads.

Price, listing, inventory, order, seller, and message facts:

- These are not Catalog truth. Catalog may retain safe evidence only when permitted by [Catalog Integration Data Governance](./catalog-integration-data-governance.md) and must not include them in Source Observation hash material unless a future owner contract explicitly changes the boundary.

## Diagnostics

The engine must support diagnostic codes for:

- missing precedence rule
- untrusted source timestamp
- conflicting immutable field
- manual review required
- stale source rejected
- additive merge applied
- operator override applied
- unsafe evidence rejected
- source omission ignored
- provider identifier conflict

Diagnostics shown in admin should include provider, ingestion unit, profile version, field/category, severity, blocking state, affected Catalog record, winning/losing evidence summary, and recommended correction without exposing sensitive provider material.

## Admin Requirements

The Admin Control Plane must expose conflicts as guided workflows:

- health/readiness counts by provider, ingestion unit, profile version, field/category, and severity
- conflict detail with current value, candidate values, source evidence, rule used, timestamps, confidence inputs, and prior decisions
- activation or promotion blockers when policies are missing or unresolved conflicts exceed thresholds
- semantic diff/reapply preview after policy changes
- operator override with permission check, reason, affected-field preview, confirmation, and audit

Raw JSON editing must not be required to resolve supported conflict workflows.

## Release Verification

Before milestone completion:

- tests cover source precedence, latest source update wins, immutable after promotion, manual review required, additive merge, operator override, and stale/no-op rejection
- MTGJSON/Scryfall final validation includes at least one source-to-source conflict scenario
- no provider-specific conflict branches are added outside allowed extension points
- release notes and PR details state accepted conflict-policy defaults and any deferred P3+ gaps
