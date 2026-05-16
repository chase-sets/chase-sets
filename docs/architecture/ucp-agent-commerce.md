# UCP Agent Commerce Architecture

UCP is a standards-facing protocol facade. It translates between external agent/platform expectations and Chase Sets-owned bounded-context behavior.

## Surfaces

- `/.well-known/ucp`: public UCP business profile.
- `/ucp/v1`: UCP REST transport.
- `/ucp/mcp`: UCP MCP transport using UCP tool names.
- `/.well-known/oauth-authorization-server`: OAuth metadata for UCP identity linking.
- `/ucp/oauth/authorize`, `/ucp/oauth/token`, `/ucp/oauth/introspect`, `/ucp/oauth/revoke`: Auth-owned OAuth authorization-code-with-PKCE runtime backed by Identity-owned Linked Platform Authorization records.
- `/ucp/oauth/authorizations`: account consent-management surface for listing and revoking Linked Platform Authorizations.

Deployables mount these surfaces only. Protocol constants, envelopes, tool metadata, and profile construction live in `contracts/ucp`. Transport guardrails live in `infrastructure/platform-runtime/ucp`. Domain handlers stay in owning bounded contexts.

## Ownership

| UCP Concern | Chase Sets Owner |
| --- | --- |
| Catalog search and lookup | Discovery, with Catalog and Marketplace projections |
| Product and variant identity | Catalog Product plus selected options |
| Price and availability signals | Discovery projections from Marketplace and Inventory-owned facts |
| Cart and checkout sessions | Checkout |
| Order state | Ordering, with Payment and Fulfillment facts projected where needed |
| Payment handlers | Payments |
| Identity linking | Auth for OAuth journey, Identity for durable consent/client facts |
| Signatures, digest, replay plumbing | Infrastructure/Contracts |

## Transport Contract

REST and MCP must remain behavior-equivalent:

- Same UCP version and capability declarations.
- Same validation and UCP envelope/message shape.
- Same actor/scope checks for OAuth-linked bearer tokens.
- Same signed-request and `Content-Digest` checks for checkout writes.
- Same idempotency policy for completion and cancellation.
- Same handler path into the owning bounded context.

The runtime exposes guardrails and handler seams. Concrete Discovery, Checkout, Ordering, Payments, Auth, and Identity adapters must own commercial behavior before a capability is treated as commercially ready.

## Trusted Checkout

Agents may prepare purchase intent, but v1 checkout completion hands off to trusted UI unless AP2 Mandate support is explicitly implemented. Payments now declares the trusted payment handler surface and recognizes AP2/payment-handler inputs, but headless completion stays disabled until Payments owns a production mandate verification model. This preserves buyer review, fee/tax/shipping snapshots, payment-handler trust, and account authorization boundaries.

## Replay And Audit

Writes must be replay-safe by `(platform profile, actor/account scope, operation, target id, Idempotency-Key)`. The runtime exposes a replay store boundary, an in-memory default for isolated tests, and a Postgres-backed control-plane store for production composition. Production composition sets a seven-day replay-retention window, ignores expired records for new requests, and exposes pruning through the store boundary. Audit records should include the UCP operation, capability, agent profile, actor/account when present, signature result, idempotency result, and owning-context command result.

HTTP Message Signature verification belongs in infrastructure. The runtime can verify request signatures when configured with a UCP profile/key resolver; production composition wires a Postgres-backed profile/key cache with TTL refresh and cached failure diagnostics. The runtime emits observer events for signed-write rejection, signature verification failure, idempotency replay/conflict, and operation completion so hosts can log and meter UCP traffic without moving protocol decisions into deployables.

## Production Boundaries

UCP OAuth identity linking requires PKCE S256, rotates refresh tokens, supports token introspection, and lets the linked account revoke platform consent. Public non-local HTTP redirect/profile URLs are rejected.

Payments recognizes structured AP2 mandate attempts but still requires Trusted Checkout Handoff because mandate verification, response signing of checkout terms, and payment-handler processor submission are not yet production-owned. Business response signing remains a future runtime/key-management decision.
