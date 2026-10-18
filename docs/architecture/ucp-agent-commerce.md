# UCP Agent Commerce Architecture

UCP is a standards-facing protocol facade. It translates between external agent/platform expectations and Chase Sets-owned bounded-context behavior.

## Surfaces

- `/mcp`: Chase Sets-native MCP bridge for first-party and operator agent tooling.
- `/.well-known/ucp`: public UCP business profile.
- `/ucp/v1`: UCP REST transport.
- `/ucp/mcp`: UCP MCP transport using UCP tool names.
- `/.well-known/oauth-authorization-server`: OAuth metadata for UCP identity linking.
- `/ucp/oauth/authorize`, `/ucp/oauth/token`, `/ucp/oauth/register`, `/ucp/oauth/introspect`, `/ucp/oauth/revoke`: Auth-owned OAuth authorization-code-with-PKCE runtime, RFC 7591 public-client registration, and Client ID Metadata Document support backed by Identity-owned Linked Platform Authorization records.
- `/ucp/oauth/authorizations`: account consent-management surface for listing and revoking Linked Platform Authorizations.

Deployables mount these surfaces only. Native MCP contracts and runtime guardrails live in the flat `infrastructure/platform-runtime/mcp*.ts` modules; UCP protocol constants, envelopes, tool metadata, profile construction, and transport guardrails live in `infrastructure/platform-runtime/ucp*.ts`. Domain handlers stay in owning bounded contexts.

## Native MCP Bridge

The native `/mcp` bridge is an authenticated internal surface. It uses Chase Sets-owned tool names and resource URIs composed from mounted bounded-context module contracts. Discovery requires an authenticated actor, and tool calls enforce permission, account ownership, input schema, confirmation text, durable idempotency for writes, and audit records before and after handler execution.

The native bridge is not a third-party commerce profile. External agent commerce should use `/.well-known/ucp` and `/ucp/mcp`; native `/mcp` exists for first-party automation where Chase Sets controls the agent host and can bind the request to a platform session or operator principal.

Every admin route ships with **Agent Coverage**: its source context's `agentCoverage` manifest key, keyed by the route's `routeId`, declares the available native MCP tools that cover the route, an exemption (`sign-in-flow`, `navigation-only`, `human-presence-required` or `file-upload`, with a note), or the pending issue that owns the gap. `deployables/admin-web/app/admin-agent-coverage.test.ts` fails a route without a valid declaration, an entry for a route its context does not contribute, and a named tool that is missing from the catalog or not yet available. A new exemption code needs a recorded decision.

## ChatGPT Apps Compatibility

ChatGPT Apps are remote MCP clients. Chase Sets exposes the existing UCP MCP tool names directly to ChatGPT instead of adding a ChatGPT-specific commerce contract. Tool descriptors include JSON schemas, output schemas, OAuth/no-auth security schemes, read/write annotations, and invocation labels so ChatGPT can select the right marketplace operation while the underlying handler remains owned by Discovery, Checkout, Ordering, Payments, Auth, or Identity.

The ChatGPT app uses mixed authentication:

- `initialize` and `tools/list` can run without authentication.
- Public catalog tools use no-auth and read Discovery-owned public marketplace data.
- Checkout and order tools use OAuth through the Auth-owned UCP authorization server and Identity-owned Linked Platform Authorization records.

ChatGPT OAuth does not replace UCP request signatures. If ChatGPT calls signed checkout completion or cancellation tools without `UCP-Agent`, HTTP Message Signature, `Content-Digest`, and idempotency headers, the MCP runtime returns a trusted checkout handoff instead of invoking headless money movement. Signed UCP agents keep the existing signed-write path and the Payments-owned completion decision.

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
| Signatures, digest, replay plumbing | Infrastructure |

## Transport Contract

UCP REST and UCP MCP must remain behavior-equivalent:

- Same UCP version and capability declarations.
- Same validation and UCP envelope/message shape.
- Same actor/scope checks for OAuth-linked bearer tokens.
- Same signed-request and `Content-Digest` checks for checkout writes.
- Same idempotency policy for completion and cancellation.
- Same handler path into the owning bounded context.

Native `/mcp` is a separate Chase Sets operator/first-party bridge. It supports MCP `2025-06-18` and `2025-11-25` through legacy `initialize`, and `2026-07-28` through stateless per-request protocol metadata and `Mcp-Method`/`Mcp-Name` routing headers. The native bridge must not depend on `Mcp-Session-Id` or load-balancer affinity.

The runtime exposes guardrails and handler seams. Concrete Discovery, Checkout, Ordering, Payments, Auth, and Identity adapters must own commercial behavior before a capability is treated as commercially ready.

The native `/mcp` bridge is intentionally narrower than UCP. Its production contract is capability honesty rather than UCP equivalence: `tools/list` and `resources/list` advertise only callable native capabilities, and every advertised native capability must have composed-platform integration coverage before it is exposed.

## Trusted Checkout

Agents may prepare purchase intent. Checkout completion hands off to trusted UI unless a signed agent names a Saved Checkout Instrument from the stored-payment-method setup rail. Then Checkout reuses the same confirmation path as trusted UI: it records shipping details, creates Ordering-owned purchases, enforces the agent grant spending mandate, asks Payments to create the off-session payment, then records the payment on the Checkout Session.

