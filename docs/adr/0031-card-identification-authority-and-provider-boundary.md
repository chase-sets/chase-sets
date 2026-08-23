# ADR 0031: Card Identification Authority And Provider Boundary

## Status

Accepted as the planning record for card identification in [epic #4926](https://github.com/chase-sets/chase-sets/issues/4926). The adoption anchor is main commit `22c35a6fc74b20b77feb3528466ca2eff07b734c` (2026-08-23).

This ADR is documentation only. It creates no Scanning package, context manifest, runtime scaffold, API, UI, schema, event, provider adapter, capability declaration, policy value, or fixture. Every statement about Scanning below records **planned** ownership for later slices. Nothing here asserts that a Scanning context, an identification provider port, or a provider adapter exists in this repository today.

## Context

Card identification from a phone camera can remove most of the typing from seller intake, but a provider's guess about which card is in a photo is not marketplace identity truth. A wrong printing on a confirmed listing is a large financial error, and provider vocabulary that leaks into persisted identity is expensive to unwind later. The ownership rule therefore has to be fixed before any adapter, capture surface, or session aggregate is built.

At the adoption anchor the repository already owns every downstream boundary this capability would touch, and owns none of the scanning behavior itself:

- There is no Scanning context. No scanning directory, `package.json`, or `context.json` exists, and a repository search at the anchor found no card-identification camera-capture flow, identification provider port, scan-session behavior, or recognition adapter. Generic evidence-upload capture surfaces do exist in other contexts and stay outside Scanning.
- Catalog owns canonical Product identity. `bounded-contexts/catalog/GLOSSARY.md` defines the four core concepts as Catalog Item, Dimension, Option, and Product, fixes Product identity as the tuple of `catalogItemId` and `selectedOptions`, and states that a Product is not an independently persisted aggregate with a minted Product id. `ProductKey` is the deterministic derived display and selection lookup key, not standalone identity.
- Catalog also owns reusable provider mappings. The same glossary defines External Product Reference (a provider-scoped SKU or sellable identifier mapped to one Catalog Item plus selected Options), External Catalog Item Reference, Provider Integration Profile, Provider Scope Observation, and Provider Scope Mapping, together with the review and promotion policy for provider Source Observations. Its Boundary section states that Catalog defines the external references that map provider identifiers to Catalog Item and Product selection truth.
- Inventory owns review-first intake. `bounded-contexts/inventory/docs/import-product-resolution.md` describes Import Batches that resolve incoming rows to Products through Catalog-owned external references in deterministic order, keep unmapped rows rejected for review instead of forcing per-row manual selection, and create or adjust Inventory Items only when accepted rows are committed.
- The explicit Product-resolution surface is already shipped. `bounded-contexts/inventory/features/import-batches/ui/import-batch-page.tsx` opens a per-row resolution drawer in which the seller picks a Catalog Item and then an allowed Option for every active required product-schema Dimension before the row resolves; inactive Dimensions are not offered, and an active optional Dimension may be left unset. `packages/design-system/src/components/forms/product-selection-fields.tsx` is the canonical control that renders one field per active Dimension.
- Ranked manual resolution already has a planned owner, and the ranked outcome itself is not shipped. [Epic #7371](https://github.com/chase-sets/chase-sets/issues/7371) is open: it plans Discovery-ranked Catalog Item choices for sellers across children #7368-#7370, reusing that same drawer and Product selection control, and keeping text and embedding matches advisory until the seller confirms the Catalog Item and a Catalog-valid Option selection. The drawer and the control are shipped today; the ranked manual-match picker is planned. #7371 also fixes the ownership split this ADR inherits — Discovery owns Relevance, Catalog owns Product identity, Inventory owns Import review and stock creation, and Marketplace owns Listing creation — and states that #4926 remains the owner of capture, recognition, confirmation, and scan-session handoff, and that it does not rebuild Scanning.
- Catalog does not currently register Printing or Variant as Product-variation terms. Its glossary uses Dimension and Option for variation, and reserves Asset Variant for generated imagery.

Neither the capability registry ([#4410](https://github.com/chase-sets/chase-sets/issues/4410)) nor metered capability declarations ([#4889](https://github.com/chase-sets/chase-sets/issues/4889)) has shipped, so there is no registry in which to declare an identification capability and no metering machinery with which to price one.

## Decision

### Planned Scanning ownership

A future Scanning bounded context will own card capture and identification behavior end to end:

- Card Scan and Scan Session lifecycle, including capture, retry, discard, and completion.
- Provider-neutral identification orchestration: dispatching an Identification Attempt, collecting Identification Candidates, and assigning a Match Confidence Tier.
- Match confirmation and correction, including the Unidentified Scan queue.
- Scanning-owned read models, seller-facing surfaces, and tests.

Scanning is planned, not implemented. [#4918](https://github.com/chase-sets/chase-sets/issues/4918) is the first runtime slice: it creates the Scanning context package, its `context.json` manifest, and its local glossary. It must land before [#4917](https://github.com/chase-sets/chase-sets/issues/4917) or any other runtime scanning slice assumes those paths exist. Until it lands, Scanning owns reserved vocabulary and this decision record, and nothing else.

### Identification is advisory; confirmation is authoritative

Provider output is advisory evidence about a photograph. It is never marketplace identity.

The authoritative fact for a scan match is an explicit seller-confirmed **complete Catalog Product selection**: a Catalog Item plus Catalog-valid `selectedOptions` — one allowed Option for every active required Dimension of that item's product schema, no Option for an inactive Dimension, and an active optional Dimension either absent or set to an allowed Option. Catalog validation, not Scanning and not a provider, decides whether a selection is valid. No Match Confidence Tier, provider score, or candidate ranking may substitute for that confirmation, and no threshold may auto-promote a candidate into a Confirmed Match. A candidate whose selected Options are not Catalog-valid is not confirmable, however high its score.

Only a Confirmed Match may leave Scanning as an authoritative Product-identity or intake fact. An Identification Candidate, a tier assignment, and a raw provider response are internal Scanning evidence and never leave as identity.

Named non-identity coverage signals are the one deliberate exception to that rule. A Catalog-gap observation and a provider-scope observation — the card is real but Catalog has no matching item, or the provider's set vocabulary is unmapped — may leave Scanning as coverage evidence for Catalog coverage work, through Catalog's reviewed Source Observation and coverage workflow. Such a signal is not Product identity, not Catalog truth, not Inventory intake, and never a listing: it creates no Catalog Item, no Inventory row, and no draft, and it carries no authority to resolve the scan that produced it. [#4930](https://github.com/chase-sets/chase-sets/issues/4930) owns publishing it as a distinct fact with one behavior owner. No other Scanning evidence inherits this exception.

### Catalog boundary

Catalog remains the only owner of Product identity, the valid set of selected Options, and reusable provider-to-Catalog references and mappings.

Scanning must not write Catalog truth, mint Product identity, or maintain a competing canonical alias, set-code, or card-number registry.

Catalog carries three distinct mechanisms for three distinct kinds of scan evidence, and Scanning must not collapse them into one:

| Evidence a scan produces | Catalog mechanism that may hold it durably | Not this |
| --- | --- | --- |
| A provider product identifier — a provider card id, SKU, or sellable id | An External Catalog Item Reference when it maps to a Catalog Item alone, or an External Product Reference when it also carries the selected Options needed to resolve a Product | A Scanning-local alias table |
| Provider set vocabulary — a provider set id, set name, or category id | A reviewed Provider Scope Mapping onto exactly one Catalog Scope Record | An external product identifier reference |
| Canonical game, set, and card-number evidence | Catalog's own natural-key resolution against canonical Scope Record and Catalog Item attributes | An external mapping — a canonical set-and-number pair is Catalog's own natural key, not a provider-scoped identifier, and must never be recorded as one |

Whichever mechanism applies, the durable record is created and reviewed in Catalog under Catalog's review policy, never in a Scanning-local lookup table. [#4930](https://github.com/chase-sets/chase-sets/issues/4930) owns the ordered resolution contract that consumes all three.

A Catalog gap or an unmapped provider scope discovered by a scan is a signal to Catalog, not a licence for Scanning to invent an item or a mapping. The scan stays unresolved, and the observation may be reported as non-identity coverage evidence to the Catalog observation pipeline under the exception named above.

### Inventory boundary

Inventory remains the only owner of Import Batch creation, review, and stock intake.

Scanning may later publish a confirmed, intake-ready fact that Inventory consumes through its existing review-first import path. Scanning must not create or adjust Inventory Items directly, bypass import review, or open a parallel scan-to-listing path.

Quantity is split, and this ADR states the split rather than assigning it wholesale. Scanning may publish scan-count evidence: the unit quantity derived from its own confirmed scans, so that repeated confirmations of the same Product within one Scan Session aggregate into a count on the intake-ready fact ([#4923](https://github.com/chase-sets/chase-sets/issues/4923) and [#4930](https://github.com/chase-sets/chase-sets/issues/4930) own that shape). That count is scan evidence about what was photographed, not stock. Inventory owns quantity validation and stock quantity truth: it decides what the reviewed row becomes, the seller may edit the quantity in the import-batch review surface before commit, and Scanning never writes stock.

Condition, price, and listing-draft fields stay seller-declared in the intake surfaces that already own them. Scanning contributes Product identity plus that scan-count evidence, and nothing else.

### Discovery and manual-resolution boundary

Where a seller must resolve a card by hand — an unidentified scan, an ambiguous result, or a rejected candidate — the future Scanning surface must reuse the canonical ranked resolution behavior planned by [#7371](https://github.com/chase-sets/chase-sets/issues/7371) rather than inventing its own. That ranked manual-match picker is planned, not shipped; the Inventory per-row resolution drawer and the design-system Product selection control it will reuse are shipped today, so a Scanning slice arriving before #7371 plans against the shipped drawer and control.

Scanning must not build a second Product chooser, a second relevance ranker, a second seller search index, or a parallel printing picker. Ownership stays where #7371 fixes it: Discovery owns Relevance — advisory ranking expressed as ordered Result Sets, never Product identity and never seller Product-resolution behavior; Catalog owns Product identity and the valid set of selected Options; Inventory owns Import review, Product validation, and stock; Marketplace owns Listing creation. Scanning owns only the capture-and-confirm workflow around them.

### Provider port and anti-corruption mapping

No such port exists yet. When one is built, every identification provider must sit behind a single provider-neutral port with an anti-corruption mapping at the boundary:

- Provider vocabulary, response shape, credentials, error taxonomy, and scoring scale must never cross the port. Its published contract must be expressed in Chase Sets terms: an Identification Attempt in; Identification Candidates and a Match Confidence Tier out, plus typed refusal and failure outcomes.
- A provider field is evidence, never an identifier. A provider set id, card id, or SKU may become durable only by being reviewed into a Catalog-owned external reference or scope mapping.
- Provider confidence numbers must be mapped into the Chase Sets Match Confidence Tier vocabulary at the boundary. Downstream code reads the tier, not the vendor's number.
- The port is the intended swap seam. Replacing a vendor, adding a second vendor, or moving to a self-hosted model ([#4925](https://github.com/chase-sets/chase-sets/issues/4925), parked) must be an adapter change, not a domain rewrite.

[#4917](https://github.com/chase-sets/chase-sets/issues/4917) owns building that port and the first adapter. Nothing in this ADR authorizes a provider account, credential, request, or spend.

### Visible unresolved and failure modes

This ADR adds no runtime lifecycle or state machine. It fixes the required behavior of the future one: every outcome below stays visible and pending explicit resolution, and creates no Catalog fact, no Inventory row, and no listing.

| Outcome | Required behavior |
| --- | --- |
| Provider unavailable, timed out, or refused | The captured scan stays visible and retryable, the photo is preserved, and the copy says the capture is safe. Retry is never silent promotion. |
| Low confidence | Routed to the Unidentified Scan queue for manual resolution — through the shipped resolution drawer today, and through #7371's ranked chooser once that lands. |
| Ambiguous, with several plausible candidates | Presented as competing Identification Candidates. No tie-break rule may pick one on the seller's behalf. |
| Catalog gap, where the card is real but absent from Catalog | Distinct from unreadable, with distinct copy. Stays unresolved and is reportable as a non-identity Catalog coverage signal, which creates no Catalog, Inventory, or listing fact. |
| Selected Options that Catalog does not accept | Not confirmable. An allowed Option for every active required Dimension must be supplied, and no Option for an inactive Dimension, before a Confirmed Match exists. |
| Seller rejects the proposal | Recorded as a Match Correction with the rejected candidate preserved; the corrected selection is the authoritative one. |
| Allowance or budget refusal | A typed refusal, not a degraded guess. The photo is kept and no provider spend occurs. |

Routine retry, backoff, queue drain, or manual resolution must never convert any of these into a Confirmed Match without an explicit seller confirmation.

### Language

Scanning must use Catalog's Product, Dimension, Option, `catalogItemId`, and `selectedOptions` vocabulary unchanged, and Inventory's Import Batch vocabulary unchanged.

**Printing** and **Variant** remain seller-facing descriptions of a Catalog Option selection. Catalog has not registered them as Product-variation terms, and Scanning must not define, own, or persist them as if it had. **Correction** is never a bare Scanning term; the registered term is Match Correction.

The planned Scanning term family is registered in [the master glossary](../GLOSSARY.md) under Planned Term Ownership: Card Scan, Scan Session, Identification Attempt, Identification Candidate, Match Confidence Tier, Confirmed Match, Match Correction, and Unidentified Scan. Planned registration reserves language; it does not imply shipped behavior. When #4918 lands and creates the Scanning package, manifest, and local glossary, full local definitions move into that local glossary and the master glossary keeps only cross-context index rows.

### Capability and metering posture

An identification capability named scanning.identify is a **reserved future candidate only**. The capability registry ([#4410](https://github.com/chase-sets/chase-sets/issues/4410)) and metered capability declarations ([#4889](https://github.com/chase-sets/chase-sets/issues/4889)) are not shipped, so this ADR neither pre-registers a capability entry nor sets a price, allowance, or metering policy. [#4921](https://github.com/chase-sets/chase-sets/issues/4921) owns the allowance and provider-budget guard when that work starts.

## Provider Qualification Status

Ximilar is a **provisional first qualification candidate**, not ratified runtime authority. This record activates no provider.

The facts below are advisory external observations of official public pages, captured at **2026-08-23T03:00Z**, at the planning and ADR-authoring moment. They establish current feasibility and order-of-magnitude economics only. They are not an authenticated provider response, exact-match accuracy evidence, an implementation payload contract, or production acceptance.

- Official pricing (https://www.ximilar.com/pricing/): the Business 100K plan is listed at EUR 59 per month with 100,000 monthly credits, and "Identify a TCG card" is listed at 10 credits.
- Official recognition reference (https://docs.ximilar.com/collectibles/recognition): access requires Business 100K or higher; the TCG identification endpoint accepts a maximum of 10 records per request and documents `set`, `set_code`, `series`, and `card_number` among its output fields; it names Pokemon, Yu-Gi-Oh!, Magic: The Gathering, One Piece, and Lorcana among more than 15 supported games.
- Official taxonomy (https://docs.ximilar.com/taxonomy/collectibles): documents the fields returned per game and explicitly warns that some information may not always be precise and that some fields may be missing for specific cards.

That last caveat is the vendor's own statement of the boundary this ADR draws: a field documented as sometimes imprecise cannot be identity.

Exact-match accuracy, provider-score calibration, latency, authenticated response mapping, and production acceptance are delegated:

- [#4927](https://github.com/chase-sets/chase-sets/issues/4927) owns the comparative qualification benchmark and its go/no-go evidence.
- [#4917](https://github.com/chase-sets/chase-sets/issues/4917) owns the port and adapter, and must capture a fresh authenticated test-mode request and response, plus observed usage evidence, before any real-provider activation.

Until both land, no real provider adapter may be activated. If an observed official fact changes, update or remove the advisory statement above rather than preserving a stale claim.

## Alternatives Considered

- **Auto-accept high-confidence provider output as identity.** Rejected. Provider output stays advisory evidence about a photograph, and the vendor's own taxonomy documentation warns that some information may not always be precise and that some fields may be missing. Auto-accept would convert a vendor field documented as sometimes imprecise into a marketplace-priced fact.
- **A Scanning-owned canonical card registry, alias table, or set-code map.** Rejected. It would duplicate Catalog's Catalog Item, external-reference, Provider Scope Mapping, and natural-key ownership and create a second identity source that drifts.
- **Let Scanning create Inventory rows or listings directly.** Rejected. Inventory owns review-first Import Batches and stock intake; a parallel path would bypass import review, Inventory availability rules, and Marketplace draft-publication rules.
- **A dedicated Scanning Product chooser and ranker.** Rejected. The resolution drawer and the Product selection control are shipped, and #7371 owns the planned ranked variant of the same behavior.
- **Ratify Ximilar as the runtime identification authority now.** Rejected. No authenticated probe, accuracy measurement, or calibration evidence exists, and internal consistency cannot qualify an external contract. #4927 owns qualification.
- **Self-hosted recognition first.** Rejected for now and parked as [#4925](https://github.com/chase-sets/chase-sets/issues/4925), behind the same port so the move stays an adapter change.
- **Infer condition or grade from scan imagery.** Rejected. Provider output stays advisory and may be imprecise, auto-accepting it is prohibited by the authority rule above, and a marketplace-published condition or grade the marketplace would have to stand behind is a trust liability; condition stays seller-declared.

## Consequences

- Scanning can be planned, sequenced, and reviewed before any code exists, because ownership, the authority rule, and the failure taxonomy are fixed.
- Every scanning slice inherits one hard constraint: only a seller-confirmed complete Catalog Product selection produces an authoritative identity or intake fact other contexts consume. The single carve-out is a named non-identity coverage signal, which creates no Catalog, Inventory, or listing fact.
- Vendor risk is bounded to an adapter. Pricing, coverage, and accuracy claims are advisory and dated, and none of them is load-bearing for shipped behavior.
- The cost is deliberate friction — a confirmation step per card that a pure-automation design would skip. That friction is the mechanism, not an oversight.
- Downstream contexts gain no new dependency from this record. Catalog, Inventory, Discovery, and Marketplace behavior is unchanged.

## Successor Ownership And Reopening Criteria

Successor ownership for the decisions this record deliberately does not make:

| Concern | Owner |
| --- | --- |
| First runtime slice: Scanning context package, `context.json` manifest, and local glossary, plus the scan session aggregate and lifecycle | [#4918](https://github.com/chase-sets/chase-sets/issues/4918) |
| Provider port, anti-corruption mapping, first adapter, authenticated probe — assumes the context paths #4918 creates | [#4917](https://github.com/chase-sets/chase-sets/issues/4917) |
| Catalog identity resolution and confirmation chips | [#4919](https://github.com/chase-sets/chase-sets/issues/4919) |
| Allowance and provider budget guard | [#4921](https://github.com/chase-sets/chase-sets/issues/4921) |
| Comparative provider qualification and go/no-go | [#4927](https://github.com/chase-sets/chase-sets/issues/4927) |
| Durable dispatch ledger, idempotency, spend reconciliation | [#4928](https://github.com/chase-sets/chase-sets/issues/4928) |
| Scan-image privacy, retention, deletion, vendor processing | [#4929](https://github.com/chase-sets/chase-sets/issues/4929) |
| Published Catalog-resolution and Inventory-intake contracts | [#4930](https://github.com/chase-sets/chase-sets/issues/4930) |
| Capture preflight and resilient mobile intake | [#4931](https://github.com/chase-sets/chase-sets/issues/4931) |
| Recognition feedback loop and safe model promotion | [#4932](https://github.com/chase-sets/chase-sets/issues/4932) |
| Parked self-hosted identification behind the same port | [#4925](https://github.com/chase-sets/chase-sets/issues/4925) |

Reopen this ADR when any of the following becomes true:

1. #4927 returns a no-go, or a qualification profile that makes advisory identification unusable at the tiers this record assumes.
2. An observed official provider fact changes materially: plan structure, credit cost, required tier, supported games, or the documented output fields.
3. Catalog registers Printing or Variant as first-class Product-variation terms, which would supersede the language rule above.
4. #4930 needs a confirmed-match fact to cross into a Catalog or Inventory write path in a shape this boundary does not allow.
5. The capability registry (#4410) or metered declarations (#4889) ship and an identification capability must actually be declared or priced.
6. #4918, the first runtime Scanning slice, lands and creates the context package, manifest, and local glossary, at which point the planned term family moves into that local glossary and this record's planned framing is replaced by the shipped one.

## References

- [Bounded Context Map](../../bounded-contexts/README.md) — planned Scanning registration and boundaries.
- [Marketplace Glossary](../GLOSSARY.md) — planned Scanning term family under Planned Term Ownership.
- `bounded-contexts/catalog/GLOSSARY.md` — Product identity, the Dimension and Option model, external references, and Provider Integration Profile.
- `bounded-contexts/inventory/docs/import-product-resolution.md` — review-first Import Batch resolution.
- `bounded-contexts/inventory/features/import-batches/ui/import-batch-page.tsx` — shipped per-row Product resolution drawer.
- `packages/design-system/src/components/forms/product-selection-fields.tsx` — canonical Option selection control.
- [Epic #4926](https://github.com/chase-sets/chase-sets/issues/4926) — card scanning capability.
- [Epic #7371](https://github.com/chase-sets/chase-sets/issues/7371) — planned ranked seller Product resolution that scanning reuses; the drawer and selection control it reuses are shipped.
