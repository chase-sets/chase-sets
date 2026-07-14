# Discovery Domain Glossary

This glossary defines the canonical terminology for the Discovery bounded context.

These terms must be used consistently across:

- Database schema
- APIs
- Events
- Backend services
- Frontend/UI
- Documentation

Avoid introducing synonyms. Each concept has exactly one canonical term.

## Discovery Concepts

### Discovery Query

A **Discovery Query** is the normalized set of search text, filters, sort order, and pagination inputs used to request catalog-item browse results.

Notes:

- Discovery Query is owned by Discovery.
- It shapes read behavior only; it does not mutate upstream state.

### Search Index

A **Search Index** is the projection-backed structure used to match and rank catalog items for discovery use cases.

Notes:

- Search Index is owned by Discovery.
- It is derived from upstream catalog facts.

### Search Result

A **Search Result** is a single projected catalog item returned for a Discovery Query.

Notes:

- Search Result is presentation-oriented.
- It may include denormalized names, tags, and images for browse speed.

### Result Set

A **Result Set** is the paginated collection of Search Results returned for a Discovery Query, including total-match metadata.

### Facet

A **Facet** is a discovery-oriented dimension of navigation used to summarize or refine a Result Set.

Examples:

- Category
- Tag
- Blueprint

### Filter

A **Filter** is a single browse constraint applied to a Discovery Query.

Examples:

- Category filter
- Tag filter
- Status filter

### Filter State

**Filter State** is the currently selected set of Filters that shapes the active Result Set.

### Sort Order

A **Sort Order** is the ranking mode used to order a Result Set.

Examples:

- Relevance
- Title ascending
- Title descending
- Newest
- Price ascending
- Price descending

### Relevance

**Relevance** is the ranking policy that orders Search Results by how well a catalog item matches the active Discovery Query.

Buyer-visible listing count is not a secondary Relevance key. Price and availability are explicit Filters and Sort
Orders so commercial state does not silently override text-match quality.

### Catalog Alias

A **Catalog Alias** is an alternate name for a catalog item that Discovery consumes from the published Catalog resolved-alias fact (`catalog.catalog-item.aliases-resolved`) to widen search matching.

Notes:

- Catalog owns alias truth, type, confidence, review state, and revocation; Discovery consumes only the stable resolved fact and never reads alias candidates, provider profiles, or alias internals.
- An alias adds matchable search text; it never replaces the title, subtitle, or slug. Display is owned by item detail (#1914).
- Alias text contributes at type- and confidence-aware weights so an official equivalent ranks high while a broad species name or generated translation ranks low and never outranks an exact title match.
- A `broad` alias (one alias text that fans out to many items, e.g. a species name) is down-weighted so it cannot flood or outrank specific matches; matches dedupe by `catalog_item_id`.

### Search Text Tokenization

**Search Text Tokenization** is how Discovery turns item and alias text into searchable lexemes for the `search_text` (English config) and `search_text_simple` (simple config) tsvectors.

Notes:

- Latin text uses the stock Postgres `english`/`simple` configurations.
- Native CJK scripts (e.g. Japanese kana) have no word boundaries, so Discovery indexes overlapping character bigrams per CJK run and queries those bigrams, making native-script substring search work under the `simple` config without a database extension.

### Search Embedding

A **Search Embedding** is the normalized semantic vector asynchronously enriched onto one Search Index row from deterministic multilingual Catalog display and classification facts.

Notes:

- Search Embeddings are Discovery-owned derived data, not Catalog truth.
- Projection handlers only mark a Search Embedding dirty by deterministic text hash; they never call an external embedding provider.
- Missing, disabled, or failed enrichment leaves lexical Discovery Query behavior unchanged.

### Hybrid Retrieval

**Hybrid Retrieval** is the Discovery relevance policy that combines lexical and semantic Search Result candidates while preserving exact-title and lexical/base-match precedence.

Notes:

- **Rescue** appends clearly labeled Closest Matches when a lexical Result Set contains fewer than three Search Results.
- **Hybrid** uses reciprocal-rank fusion over a bounded candidate window and is independently rollout-controlled.
- Both modes respect the complete Filter State and fail open to lexical retrieval.

### Similar Items

**Similar Items** is the bounded Result Set of active catalog items shown on a Detail Page because their stored Search Embeddings are nearest to the source item's stored Search Embedding.

Notes:

- Similar Items excludes the source item and never creates a query embedding.
- A small same-category bonus breaks close semantic ties after HNSW candidate selection.
- Disabled, missing, or failed semantic retrieval falls back to active same-category peers; no peers means the section is omitted.

### Product Contents

**Product Contents** is the Catalog-owned resolved fact that lets Discovery present what a container Product includes and find container Products from contained items.

Notes:

- Catalog owns Product Contents truth, Product Content Type configuration, Inclusion Policy configuration, review state, provider evidence, and cycle validation.
- Discovery consumes `catalog.product-contents.resolved` only.
- Discovery may use resolved content lines for item detail, reverse lookup, and content-aware relevance, but it must not infer Product Contents from fields, tags, categories, Reference Record relationships, provider text, or external references.

### Detail Page

A **Detail Page** is the discovery-owned presentation model used to render a single catalog item for browse and evaluation.

Notes:

- Detail Pages may show submitted Marketplace Offers as public product demand.
- Accepted Offers are no longer public product demand and should not remain visible as public offer rows.
- Public offer rows follow public listing attribution norms for account identity and must not expose shipping destinations or private contact details.

### Product Alert

A **Product Alert** is an account-owned watch on one resolved Catalog Product selected from a Discovery Detail Page.

Notes:

- Product Alert is owned by Discovery.
- Product Alerts reference `catalog_item_id`, `product_id`, and the normalized `selected_options` snapshot.
- Product Alerts may watch Listings at or below a maximum price, or limited Offer demand signals at or above a minimum price.
- Product Alerts notify through the web notification feed in the first implementation and remain active until paused or deleted.
