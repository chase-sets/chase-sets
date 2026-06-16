# Catalog Alias Vocabulary And Ownership ADR

## Status

Accepted. This ADR locks the Catalog Alias vocabulary, resolves the pre-existing `alias` term overload, and assigns bounded-context ownership for alias facts. It is the foundational slice of the Catalog Integration Aliases & Translation Equivalence milestone. Code carries the renames and the model through subsequent slices (`#1904` and beyond).

## Purpose

Aliases and translations are becoming first-class Catalog integration facts. A `Catalog Alias` records that one piece of text refers to a Catalog Item: an official English equivalent, a literal translation, a provider-localized name, a species name, a romanization, or a generated translation. This ADR establishes the language so these distinct ideas are never conflated again, and so Discovery can consume published alias facts without importing Catalog authoring policy or provider semantics.

Catalog already owns canonical item truth, Source Observations, Reference Records, Provider Integration Profiles, promotion, Display Templates, and Resolved Display Identity. The alias model follows the Resolved Display Identity pattern: Catalog publishes stable downstream facts; Discovery consumes them.

## Decision: Resolve The `alias` Overload Before Adding A Third Meaning

The token `alias` is already used in two unrelated senses in `bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts`:

1. `CatalogProviderOptionQuery.aliases` — alternate keys for resolving an option query. For example, the query whose `queryKind` is `"languages"` also answers to `"language"`, and `"product-lines"` also answers to `"product-line"` and `"categories"`. These are synonyms for the query key.
2. `CatalogProviderSelectedOptionAliasMapping` / `optionAliases` — provider value to canonical option-key synonyms. For example, the provider values `"Holo"` and `"Foil"` both map to the `"holofoil"` option key, and `"Near Mint"`, `"Near-Mint"`, and `"NM"` all map to `"near-mint"`. These are synonyms for an option value.

Adding `Catalog Alias` as a third meaning of `alias` without resolving these two re-creates exactly the conflation this milestone exists to remove. Breaking the contract is acceptable here because the system is greenfield and anti-entropy is encouraged.

### Locked rename (implemented by `#1904`)

| Current name                                  | Renamed to                                 | What it means                                                        |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `CatalogProviderOptionQuery.aliases`          | `CatalogProviderOptionQuery.queryKeySynonyms` | Alternate keys that resolve to the same provider option query.      |
| `CatalogProviderSelectedOptionAliasMapping`   | `CatalogProviderSelectedOptionValueSynonym`   | One mapping of provider value text to a canonical option key.        |
| `CatalogProviderSelectedOptionDimensionMapping.optionAliases` | `CatalogProviderSelectedOptionDimensionMapping.valueSynonyms` | The list of provider value to option key synonyms for a dimension. |

Both renamed concepts are deterministic provider configuration: they say "treat this provider key or value as that canonical key." They are not Catalog Aliases. A Catalog Alias is reviewable item-level evidence that a piece of text refers to a Catalog Item, with a type, a confidence, and a review status. Keeping all three terms distinct is the point of this ADR.

After the rename, the word `alias` and the term `Catalog Alias` are reserved exclusively for the new translation and equivalence concept across the Catalog context.

## Decision: Catalog Owns Alias Facts, Discovery Consumes Them

Aliases belong to Catalog for the same reasons Resolved Display Identity does:

- An alias is a claim about a Catalog Item's identity and naming. Catalog already owns item identity, provider evidence intake through Source Observations, and the source-governance policy that decides which evidence is trustworthy.
- Auto-accept, confidence, review status, source precedence, and revocation are authoring and governance decisions. They depend on Catalog's provider semantics and the source-governance and auto-accept policy (`#1912`).
- Discovery owns search projection and relevance, not the truth of whether `"Dracaufeu"` is an accepted French equivalent of Charizard. Discovery must not re-derive that from raw provider data.

Catalog publishes only accepted, downstream-relevant alias facts. Discovery consumes those facts and applies its own search weighting and dedupe. Discovery never imports Catalog authoring policy, provider profiles, alias review state machines, or `Alias Candidate` records.

This mirrors the Resolved Display Identity boundary: internal authoring and review events stay in Catalog; only the stable item-level fact crosses the context boundary.

