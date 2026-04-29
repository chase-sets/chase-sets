# Migration Notes

## Ubiquitous Language Alignment

This greenfield migration intentionally made breaking route, read-model, and database naming changes so product language, internal model names, API contracts, and trader-facing labels stay aligned.

### Public Route Changes

- `/account/orders` became `/account/purchases`.
- `/account/orders/:orderId` became `/account/purchases/:purchaseId`.
- `/account/offers` became `/account/submitted-buyer-offers`.
- `/account/market-offers` became `/account/buyer-offer-matches`.
- `/account/reputation` became `/account/reviews`.
- `/account/fulfillment` was removed from trader navigation in favor of shipment and sale workflows.

These route changes do not include compatibility redirects or aliases.

### Model Language

- `Order` remains the Ordering aggregate and event-stream language.
- Buyer-facing order projections are `Purchase`.
- Seller-facing order projections are `Sale`.
- Marketplace `Buyer Offer` remains the aggregate language.
- Buyer-facing offer projections are `Submitted Buyer Offer`.
- Seller-facing offer projections are `Buyer Offer Match`.
- Seller stock is `Inventory Item`.
- Account review rollups are `Review Summary`.

Bounded-context and package names such as `ordering`, `fulfillment`, and `reputation` remain stable ownership boundaries.

### Database And Test Notes

Projection/read-model storage names now follow the aligned model language where practical. Database-backed tests provision unique per-test owner roles and database names to avoid parallel Postgres role contention while preserving context-specific extension setup.