Payments owns the completion decision. It recognizes a saved checkout instrument id (`sci_`) in UCP payment data and otherwise makes no decision, so Checkout answers with a Trusted Checkout Handoff. Agent-provided payment instruments never reach a processor payment.

Stripe shared payment tokens are handled through the payment processor boundary. The Stripe adapter creates and confirms a PaymentIntent with `shared_payment_granted_token`, records normal Chase Sets payment metadata, and keeps idempotency tied to the internal payment id. UCP checkout completion does not supply one.

## Replay And Audit

Writes must be replay-safe by `(platform profile, actor/account scope, operation, target id, Idempotency-Key)`. The runtime exposes a replay store boundary, an in-memory store only for isolated tests, and a Postgres-backed control-plane store for production composition. Production UCP mounts must bootstrap `platformUcpRuntimeSchemaSql` and pass `createPostgresUcpIdempotencyStore(...)`; REST and MCP route creation fails outside the test runtime when no durable idempotency store is provided. Production composition sets a seven-day replay-retention window, ignores expired records for new requests, and exposes pruning through the store boundary. Audit records should include the UCP operation, capability, agent profile, actor/account when present, signature result, idempotency result, and owning-context command result.

HTTP Message Signature verification belongs in infrastructure. The runtime can verify request signatures when configured with a UCP profile/key resolver; production composition wires a Postgres-backed profile/key cache with TTL refresh and cached failure diagnostics. The runtime emits observer events for signed-write rejection, signature verification failure, idempotency replay/conflict, and operation completion so hosts can log and meter UCP traffic without moving protocol decisions into deployables. Observability records bounded-cardinality metrics for those observer events and Grafana provisions UCP operation/security panels and starter alerts.

Business signing key publication also belongs in infrastructure. When `UCP_BUSINESS_SIGNING_PRIVATE_JWK` and `UCP_BUSINESS_SIGNING_KEY_ID` are configured, the public key is published in `/.well-known/ucp` `keys[]`; no UCP response is signed with it. The served contract is UCP `2026-08-25`; no multi-version negotiation or legacy signing-key alias is published or interpreted.

General response signing is not part of the v1 production baseline. UCP REST and MCP responses, including checkout, rely on HTTPS transport, OAuth/signed-request enforcement for protected writes, audit, and idempotency evidence. If a future agent profile requires response verification, define one response-signature scheme across REST and MCP before advertising it as a capability.

## Production Boundaries

UCP OAuth identity linking requires PKCE S256, rotates refresh tokens, supports token introspection, and lets the linked account revoke platform consent. Public non-local HTTP redirect/profile URLs are rejected.

Payments completes headless checkout only against a Saved Checkout Instrument. Every other completion, including agent-provided payment instruments and unsupported payment data, returns a trusted UI continuation instead of moving money.

Remaining external gates are Stripe private-preview account enablement for shared payment tokens and production key-rotation operations for the business signing key material.

## OAuth Consent

Auth stores a ten-minute, single-use consent request before showing `/account/agents/consent`. The token is stored only as a hash and binds the interactive session, user, account, client, exact scopes, redirect, state, and PKCE challenge. Authorization GET validates the request but never creates an authorization code. Bearer grants and guest-checkout actors cannot create, read, or decide consent requests.

A same-origin native authorization POST revalidates the bound session and client metadata, then atomically consumes an unexpired request. Approve issues a code using only the bound values; deny returns `access_denied` and the bound state. Refusals never redirect to the client. Account switching uses the existing session switch and restarts authorization for fresh consent. The consent document sends `frame-ancestors 'none'`, `strict-origin`, and `no-store`, without `form-action` so the client callback is not blocked. The origin-only referrer preserves native POST Origin without exposing the consent token; `/ucp/oauth` API responses retain `no-referrer`. Auth's indexed retention sweep removes expired requests in bounded batches.

## MCP Eras

UCP `/ucp/mcp` serves the same legacy revisions beside MCP `2026-07-28` stateless requests. Both endpoints use the policy-driven readers and validators in `infrastructure/platform-runtime/mcp-protocol.ts`; route adapters own JSON-RPC responses. Native status/body contracts remain unchanged. Modern UCP requests are selected only by `_meta["io.modelcontextprotocol/protocolVersion"]`, never by a header alone; `initialize` selects legacy semantics and retains legacy downgrade behavior. Modern UCP requires `_meta` client capabilities (no capability-header fallback), makes client info optional, and decodes Base64 `Mcp-Name` values before target comparison. Its `server/discover` returns `supportedVersions` and tools/resources capabilities, and every modern result carries `_meta["io.modelcontextprotocol/serverInfo"]` named `chase-sets-ucp`. No session id or affinity is required.

Modern UCP unsupported metadata revisions use HTTP 400 / `-32022` with `{supported, requested}`; routing/protocol header failures use HTTP 400 / `-32020`, invalid per-request metadata uses HTTP 400 / `-32602`, and unknown methods use HTTP 404 / `-32601`. Requests without protocol-version metadata keep legacy errors, including header-only `2026-07-28` returning `-32004`. Signed-write, OAuth, and idempotency checks stay on the same operation paths in both eras. Keep legacy `initialize` until #9459 and #9456 record that no target host uses it, then re-open its removal.
