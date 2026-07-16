# Discovery Bounded Context

## Purpose

Discovery owns the browse, search, and detail experience for catalog items.

## Owns

- Search query behavior
- Search relevance and sort behavior
- Browse-oriented read models
- Filter state and facet presentation
- Catalog item detail presentation models
- Product Alerts created from product detail selection
- Add to List picker views projected from Collections facts
- Search index rebuild and projection workflows

## Search Suggestions

Header suggestions use bounded prefix matching against Discovery's existing `search_text_simple` vector, so the same
projected aliases used by full search also participate in typeahead. The final normalized token is matched as a prefix;
queries and result counts are capped, and only active items are eligible.

The slice deliberately does not enable `pg_trgm`: fuzzy spelling recovery would add an extension, a write-maintained
title index, and a second ranking policy without acceptance evidence that prefix and alias matching are insufficient.
That option remains available if observed zero-result telemetry demonstrates the need.

Latin diacritics are folded in application code before both weighted vectors and every lexical query are built, so
accented and unaccented spellings match symmetrically without a database extension. The fold is limited to Latin
combining marks so native CJK marks and the existing bigram behavior remain intact. Projection subscription version 7
replays Catalog facts to refresh existing Search Index rows with the folded text.

## Does Not Own

- Canonical catalog item truth
- Listing lifecycle or offer lifecycle
- Inventory availability truth
- Ordering, payment, or fulfillment decisions

## Ubiquitous Language

Discovery terminology is defined in [GLOSSARY.md](./GLOSSARY.md).
Dynamic search filter eligibility, priority, and URL contract are documented in [Dynamic Search Filters](./docs/dynamic-search-filters.md).
Google Shopping feed row mapping is documented in [Google Shopping Feed Mapping](./docs/google-shopping-feed-mapping.md).

## Core Models

- Discovery Query
- Search Index
- Search Result
- Result Set
- Filter State
- Detail Page

## Incoming Dependencies

- Catalog for canonical item, category, blueprint, dimension, and field facts
- Catalog resolved-alias facts (`catalog.catalog-item.aliases-resolved`) for alias-aware search matching
- Catalog resolved Product Contents facts (`catalog.product-contents.resolved`) for item-detail containment, reverse lookup, and optional content-aware search weighting
- Marketplace for future visibility or listing signals when browse behavior needs commercial state
- Collections for Saved List summaries rendered by Search and Item Detail Add to List controls

## Catalog Alias Search

