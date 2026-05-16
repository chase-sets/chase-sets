# Pokemon English Reference Seeding and TCGdex Mapping

## Intent

Update Catalog seeding so English Pokemon TCG catalog facts use rich Reference Records for reusable hierarchy instead of repeating expansion and series facts on every Catalog Item. Update the TCGdex Source Observation integration so provider language such as `set` is mapped into official Pokemon-facing language such as `Expansion`, and promoted items point at the seeded or imported reference hierarchy.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-pokemon-reference-seeding`
- Branch: `codex/pokemon-reference-seeding`
- Base: `origin/main`
- Sandbox doctor: passed, port base `7900`
- Dependency install: `pnpm run deps:install` passed

## Owning Context

Catalog owns the complete change:

- `Reference Type` and `Reference Record` are Catalog concepts.
- Source Observations and TCGdex import/promotion are Catalog-owned.
- Blueprints, Components, Fields, and Catalog Items are Catalog-owned authoring behavior.
- Discovery should continue to consume enriched Catalog Item projections and searchable field/reference detail; no new Discovery ownership is required unless verification exposes a projection gap.

## Language Decisions

Official Pokemon sources checked during planning:

- Pokemon.com expansion pages and current news use `expansion` for Pokemon TCG releases.
- Pokemon Support's Trading Card Game database help uses card-search terms including `Card Name & Keyword`, `Expansion`, `Rarity`, and `Card Illustrator`.
- Official Pokemon card checklists use `standard set`, `standard set foil`, and `parallel set`.
- The Pokemon Company press site uses `Pokemon Trading Card Game (TCG)` and names the new `Mega Evolution Series`.

Provider-to-Catalog mapping:

- TCGdex `set` -> Catalog `Expansion`.
- TCGdex `serie` -> Catalog `Series`.
- TCGdex `variants.reverse` -> Catalog `parallel-set` availability/fact, with UI copy `Parallel set`.
- TCGdex `illustrator` -> Catalog field `Card Illustrator`.
- TCGdex `category` stays provider/source-observation metadata unless a future official card-kind model is needed.

## Reference Model

Seed these Pokemon English reference layers:

- `Manufacturer`
  - Seed `The Pokemon Company International` as the English market publisher/manufacturer reference.
- `Product Line`
  - Seed `Pokemon Trading Card Game` / `Pokemon TCG`, related to Manufacturer by `published-by`.
- `Series`
  - Seed known English Pokemon TCG series needed by demo data and imported TCGdex records, related to Product Line by `part-of`.
- `Expansion`
  - Seed demo expansions with card count, release date, abbreviation where known, provider/source IDs where available, and a `part-of` relationship to Series.

Catalog Item fields:

- Replace the seeded `Set Name` field with `Expansion`.
- Make `Expansion` a `reference` value field.
- Keep item-specific fields such as Card Number, Card Name, Rarity, Card Illustrator, Release Year, HP, and attacks on the item or future card-detail components.
- Keep Release Year for sealed products and legacy browsing only if still useful, but do not duplicate expansion release date onto every imported item when the expansion reference carries it.

## Implementation Checklist

- Add stable seed IDs for Reference Types and Pokemon English Reference Records.
- Add a Catalog seed module for Pokemon English reference data and invoke it before Components, Blueprints, and Catalog Items.
- Update seeded Fields, Components, Blueprints, and Catalog Items to use `Expansion` as a `reference` field.
- Update TCGdex normalization to emit official-language expansion/series reference candidates alongside provider IDs and source metadata.
- Add promotion-time reference resolution/creation:
  - Ensure Product Line and Manufacturer references exist.
  - Ensure or update Series from TCGdex `serie`.
  - Ensure or update Expansion from TCGdex `set`, release date, abbreviation/logo metadata when present, and relationship to Series.
  - Set the promoted Catalog Item's Expansion field to `{ referenceId }`.
- Map `variants.reverse` to `parallelSet: true` or equivalent official-language normalized metadata without exposing `reverse holo` as Catalog terminology.
- Update source observation UI/localized copy from `Set` where it refers to Pokemon release grouping to `Expansion`.
- Add focused tests for seed shape, TCGdex normalization, and promotion reference field assignment.
- Run targeted tests and a full type/test pass where practical.

## Acceptance Criteria

- Seeded Pokemon English catalog data can express `Expansion -> Series -> Product Line -> Manufacturer`.
- Seeded items and promoted TCGdex items set the `Expansion` reference field, not free-text `Set Name`.
- Source Observation import still accepts TCGdex `setId`, but Catalog-facing normalized data and UI copy use `Expansion`.
- TCGdex variant data maps `reverse` to official `Parallel set` terminology.
- Search/discovery detail can use the existing enriched reference projection for the new hierarchy.
- Tests cover the new mappings and promotion behavior.

## Open Questions

No blocking questions. The repo already has a hierarchy-capable reference model and the request explicitly prefers official Pokemon terms, so the implementation will use the official-language mapping above.