## Alias Types

Translation is one kind of alias, not the whole model. The initial `Alias Type` set:

- `official-equivalent` — the publisher's own equivalent name in another language or market (for example the official French card name). The strongest non-identity equivalence.
- `provider-localized-name` — a name a governed provider uses for the item in a given locale, which may differ from the official equivalent.
- `species-name` — a shared creature or species name that legitimately maps to many items (for example every Pikachu printing).
- `literal-translation` — a human or dictionary translation of the canonical name that is not necessarily the official equivalent.
- `romanization` — a script transliteration such as romaji for a Japanese name.
- `generated-translation` — a machine-generated translation, always lower trust and never auto-accepted.
- `set-equivalent` — an alias asserting that a provider set or expansion name corresponds to a Catalog expansion (for example a Japanese expansion name for an English expansion).
- `series-equivalent` — an alias asserting that a provider series name corresponds to a Catalog series.

`set-equivalent` and `series-equivalent` operate at the Reference Record level (expansion and series), not the individual card. The remaining types operate at the Catalog Item level.

## Alias Confidence

`Alias Confidence` records how trustworthy the alias is, independent of its type:

- `exact` — backed by an exact, governed identifier match (for example a shared official identifier across language editions).
- `high` — strong governed-source evidence short of an exact identifier match.
- `candidate` — plausible but unverified; requires review before it can be trusted downstream.
- `generated` — produced by automated translation; lowest trust.
- `manual` — asserted by an operator during review; trust comes from the reviewer, not a source identifier.

Confidence and type are orthogonal. A `literal-translation` may be `manual` or `generated`; an `official-equivalent` is typically `exact` or `high`.

## Alias Review Status

`Alias Review Status` is the lifecycle of an alias from candidate to published fact:

- `pending` — an `Alias Candidate` awaiting human review.
- `accepted` — reviewed and approved; eligible for downstream publication.
- `rejected` — reviewed and refused; never published, retained as evidence so the same candidate is not re-surfaced.
- `auto-accepted` — promoted to accepted by policy without human review, only for type and confidence combinations the source-governance and auto-accept policy (`#1912`) permits.
- `revoked` — a previously `accepted` or `auto-accepted` alias later withdrawn because evidence changed or a reviewer reversed the decision. Revocation is distinct from `rejected`: `rejected` was never trusted; `revoked` was trusted and is being unwound, which triggers downstream removal.

## Cardinality Rules

- One alias text may map to many Catalog Items. `species-name` is the canonical example: `"Pikachu"` legitimately maps to every Pikachu printing, alt art, and regional variant.
- One Catalog Item may carry many aliases across languages, providers, and types.
- Therefore aliases form a many-to-many relationship between alias text and Catalog Items, scoped by `Alias Type`, language, and source.

### Interaction with search weighting and dedupe

A broad alias must not flood search results. Catalog publishes the cardinality signal with the fact so Discovery can weight and dedupe:

- Catalog records how many Catalog Items an alias text resolves to. High-fan-out aliases (for example species names) are marked as broad.
- Discovery down-weights broad aliases relative to specific aliases and the resolved display identity, so a species-name match never outranks a precise item match.
- Discovery dedupes by `catalog_item_id`, not by alias text, so one item matched through several of its aliases appears once.
- An alias never replaces the Resolved Display Identity as the primary label. Aliases add matchable text and may surface as "also known as" context; they do not rename the item.

## Revocation And Decay Semantics

Aliases are reviewable facts, so they can be withdrawn. Catalog defines what happens downstream:

- When an `accepted` or `auto-accepted` alias becomes `rejected` or `revoked`, Catalog publishes an alias-removed fact for that alias and Catalog Item.
- Discovery removes the alias from its search projection for that item and recomputes relevance. The item itself, its Resolved Display Identity, and its other aliases are unaffected.
- If provider evidence that backed an auto-accepted alias changes or disappears, the alias decays: Catalog moves it from `auto-accepted` back to `pending` (re-review) or to `revoked` (withdraw), per the source-governance and auto-accept policy (`#1912`). It does not silently remain trusted on stale evidence.
- Revocation and decay are idempotent and publish only changed facts, consistent with the Reusable Derived-Fact Pattern in [Catalog Resolved Display Identity](./resolved-display-identity.md).

