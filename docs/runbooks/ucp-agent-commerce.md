# UCP Agent Commerce Runbook

## Smoke Checks

Check profile discovery:

```powershell
Invoke-RestMethod http://localhost:7712/.well-known/ucp
```

Check REST transport:

```powershell
Invoke-RestMethod http://localhost:7712/ucp/v1
```

Check MCP tool listing:

```powershell
Invoke-RestMethod http://localhost:7712/ucp/mcp -Method Post -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}'
```

Check the native Chase Sets MCP bridge. Anonymous discovery should be rejected:

```powershell
Invoke-RestMethod http://localhost:7712/mcp -Method Post -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}'
```

With a platform session token and the session account id, discovery should list the serviceable Inventory import tools and the safe source read should return import-source profiles:

```powershell
$headers = @{ Authorization = "Bearer <session-token>" }
Invoke-RestMethod http://localhost:7712/mcp -Method Post -ContentType "application/json" -Headers $headers -Body '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}'
Invoke-RestMethod http://localhost:7712/mcp -Method Post -ContentType "application/json" -Headers $headers -Body '{"jsonrpc":"2.0","id":"sources","method":"tools/call","params":{"name":"inventory.list-import-sources","arguments":{"accountId":"<account-id>"}}}'
```

## ChatGPT App Connector

ChatGPT now calls connectors "apps." Configure Chase Sets as a data-and-action ChatGPT app from the remote MCP endpoint:

- MCP endpoint: `https://<marketplace-host>/ucp/mcp`
- Supported auth mode: Mixed Authentication
- OAuth issuer metadata: `https://<marketplace-host>/.well-known/oauth-authorization-server`
- OAuth authorization endpoint: `https://<marketplace-host>/ucp/oauth/authorize`
- OAuth token endpoint: `https://<marketplace-host>/ucp/oauth/token`

For local smoke tests, use the sandbox platform API host:

```powershell
$body = '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"chatgpt-smoke","version":"0.1.0"}}}'
Invoke-RestMethod http://localhost:6362/ucp/mcp -Method Post -ContentType "application/json" -Body $body
```

Verify the MCP protocol matrix. Native `/mcp` supports legacy `initialize` for `2025-06-18` and `2025-11-25`, plus handshakeless stateless requests for `2026-07-28`. UCP `/ucp/mcp` remains the UCP commerce facade and currently negotiates only the legacy initialize revisions.

```powershell
$authHeaders = @{ Authorization = "Bearer <session-token>" }

$init20250618 = '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-smoke","version":"0.1.0"}}}'
Invoke-RestMethod http://localhost:6362/mcp -Method Post -ContentType "application/json" -Headers $authHeaders -Body $init20250618
Invoke-RestMethod http://localhost:6362/ucp/mcp -Method Post -ContentType "application/json" -Body $init20250618

$init20251125 = '{"jsonrpc":"2.0","id":"rev-20251125","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"mcp-smoke","version":"0.1.0"}}}'
Invoke-RestMethod http://localhost:6362/mcp -Method Post -ContentType "application/json" -Headers $authHeaders -Body $init20251125
Invoke-RestMethod http://localhost:6362/ucp/mcp -Method Post -ContentType "application/json" -Body $init20251125

$meta20260728 = @{
  "io.modelcontextprotocol/protocolVersion" = "2026-07-28"
  "io.modelcontextprotocol/clientInfo" = @{ name = "mcp-smoke"; version = "0.1.0" }
  "io.modelcontextprotocol/clientCapabilities" = @{}
}
$statelessHeaders = @{
  Authorization = "Bearer <session-token>"
  "MCP-Protocol-Version" = "2026-07-28"
  "Mcp-Method" = "tools/list"
}
$statelessBody = @{
  jsonrpc = "2.0"
  id = "tools-20260728"
  method = "tools/list"
  params = @{ _meta = $meta20260728 }
} | ConvertTo-Json -Depth 8
Invoke-RestMethod http://localhost:6362/mcp -Method Post -ContentType "application/json" -Headers $statelessHeaders -Body $statelessBody
```

