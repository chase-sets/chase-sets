# UCP Agent Commerce Architecture

UCP is a standards-facing protocol facade. It translates between external agent/platform expectations and Chase Sets-owned bounded-context behavior.

## Surfaces

- `/.well-known/ucp`: public UCP business profile.
- `/ucp/v1`: UCP REST transport.
- `/ucp/mcp`: UCP MCP transport using UCP tool names.
- `/.well-known/oauth-authorization-server`: future OAuth metadata for identity linking.

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
- Same actor/scope checks once OAuth identity linking is enabled.
- Same signed-request and `Content-Digest` checks for checkout writes.
- Same idempotency policy for completion and cancellation.
- Same handler path into the owning bounded context.

The initial runtime exposes guardrails and placeholder handler seams. Concrete Discovery and Checkout adapters must replace placeholders before a capability is treated as commercially ready.

## Trusted Checkout

Agents may prepare purchase intent, but v1 checkout completion hands off to trusted UI unless AP2 Mandate support is explicitly implemented. This preserves buyer review, fee/tax/shipping snapshots, payment-handler trust, and account authorization boundaries.

## Replay And Audit

Writes must be replay-safe by `(platform profile, actor/account scope, operation, target id, Idempotency-Key)`. The runtime exposes a replay store boundary and an in-memory default for local use; production composition should provide a durable store. Audit records should include the UCP operation, capability, agent profile, actor/account when present, signature result, idempotency result, and owning-context command result.

HTTP Message Signature verification belongs in infrastructure. The runtime can verify request signatures when configured with a UCP profile/key resolver; production rollout should back that resolver with profile fetching, caching, key rotation, and failure telemetry.