## Auto-Accept Boundary

This ADR states which alias types and confidences may be auto-accepted and which must stay `pending`. The source-precedence and tiebreak order that resolves conflicting evidence is owned by the source-governance and auto-accept policy (`#1912`), decided alongside this ADR rather than afterward.

Eligible for `auto-accepted` (subject to `#1912` source precedence):

- `official-equivalent` at `exact` confidence, when backed by a governed source identifier match.
- `set-equivalent` and `series-equivalent` at `exact` confidence, when backed by a governed reference identifier.

Must remain `pending` for human review:

- Any `generated-translation`, and anything at `generated` confidence, without exception.
- `literal-translation`, `romanization`, `species-name`, and `provider-localized-name` at any confidence below `exact`.
- Any alias whose governed sources disagree on the equivalent. The conflict is surfaced for review using the precedence and tiebreak order in `#1912`; it is never auto-resolved here.

## English Evidence Rule: TCGdex `id` Is Indonesian

The TCGdex `id` field is the Indonesian-language value, not an English value. It must never be used as English evidence for an `official-equivalent` or any English alias. Treating `id` as English would silently inject Indonesian text as the canonical English name. Alias intake from TCGdex must read the explicit English locale, not `id`. This is recorded here so every alias-producing slice inherits the rule.

## Edge Cases

- **Japanese split sets versus English combined sets.** A single English expansion may correspond to several Japanese sets, and vice versa. `set-equivalent` is many-to-many and must allow one Catalog expansion to carry multiple Japanese `set-equivalent` aliases without asserting a single canonical mapping.
- **Promos with no English equivalent.** Some items have no official English name. They may carry non-English aliases without an `official-equivalent`. Absence of an English equivalent is a valid state, not a defect to backfill with a guess.
- **Trainer and Energy cards without dex IDs.** Equivalence cannot rely on a national dex number for these. Alias evidence falls back to governed name and set matching; species-name does not apply.
- **Reprints.** The same name across reprints is expected. Aliases attach to Catalog Items, and one alias text mapping to many reprints is the documented many-to-many case, not a duplication bug.
- **Language-specific names.** Aliases carry their language so the same item can hold distinct French, German, and Japanese names without collision. Language is part of alias identity.
- **Conflicting official equivalents from different governed sources.** When governed sources disagree, the alias stays `pending` and the conflict is resolved using the source-precedence and tiebreak order in `#1912`. This ADR does not pick a winner.
- **Generated translation risk.** `generated-translation` is never auto-accepted, is always lower confidence, and is clearly distinguishable downstream so a machine translation is never mistaken for an official equivalent.

## Delivery Map

This ADR is slice one. The remaining milestone slices build on the locked vocabulary:

1. **This ADR and glossary (`#1903`).** Vocabulary, ownership, rename decision, types, confidence, review states, cardinality, revocation, edge cases. Docs only.
2. **Legacy rename (`#1904`).** Apply `queryKeySynonyms` and `valueSynonyms`/`CatalogProviderSelectedOptionValueSynonym` through code, fixtures, and contracts so `alias` is freed.
3. **Source-governance and auto-accept policy (`#1912`).** Source precedence, tiebreak order, and the auto-accept rules this ADR points to.
4. **Catalog Alias model and storage.** The `Catalog Alias` and `Alias Candidate` read models, the review state machine, and the published alias fact, following the Resolved Display Identity derived-fact pattern.
5. **Alias intake from providers.** Producing `Alias Candidate` records from governed Source Observations, honoring the English-evidence rule and confidence assignment.
6. **Discovery consumption.** Consuming published alias facts into search projection with broad-alias weighting and dedupe, and handling alias-removed facts.

## One-Line Summary

A `Catalog Alias` is reviewable item-level evidence that a piece of text refers to a Catalog Item, typed and confidence-scored and review-gated; it is distinct from the renamed `queryKeySynonyms` (provider query-key synonyms) and `valueSynonyms` (provider option-value synonyms), it is owned and published by Catalog, and it is consumed but never re-derived by Discovery.