Expected result: native `/mcp` initialize returns the requested legacy revision for `2025-06-18` and `2025-11-25`; UCP `/ucp/mcp` does the same for its legacy facade. Native `2026-07-28` requests must not call `initialize`; each request includes `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` for tool/resource targets, and client info/capabilities in `_meta` or the supported client headers. The platform must not require or return `Mcp-Session-Id`.

Verify ChatGPT-compatible tool metadata:

```powershell
$tools = Invoke-RestMethod http://localhost:6362/ucp/mcp -Method Post -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}'
$tools.result.tools | Select-Object name,securitySchemes,annotations
```

MCP `2025-11-25` browser transport requirements are enforced on both MCP facades. Browser calls with a hostile `Origin` return HTTP 403; no-`Origin` server-to-server calls remain valid. Allowed Chase Sets browser origins receive explicit CORS headers for JSON-RPC, authorization, idempotency, signature, and MCP protocol/routing headers. Clients that send `MCP-Protocol-Version` after initialization must use a supported revision; native `/mcp` accepts `2025-06-18`, `2025-11-25`, and stateless `2026-07-28`, while UCP `/ucp/mcp` accepts the legacy initialize revisions only.

Native and UCP tool listings include MCP standard annotations. Read-only tools set `readOnlyHint`; destructive tools set `destructiveHint`; write tools protected by platform idempotency set `idempotentHint`. The richer Chase Sets guardrail metadata remains in `annotations` for operator review and packaging.

Verify a public catalog call returns `structuredContent`:

```powershell
Invoke-RestMethod http://localhost:6362/ucp/mcp -Method Post -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":"search","method":"tools/call","params":{"name":"search_catalog","arguments":{"query":"charizard","limit":3}}}'
```

JSON-RPC MCP transport status convention: `/ucp/mcp` and native `/mcp` return HTTP 200 with an in-band JSON-RPC `error` object for application errors such as unknown methods, unknown tools/resources, missing idempotency keys, signature rejection, authorization denial, and idempotency conflicts. Reserve non-2xx transport status for malformed JSON-RPC bodies, unsupported JSON-RPC batch arrays, authentication failures that prevent discovery, unsupported protocol revision headers, and stateless routing/header metadata failures. Native `2026-07-28` header mismatches use JSON-RPC code `-32001`; invalid stateless params and unknown tools/resources use `-32602`.

MCP protocol revision decision, 2026-07-07: native `/mcp` advertises `2025-06-18`, `2025-11-25`, and `2026-07-28`. The first two revisions keep the legacy handshake path; `2026-07-28` is request-scoped and must not rely on session affinity. Extension negotiation is scaffolded through `capabilities.extensions`, but Tasks (`io.modelcontextprotocol/tasks`) and MCP Apps (`io.modelcontextprotocol/ui`) are advertised only when the owning slices provide real handlers/resources. Operator review remains required when the public final `2026-07-28` specification page is published; as of 2026-07-07, the public Model Context Protocol specification site still exposes `2025-11-25` as the latest stable revision, so this implementation follows issue #3767 and the finalized stateless/header/error-code SEPs.

Primary references:

- `2026-07-28` stateless migration issue: https://github.com/chase-sets/chase-sets/issues/3767
- SEP-2575 stateless MCP transport
- SEP-2243 HTTP header standardization
- SEP-2164 resource-not-found `-32602` error code
- SEP-2133 MCP extensions
- `2025-11-25` changelog: https://modelcontextprotocol.io/specification/2025-11-25/changelog
- `2025-11-25` lifecycle: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- `2025-11-25` authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- `2025-06-18` baseline: https://modelcontextprotocol.io/specification/2025-06-18

