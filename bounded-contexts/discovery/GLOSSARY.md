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

### Relevance

**Relevance** is the ranking policy that orders Search Results by how well a catalog item matches the active Discovery Query.

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
