# Bulk Reprice Ingestion

This feature is the removable m113 bulk-reprice on-ramp. It owns CSV and
JSON ingestion, durable-job orchestration, diff-first suppression against
Pricing's listing input projection, per-row outcomes, results CSV generation,
the upload UI, and every feature-specific policy dial.

The feature calls two stable ports and does not recreate either one:

- Marketplace's bulk listing-price update port owns chunked appends,
  per-account terms sessions, conflict isolation, and the domain no-op
  backstop.
- Inventory's account seller-SKU resolution port owns native-SKU mapping.

## Removal boundary

No other feature slice may import this feature directory. Product exposure is gated
by `pricing.bulk-reprice-ingestion.enabled` at the single API mount in
`bounded-contexts/pricing/api.ts`; disabling it hides the entire route tree.
The Pricing composition root may import this directory only to assemble its
schema, runtime, API, route adapter, and cross-context ports. The repo-wide
guard in `bounded-contexts/pricing/tests/bulk-reprice-ingestion-removability.test.ts`
fails if another slice or an undocumented composition seam imports it.

Removal is deliberately mechanical: delete this directory, delete the one
`app.route("/account/bulk-reprice", ...)` product-mount line, then remove the
guard-listed composition references that TypeScript reports. The permanent
Marketplace chunked-append, terms-session, and no-op machinery must remain.

The optional `storageLocationId` CSV/API disambiguator and resolved-location
result column are owned by the multi-location contract slice #4366. They must
be added here, without changing the dependency direction, when #4364 permits
the same seller SKU at multiple locations.
