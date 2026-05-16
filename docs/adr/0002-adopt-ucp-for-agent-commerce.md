# ADR 0002: Adopt UCP For Agent Commerce

## Status

Accepted.

## Context

Chase Sets needs a standards-facing commerce surface so custom AI agents can discover products, create and update checkout sessions, hand buyers to trusted confirmation, and read order state without bypassing bounded-context ownership.

The Universal Commerce Protocol (UCP) provides profile discovery at `/.well-known/ucp`, REST and MCP transports, catalog, cart, checkout, order, identity-linking, payment-handler, and signature conventions. Chase Sets already owns the underlying commerce behavior through bounded contexts:

- Discovery owns search, browse, and buyer-visible product detail.
- Catalog owns Catalog Item, Product, Dimension, and Option truth.
- Marketplace owns Listing and Offer lifecycle.
- Checkout owns Cart and Checkout Session lifecycle.
- Ordering owns Order commitment and Purchase/Sale projections.
- Payments owns external payment state and payment-handler integration.
- Auth and Identity own authentication, account selection, delegated access, consents, and credential lifecycle.

## Decision

Adopt UCP as a protocol facade over existing bounded-context behavior, not as a new bounded context and not as a replacement domain model.

V1 advertises both UCP REST and UCP MCP in the business profile:

- REST endpoint: `/ucp/v1`
- MCP endpoint: `/ucp/mcp`
- Business profile: `/.well-known/ucp`

REST routes and UCP MCP tools must share protocol DTOs, validation, authorization, signed-request checks, idempotency/replay policy, audit policy, and context-owned handlers. Deployables may mount the routes, but domain decisions stay in the owning bounded context.

Checkout completion requires a trusted UI handoff unless a later AP2 Mandate implementation verifies autonomous purchase authority. OAuth identity linking must be modeled separately from API keys because UCP delegated access is user/account consent, not a generic software credential. UCP OAuth uses Authorization Code with PKCE S256, refresh-token rotation, introspection, and consent revocation.

## Consequences

- UCP terms are boundary DTOs. Internal ubiquitous language remains Catalog Item/Product, Listing, Offer, Cart, Checkout Session, Order/Purchase/Sale, Payment, and Shipment.
- `@chase-sets/ucp` owns protocol constants, profile declarations, envelopes, and transport-neutral contract helpers.
- `@chase-sets/platform-runtime/ucp` owns generic profile, REST transport, MCP transport, signature-header, digest, cryptographic HTTP Message Signature verification through UCP key resolution, Postgres-backed profile/key caching, and durable idempotency guardrails.
- Discovery, Checkout, Ordering, Payments, Auth, and Identity will provide concrete handlers through their existing context-owned services.
- The existing Chase Sets-native `/mcp` bridge remains available for internal agent tooling; `/ucp/mcp` is the standards-facing UCP profile with UCP tool names.
- Product code must not add a generic `ai-commerce` or `ucp` bounded context.

## Verification

Initial verification covers:

- UCP profile declaration for REST and MCP.
- UCP MCP tool advertisement with UCP tool names.
- Signed checkout write header and `Content-Digest` guardrails.
- Idempotency-key requirements for checkout completion and cancellation.
- Platform API mounts for `/.well-known/ucp`, `/ucp/v1`, and `/ucp/mcp`.

Order reads, OAuth scope enforcement, PKCE, refresh rotation, token introspection, linked-platform consent revocation, durable replay storage with retention/pruning, production profile/key caching, AP2 guarded continuation, UCP runtime observer events, and staging smoke checks are now part of the hardening baseline. Response signing and real AP2 mandate/payment-handler funds transfer remain future work. Catalog search/lookup, checkout create/update/get, trusted UI escalation for complete, transport digest checks, cryptographic request signature verification through a cached resolver, replay conflict behavior, OAuth token lifecycle behavior, and AP2 guardrails have focused automated coverage.
