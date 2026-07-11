# Identifier Conventions

This document is the single written contract for how Chase Sets mints, parses, names, and shares identifiers. It closes milestone [Identifier Integrity & Boundary Hardening (#95)](https://github.com/chase-sets/chase-sets/issues/3917): the underlying conventions were already load-bearing in code; this page and its linked guards are what stop them from drifting silently.

## Branded Typed IDs

Canonical identity is a branded ULID: `TypedUlid<Prefix>` is the template-literal type `` `${Prefix}_${Ulid}` ``, defined once in [contracts/primitives/typed-ids.ts](../../contracts/primitives/typed-ids.ts). Every domain ID (`AccountId`, `OrderId`, `CatalogItemId`, and so on) is a `TypedUlid<Prefix>` with its own short prefix.

Mint and parse only through the two functions that own the format:

- `createId(prefix)` mints a new `TypedUlid<Prefix>` from a cryptographically strong ULID.
- `parseTypedId(value, prefix)` validates and narrows an untyped string into a `TypedUlid<Prefix>`.

Do not hand-construct a prefixed string or reach for a bespoke ID generator. `createInternalId(prefix)` is the sibling for identifiers that never need ULID ordering (`InternalId<Prefix>`, format `` `${Prefix}_${string}` ``); it is crypto-backed (`crypto.randomUUID`, with a `crypto.getRandomValues`-based UUIDv4 fallback) rather than `Math.random`-backed, so internal IDs stay unguessable even outside the sortable-ULID family.

## Parsing At Trust Boundaries

Request-sourced values (HTTP bodies, route params, query strings, MCP tool arguments) are `unknown` until they cross a boundary helper. Casting them straight to a branded ID type (`value as OrderId`) skips validation and lets malformed or malicious input silently acquire a typed identity.

Use the boundary parsers instead of `as <Something>Id`:

- HTTP: `parseTypedIdBoundary`, `parseOptionalTypedIdBoundary`, `parseTypedIdArrayBoundary` in [contracts/http/typed-id.ts](../../contracts/http/typed-id.ts). Each throws a `TypedIdBoundaryDomainError` (400, structured validation body) on a malformed value.
- MCP: `readMcpTypedIdArgument` and `readOptionalMcpTypedIdArgument` in [infrastructure/platform-runtime/mcp.ts](../../infrastructure/platform-runtime/mcp.ts), which delegate to the same HTTP boundary parser.

[scripts/typed-id-boundary-guard.test.mjs](../../scripts/typed-id-boundary-guard.test.mjs) statically scans every `bounded-contexts`, `deployables`, and `infrastructure` route/HTTP/MCP module for an `as <Something>Id` assertion applied to a request-sourced expression and fails the build if it finds one. New boundary code should call a boundary parser; it never needs a new or duplicate guard.

## Cross-Context Typed ID References

A typed ID has exactly one owning context — the context whose commands mint it. Downstream contexts import that context's ID type instead of minting a parallel one or widening the field to `string`.

The order-id chain is the exemplar: **Ordering** mints `OrderId` when it creates an `Order`. **Fulfillment** references the same `OrderId` on every `Shipment` row. **Payments** references the same `OrderId` on every payment page. None of the three contexts re-derives or re-mints its own order identifier — they all import `OrderId` from the shared contract and treat Ordering as the single source of truth for what an order is.

The full list of shared cross-context IDs, and the contexts that own IDs locally (Catalog's `DimensionId`/`OptionId`/`FieldId`/etc.), lives in [Bounded Context Structure → Shared Typed IDs](./bounded-context-structure.md#shared-typed-ids) so the list is maintained in one place. `CatalogItemId` is the one Catalog-owned ID reused across contexts (Fulfillment, Inventory, Marketplace, Ordering); each of those contexts imports it from `contracts/primitives/typed-ids.ts` rather than typing the field as a bare `string`.

## Field Naming: camelCase vs. snake_case

**TypeScript and JSON — including HTTP request/response bodies, MCP tool arguments, domain commands, and event payloads — use camelCase.** `catalogItemId`, `dimensionId`, `orderId`, and `selectedOptions` are the correct field names on anything a client, agent, or event consumer reads.

**SQL columns and other durable wire storage — Postgres schemas, JSONB row shapes, generated read-model rows — use snake_case.** `catalog_item_id`, `dimension_id`, `order_id` are the correct column names inside `schema.ts` DDL and hand-mapped row readers.

Naming never crosses that line: an API or event field is never snake_case, and a SQL column is never camelCase. A prior version of the Catalog glossary's "API Guidance" section listed snake_case field names under an API heading; that was a naming-scope error, not an intentional API convention — Catalog's actual API and event payloads use camelCase (`catalogItemId`, `productId`, `dimensionId`), and the snake_case forms only ever named SQL columns. See [bounded-contexts/catalog/GLOSSARY.md](../../bounded-contexts/catalog/GLOSSARY.md) for the corrected scope.

The one deliberate exception is UCP (Universal Commerce Protocol) request parsing, which accepts either casing for agent-commerce interop at that one external boundary — it still normalizes internally to camelCase before the value reaches domain code.

## Natural-Key Normalization

Contexts that ingest externally sourced natural keys (provider set codes, card numbers, language tags, provider identifiers) normalize each key exactly once, at ingest, before the value is persisted or used for identity/duplicate-prevention. Normalization is per-field, not a single blanket transform, and it never rewrites already-persisted historical keys — only new observations and replayed mapping output.

Catalog's contract is the reference implementation: `catalogNaturalKeyNormalizationContract` in [bounded-contexts/catalog/features/source-observations/domain/domain.ts](../../bounded-contexts/catalog/features/source-observations/domain/domain.ts) pins the normal form for `setCode`, `cardNumber`, `collectorNumber`, `languageCode`, `providerKey`, and `externalKey` (trim/lowercase, unpadded numeric forms, canonical BCP-47, and so on). Any other context normalizing an externally sourced natural key should follow the same shape: a named, versioned, per-field contract next to the domain module that owns ingest, guarded by a test that pins the normal form.

Discovery's `/search` structured set-code + collector-number query (`parseStructuredNaturalKeyQuery` in [bounded-contexts/discovery/features/search/domain/structured-natural-key-query.ts](../../bounded-contexts/discovery/features/search/domain/structured-natural-key-query.ts)) and the `/sets/:setSlug` expansion/set browse page (below) both re-derive this same normal form rather than importing Catalog at runtime — Discovery does not depend on Catalog at runtime, only in tests, so the rules are re-implemented and kept in sync by hand.

### Set/expansion browse pages are addressed by the reference-record natural key

`/sets/:setSlug` is a natural-key address, not an opaque slug: the URL path segment is the set/expansion reference record's own normalized `key` (game + set code, for example `surging-sparks`), run through `createSlugBase` for URL-safety — not a display-title-derived slug with a ULID hash suffix like listings, accounts, and item-detail pages use. Only reference records whose `typeKey` is set-like (`SET_LIKE_REFERENCE_TYPE_KEYS` in [bounded-contexts/discovery/support/item-support/reference-records.ts](../../bounded-contexts/discovery/support/item-support/reference-records.ts) — today `set` and `expansion`) are addressable this way; every other reference type keeps an empty slug and has no browse page.

The reference record's ULID (`referenceId`) stays canonical internally — the slug only ever *addresses* it, the same "natural keys are addressing, not identity" rule as the structured search query above. If a set's natural key is revised, the projection remembers a redirect (`discovery_slug_redirects`, `entityKind: "reference-record"`) so the old URL 301s to the new one, reusing the same slug-redirect machinery proven on listings, accounts, and item detail.

## Product Identity Is A Derived Key, Not A Minted ID

Product identity is the tuple `(catalogItemId, selectedOptions)`. A Product is not an independently persisted aggregate and does not have a first-class minted `ProductId`.

`ProductKey`, defined in [contracts/primitives/catalog-identity.ts](../../contracts/primitives/catalog-identity.ts), is the deterministic scalar derived from that tuple. It is a display and lookup key, not standalone identity — do not treat it as mintable, and do not `createId`/`parseTypedId` it. Existing API, storage, and append-only event payloads keep the historical field name `productId`; at the type level that field carries `ProductKey` so its derived role is explicit without renaming durable wire data.

## Provider-Scoped External Uniqueness

An externally issued reference (a payment processor's reference id, a postage provider's label id) is only unique *within its issuing provider*. A uniqueness constraint on the bare reference is a latent collision across providers, even when only one provider is integrated today.

Qualify uniqueness by the provider/processor identity:

- Payments: `payments_payment_pages` enforces `UNIQUE (processor_name, processor_payment_kind, processor_payment_reference)` — see [bounded-contexts/payments/features/payments/read-model/schema.ts](../../bounded-contexts/payments/features/payments/read-model/schema.ts).
- Fulfillment: `fulfillment_shipment_pages` enforces `UNIQUE (postage_provider_name, postage_provider_label_id) WHERE postage_provider_label_id IS NOT NULL` — see [bounded-contexts/fulfillment/features/shipments/read-model/schema.ts](../../bounded-contexts/fulfillment/features/shipments/read-model/schema.ts).

New provider-facing external reference storage should follow the same shape: qualify the unique index by provider/processor name plus whatever reference-kind discriminator applies, never the bare reference alone.

## Tenant-Free Checkpoint Keys

Projection checkpoint keys (`createCheckpointKey`) are single-tenant row identities: `<projectionName>:<sourceContextName>:v<subscriptionVersion>`. They carry no tenant qualifier because the event store itself is not tenant-partitioned.

[infrastructure/bounded-context-runtime/subscription-store.test.ts](../../infrastructure/bounded-context-runtime/subscription-store.test.ts) pins this assumption against the live event-core schema (no `PARTITION BY`, a single `global_position bigserial PRIMARY KEY`, and no `tenant` column on `event_projection_checkpoints`) and fails loudly if the event store is ever tenant-partitioned without a matching checkpoint-key migration. Do not loosen that test to make it pass — follow the migration path described in its trap message instead.

## Internal vs. User-Facing ID Policy

Typed ULIDs (`TypedUlid<Prefix>`) are canonical everywhere a machine reads the value: URLs, foreign keys, event payloads, API/MCP arguments, and cross-context references. They are not designed for people to read, type, or say aloud.

When an identifier needs to be human-facing (support conversations, printed labels, order lookups), use a **display reference** instead of exposing the raw ULID: a short, support-safe label derived from the typed ULID, defined in [contracts/primitives/display-reference.ts](../../contracts/primitives/display-reference.ts) and cataloged in [Bounded Context Structure → Shared Display References](./bounded-context-structure.md#shared-display-references) (`ORD-`, `SHP-`, `PYO-`, and so on). Display references are derived, collision-checked labels — never a second source of identity. The typed ULID remains canonical identity even where a display reference is shown.
