# Scrydex Extensibility Profile Plan

## Goal

Ship issue #632 by proving the Catalog provider mapping framework can ingest a Scrydex/Scryfall-style card payload without adding provider-specific runtime branches.

## Current Shape

- Catalog provider profiles are versioned in `provider-integration-profiles.ts`.
- Executable mapping contracts normalize provider payloads through `provider-source-observation-normalizer.ts`.
- Duplicate prevention already prefers exact external Catalog Item references before field matching.
- The existing external reference strategy treats TCGplayer Product IDs as Catalog Item references with `providerKey: "tcgplayer"` and `externalKey: "product:<id>"`.

## Implementation

1. Add a Scrydex/Scryfall-style executable mapping contract that:
   - is fixture-backed and `test` lifecycle only;
   - uses `provider-product` normalized observations for the proof;
   - maps card name, set name, collector number, language, image URLs, and Scryfall URI evidence;
   - maps `tcgplayer_id` to the same TCGplayer `product:<id>` external Catalog Item reference used by TCGplayer automation;
   - excludes pricing, inventory, seller, and live provider behavior from Catalog truth.
2. Register a planned Scrydex profile and version record in the provider catalog:
   - no live transport adapter;
   - no provider-specific interpreter branch;
   - duplicate prevention starts with exact external Catalog Item reference matching and keeps bridge evidence review-only.
3. Add tests that prove:
   - the profile is discoverable and validates as an executable test profile;
   - fixture payloads normalize through the generic normalizer;
   - `tcgplayer_id` bridges to existing Catalog Items through existing exact-reference matching;
   - no runtime provider-specific branch is required.
4. Update provider mapping docs to explain the Scrydex/Scryfall proof and its TCGplayer Product ID bridge.

## Verification

- Focused source-observation API tests covering profiles, normalization, external references, and duplicate prevention.
- Catalog unit tests if focused tests are clean.
- Typecheck, localization check, formatting check, and `git diff --check`.

## Non-Goals

- No live Scrydex/Scryfall transport adapter.
- No Magic-specific Catalog aggregate model in this issue.
- No Catalog promotion command execution for Scrydex observations.
- No pricing, inventory, or marketplace offer ingestion.