Discovery search consumes the published Catalog resolved-alias fact (`catalog.catalog-item.aliases-resolved`, #1910) so an English query can find a non-English imported card and native-script queries stay searchable. Discovery consumes the stable fact only; it never calls provider APIs or reads alias candidates, provider profiles, or the alias review state machine. The search read model (`features/search/read-model`) owns this behavior.

- **Weighting.** Alias text folds into the `search_text` / `search_text_simple` tsvectors at type- and confidence-aware weights: official equivalent and exact set/series at the top tier (A, alongside the title), non-exact set/series and species at medium (B), provider-localized/literal at C, and romanization/generated at the lowest tier (D). Any generated-confidence alias is pinned to D. A `broad` alias is demoted one tier so a species name can never outrank an exact title or an official equivalent. Aliases never replace the title, subtitle, or slug; display is owned by item detail (#1914).
- **Cardinality.** Matches dedupe by `catalog_item_id` (one row per item), and broad aliases are down-weighted, so a high-fan-out alias text cannot flood or outrank specific matches.
- **Rollout kill-switch.** Alias contribution to search is gated by the `DISCOVERY_ALIAS_SEARCH` environment value (control id `discovery-alias-search-disabled`), mirroring the Catalog Integration Rollout Controls style. It defaults open. Setting it to a disabling value (`disabled`/`off`/`false`/`0`/`kill`) and rebuilding the search index drops alias text from `search_text` for every item with no code deploy; the resolved alias rows stay stored so re-enabling re-folds them on the next rebuild.
- **Removal propagation.** A revoked alias arrives as an empty (retracted) resolved fact for an `(item, language)`; Discovery removes that language's aliases from the source row, so the alias drops out of `search_text` both on the event and on a later rebuild (the rebuild reads the same source row). The item, its display identity, and its other-language aliases are unaffected.
- **Native-script (CJK) searchability.** The stock Postgres `simple` config emits one token for a whole contiguous CJK run, so substring search of native kana would not work and `pg_bigm`/`pgroonga` are not available in this stack. Discovery instead indexes overlapping character bigrams per CJK run and queries those bigrams, which makes native kana whole-run and substring search work under the `simple` config without a database extension. This lives in `features/search/domain/normalization.ts` and is proven by the acceptance test "keeps native Japanese kana queries searchable, including substrings".

## Product Alerts

Product Alert matching is documented in [Product Alerts](./docs/product-alerts.md). Discovery owns the subscription and matching behavior; Marketplace remains the source of Listing and Offer facts.

## Product Contents

Discovery consumes the published Catalog Product Contents fact (`catalog.product-contents.resolved`) for detail-page containment, "included in" reverse lookup, and content-aware search. Catalog owns the relationship, review state, Product Content Type configuration, inclusion policy configuration, and provider evidence. Discovery may weight and present the resolved lines, but it must not infer Product Contents from fields, tags, categories, Reference Record relationships, provider text, or external references.

## Search Embedding Enrichment

The Search Index owns a Discovery-local semantic embedding populated by an asynchronous platform-worker job. Projection handlers only build deterministic multilingual text hashes and mark changed rows dirty; external Voyage calls are prohibited from the serial projector. Provider choice, kill-switch behavior, backfill, capability checks, and rebuild preservation are documented in [Search Embedding Enrichment](./docs/search-embedding-enrichment.md).

Semantic retrieval candidates are evaluated before rollout with the checked-in golden-query harness documented in the same note. The DB-lane command compares lexical-only, semantic-fallback, and hybrid modes without Voyage or staging access and hard-fails exact/lexical regressions.

Runtime semantic retrieval is filter-respecting and fail-open: rescue is independently kill-switchable and hybrid fusion is an explicit opt-in. Query embeddings use the Voyage `query` input type and a bounded process-local cache; provider or vector-index failures preserve the lexical Result Set.

Item detail also uses the stored Search Embedding for a bounded **Similar Items** Result Set. This item-to-item path never calls an embedding provider at request time and falls back to active same-category peers when semantic retrieval is disabled, unavailable, or fails.

## Search Market Signals

The Search Index denormalizes buyer-visible `lowest_price_amount` and `visible_quantity` from Discovery's local
market projection. Listing creation, price and quantity changes, inventory holds, publication or delisting, account
availability, and Search Index rebuilds recompute these signals through the canonical buyer-visible listing predicate.
Both values are null when no listing is buyer-visible. Price Sort Orders keep those items after priced items in both
directions, with catalog item identity as the deterministic keyset tie-breaker; the in-stock Filter excludes them.

Listing count is intentionally not a secondary Relevance key. Commercial intent is expressed through explicit price,
availability, and market-activity Filters or Sort Orders while lexical and semantic match quality remains stable.

## Item Detail Rail Analytics

The simplified item-detail rail analytics contract is documented in [Item Detail Rail Analytics](./docs/item-detail-rail-analytics.md). Discovery owns the browser event vocabulary; the marketplace deployable owns capture and observability.

## Item Detail Discovery

Detail Pages use the first assigned category from Catalog's stable `category_ids` order as the primary category for
the visible breadcrumb and structured data. When no category is assigned, the visible breadcrumb links to Search and
the structured breadcrumb omits the category. Similar Items uses stored Search Embeddings when available and falls
back to active category peers; an empty Result Set is omitted. Product Contents and Included In relationships reuse
the same visual item-card treatment and preserve selected dimension options in their Detail Page links.

## Outgoing Integration Events

- None in the current extraction

## Invariants

1. Discovery is downstream and projection-oriented.
2. Discovery may reshape upstream facts for search and browse, but it does not take ownership of source transactions.
3. Search, filters, and item detail stay in one vertical slice so browse behavior is evolved together.
4. Discovery may preserve marketplace-branded public routes while still owning the implementation.
5. Public marketplace slugs are generated from natural-language display fields plus a stable entity id suffix, so names stay readable while collisions stay deterministic.
6. When a display name changes, the previous slug redirects to the current slug for that entity.
7. Product Contents search/detail behavior consumes only the resolved Catalog fact and does not own containment truth.

## Tests

Run `pnpm --filter @chase-sets/discovery run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/discovery run test` before opening a PR.

## Structure Notes

- `features/home` owns marketplace home merchandising composed from Discovery's existing category and search read models.
- `features/item-detail` and `features/search` keep their own slice-local runtime, projection, schema, query, route, and UI files.
- `features/saved-list-addition` owns the Collections-fed local picker projection and shared Add to List UI used by Search and Item Detail.
- Shared item-page client helpers stay inside Discovery because they are discovery-owned browse behavior, not shared infrastructure.
- Context-local reusable code should live under `support/*-support/` with purpose-specific names such as `client-support`, `item-support`, or `market-support`.

## Open Extraction Candidates

- Personalized recommendations can be extracted later if discovery evolves beyond shared browse behavior into account-specific ranking or merchandising workflows.