MCP tool calls are concurrency-limited before handler execution by the platform realtime limiter. Production-like deployments should keep `REALTIME_STREAM_LIMITER=postgres` or `redis`; local mode uses in-memory process limits. Tune `MCP_MAX_CONCURRENT_TOOL_CALLS`, `MCP_MAX_CONCURRENT_TOOL_CALLS_PER_PRINCIPAL`, `MCP_MAX_CONCURRENT_WRITE_TOOL_CALLS_PER_PRINCIPAL`, and `MCP_MAX_CONCURRENT_EXTERNAL_PROVIDER_TOOL_CALLS_PER_PRINCIPAL` when staging evidence shows legitimate agent fan-out needs more headroom. Limit rejections return a clear MCP error and are logged through native MCP audit or the UCP observer.

The platform smoke script checks native `/mcp` anonymous discovery on every run. When admin credentials produce a session with an account id, or `SMOKE_NATIVE_MCP_ACCOUNT_ID` is supplied, it performs authenticated native discovery and the safe `inventory.list-import-sources` read across the `2025-06-18`, `2025-11-25`, and `2026-07-28` native MCP matrix with the same deployment.

Account-scoped checkout and order calls require the OAuth access token issued by `/ucp/oauth/token`. If ChatGPT calls `complete_checkout` or `cancel_checkout` with OAuth but without UCP HTTP Message Signature headers, the runtime must return a trusted checkout handoff and must not create orders, payments, or AP2 mandate effects.

## Signed Checkout Writes

Checkout write requests must include:

- `UCP-Agent`
- `Signature-Input`
- `Signature`
- `Content-Digest`
- `Idempotency-Key`

Current runtime verifies required headers, SHA-256 body digest, and replay/idempotency before invoking checkout write handlers. Production platform-api composition must bootstrap `platformUcpRuntimeSchemaSql` and wire the Postgres-backed UCP idempotency store and profile/key cache from the platform control database. Route creation fails outside the test runtime when a UCP REST or MCP mount omits the durable idempotency store. When configured with a UCP profile/key resolver, it also verifies RFC 9421 HTTP Message Signatures against the signer's public key.

## AP2 Merchant Authorization

Configure checkout-term signing before enabling AP2-capable external smoke:

- `UCP_BUSINESS_SIGNING_KEY_ID`: current merchant signing key id, for example `merchant-2026-q2`.
- `UCP_BUSINESS_SIGNING_ALG`: `ES256`, `ES384`, or `ES512`; prefer `ES256`.
- `UCP_BUSINESS_SIGNING_PRIVATE_JWK`: EC private JWK for the current signing key.
- `UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS`: JSON array of previous public JWKs retained during rotation.

After restart, verify `/.well-known/ucp` includes `signing_keys` and checkout responses include `checkout.ap2.merchant_authorization`.

Rotate by adding the current public key to `UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS`, installing the new private JWK and key id, deploying, then removing old public keys after all AP2 mandate retention windows have expired.

## Forward Readiness Posture

General UCP response signing is deferred for v1. Operators should not promise signed non-checkout UCP responses; protected writes rely on signed requests, digest verification, OAuth scope, durable idempotency, and audit evidence. Checkout responses may carry `ap2.merchant_authorization` when merchant signing keys are configured, but that is checkout-term signing, not a general response-signature contract.

Headless AP2 checkout is closed by default. Enable it only after the production AP2 verifier, merchant signing keys, Stripe shared-payment-token PaymentIntent path, webhook handling, replay behavior, and certification record are complete. Until then, OAuth ChatGPT calls and unsupported signed-agent calls must return trusted checkout handoff continuations instead of creating orders, payments, or AP2 effects.

Check OAuth metadata:

```powershell
Invoke-RestMethod http://localhost:7712/.well-known/oauth-authorization-server
```

OAuth identity linking requires Authorization Code with PKCE S256. Token refresh rotates the refresh token on every successful refresh. Token support endpoints:

