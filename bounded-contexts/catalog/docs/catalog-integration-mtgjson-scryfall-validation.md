# Catalog Integration MTGJSON And Scryfall Validation

This document records the final external-provider validation for MTGJSON and Scryfall.

## Result

Status: pass for architecture validation.

MTGJSON and Scryfall can be represented through Catalog Integration Control Plane extension points without adding provider-specific branches to Catalog runtime, API routes, Admin page logic, promotion/reapply code, or raw JSON authoring paths.

This is validation evidence, not production enablement. Live sampling, retained provider payloads, exported raw evidence, and production activation still require the provider-data governance and policy/legal review and approval described in [Catalog Integration Data Governance](./catalog-integration-data-governance.md).

## Current Provider Shape Checked

External provider checks were refreshed on 2026-06-08 against official provider surfaces:

- MTGJSON v5 set files and `SetList.json`: `https://mtgjson.com/api/v5/`
- Scryfall API card search, card detail, and bulk data: `https://scryfall.com/docs/api`
- Scryfall public bulk-data endpoint: `https://api.scryfall.com/bulk-data`

Observed validation facts:

- MTGJSON reported metadata version `5.3.0+20260605` for v5 JSON responses.
- MTGJSON `TSP.json` exposes set-level metadata plus card payloads with UUIDs, collector numbers, finishes, identifiers, text, layout, rarity, and Scryfall IDs.
- Scryfall card search for `Fury Sliver` returned print-level card payloads including card ID, oracle ID, set code/name, collector number, rarity, image status, image URIs, pricing links, and prints search links.
- Scryfall bulk data returned public bulk datasets, including `default_cards`, updated on 2026-06-08.

## Integration Units

The validation uses the ingestion-unit identity model from [Catalog Integration Control Plane](./catalog-integration-control-plane.md):

| Unit | Purpose | Provider Shape |
| --- | --- | --- |
| `mtgjson:mtg:single-card:reference-data` | Card-print reference data | Bulk/file-oriented set JSON with selected card payloads |
| `mtgjson:mtg:set:reference-data` | Set reference data | Bulk/file-oriented set and set-list JSON |
| `scryfall:mtg:single-card:reference-data` | Card-print reference data | Live card API/search payloads and bulk card records |
| `scryfall:mtg:single-card:image-evidence` | Image evidence | Scryfall card image URI payloads and image status |

Raw/foil/nonfoil, language, print variant, image variant, and condition/certification are not separate ingestion units by default. They remain Catalog semantic facts or evidence unless a later provider shape requires materially different promotion, replay, duplicate-prevention, or lifecycle behavior.

## Files Touched

Validation was added through allowed extension points:

- `features/source-observations/api/provider-adapters/mtgjson.ts`
- `features/source-observations/api/provider-adapters/scryfall.ts`
- `features/source-observations/api/provider-adapters/provider-adapter.test.ts`

The no-core-change guard covers these core paths:

- `features/source-observations/api/runtime.ts`
- `features/source-observations/api/route.ts`
- `features/source-observations/api/route-helpers.ts`
- `features/source-observations/ui/workbench-shell.tsx`
- `features/source-observations/ui/integrations-surface-page.tsx`
- `features/source-observations/ui/workbench-workspace-renderers.tsx`
- `features/source-observations/ui/admin-control-plane/`
- `features/source-observations/api/provider-integration-profiles.ts`

The guard verifies the final MTGJSON/Scryfall validation units do not appear as runtime, route, Admin UI, profile, promotion/replay, or raw JSON authoring branches.

## Adapter Validation

MTGJSON validation proves:

- integration unit listing for single-card and set reference data;
- set and card option queries through the adapter boundary;
- import planning for set file plus card selection;
- deterministic payload envelopes with provider key, unit key, external key, source URL, fetched timestamp, source-updated timestamp, and content hash;
- Catalog Integration Engine dry-run normalization into Source Observation facts.

Scryfall validation proves:

- integration unit listing for card reference data and image evidence;
- card search and bulk-data option queries through the adapter boundary;
- import planning for card reference and image-evidence payloads;
- deterministic payload envelopes with card/image external keys, image URI evidence, provenance, and content hash;
- Catalog Integration Engine dry-run normalization into Source Observation facts.

## Source Conflict Scenario

The validation includes a deterministic MTGJSON/Scryfall source-to-source conflict scenario for card-print rarity. The MTGJSON observation keeps the provider identity, external key, and provenance from the validation payload, then deliberately uses a stale/conflicting rarity value so the field-precedence policy can be exercised without claiming current live provider disagreement.

| Field | Winner | Losing Evidence | Rule |
| --- | --- | --- | --- |
| `rarity` | Scryfall value `uncommon` | MTGJSON stale validation value `special` | `field-precedence.mtg-card-print.v1` |

Explanation: Scryfall print data wins the card-print rarity conflict because the validation policy treats Scryfall as the primary print-facing source for current card print metadata. MTGJSON retains the losing source value, source observation identity, and external key as audit evidence for operator review. The adapter does not decide the winner; it only exposes source facts and provenance.

## Production Enablement Limits

The validation intentionally does not register MTGJSON or Scryfall in the production Source Observation runtime registry. Production enablement requires:

- governed provider payload sampling and fixture retention approval;
- provider attribution and terms/policy review and approval;
- profile section activation readiness for the selected production units;
- provider option query caching/backpressure configuration for live operator use;
- release plan go/no-go evidence.