- `/ucp/oauth/token`: `authorization_code` and `refresh_token`
- `/ucp/oauth/register`: RFC 7591 public-client registration for agent platforms
- `/ucp/oauth/introspect`: active token, account, scope, and client/profile diagnostics
- `/ucp/oauth/revoke`: access-token or refresh-token revocation
- `/ucp/oauth/authorizations`: signed-in account list and consent revocation

Order reads are available through the linked account when that account is the buyer or seller on the order:

```powershell
Invoke-RestMethod http://localhost:7712/ucp/v1/orders/<order-id> -Headers @{ Authorization = "Bearer <ucp-access-token>" }
```

## Incident Response

For suspected replay or agent abuse:

- Pause the platform/client in Identity by revoking the Linked Platform Authorization.
- Revoke OAuth access tokens and refresh tokens through `/ucp/oauth/revoke`.
- Search UCP logs by `ucp.signed_write.rejected`, `ucp.signature_verification.failed`, `ucp.idempotency.replayed`, `ucp.idempotency.conflict`, and `ucp.operation.completed`.
- Check Grafana `UCP operation rate` and `UCP security and idempotency events` panels for spikes in failed signatures, signed-write rejects, or idempotency conflicts.
- Search replay records by agent profile, operation, account, and idempotency key while they remain inside the production retention window.
- Compare `Content-Digest` values for duplicate or tampered requests.
- Confirm no duplicate Ordering or Payments facts were emitted.

## Production Readiness Gates

- UCP profile advertises only capabilities with wired bounded-context handlers.
- OAuth identity linking maps UCP scopes to Chase Sets permissions and persists Linked Platform Authorization records in Identity.
- OAuth identity linking requires PKCE S256, rotates refresh tokens, supports token introspection, and exposes linked-platform consent revocation.
- Signature verification resolves agent keys from UCP profile/key discovery and is enabled in production runtime composition.
- Idempotency records are durable, survive process restarts, carry a retention expiry, and can be pruned.
- AP2/payment-handler support is guarded: Payments declares trusted and Stripe shared-payment-token handlers, but headless completion is enabled only when a production AP2 verifier, business signing key, and provider-backed Stripe SPT PaymentIntent path are configured.
- Stripe webhook configuration includes `shared_payment.granted_token.used` and `shared_payment.granted_token.deactivated` alongside PaymentIntent, Checkout Session, refund, dispute, Connect, and payout events.
- Staging smoke confirms `/.well-known/ucp`, `/.well-known/oauth-authorization-server`, PKCE/refresh metadata, `/ucp/v1`, `/ucp/mcp`, native `/mcp` discovery/authentication posture, and linked-account order reads on the marketplace host.

## Marketing Certification Gate

Do not market UCP/AP2 as launch-ready, agent-commerce capable, autonomous-payment capable, or headless-checkout capable until a separate certification record is approved. The public launch posture is trusted checkout handoff: agents may prepare or inspect supported shopping flows, but account-scoped checkout completion must move through buyer UI review unless a verified AP2 Mandate and supported Payments handoff are present.

The certification record must include:

- Production AP2 verifier configuration and signed-write rejection evidence for missing, expired, replayed, or untrusted signatures.
- Merchant signing key configuration, public-key discovery, rotation rehearsal, and mandate retention/expiry handling.
- Provider-backed Stripe Shared Payment Token PaymentIntent path, including token-use webhooks and replay-safe failure behavior.
- OAuth authorization-code plus PKCE evidence, refresh-token rotation, token introspection, revocation, and linked-platform consent removal.
- Trusted Checkout Handoff evidence showing unsupported or unsigned ChatGPT app calls do not create orders, payments, or AP2 effects.
- Incident-response evidence covering profile/client pause, token revocation, replay search, idempotency conflict review, and duplicate-effect checks.
- Support and Finance review for buyer consent, payment liability, refund/dispute handling, and agent-abuse escalation.

Until that record exists, Public Presence, launch notes, sales collateral, and promo-bar messages must avoid UCP, AP2, autonomous payment, headless checkout, AI-agent checkout, Payment Handler, Shared Payment Token, and agent-commerce claims.
