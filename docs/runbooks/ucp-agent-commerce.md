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

## Platform Profile Negotiation

REST operations read `UCP-Agent: profile="https://platform.example/profile.json"` and the `Idempotency-Key` header. MCP operations read `params.arguments.meta["ucp-agent"].profile` and `params.arguments.meta["idempotency-key"]`. MCP protocol metadata stays at `params._meta`; it is not UCP request metadata. Handlers receive arguments without `meta`. Signed MCP writes also carry `UCP-Agent`; argument and header profiles must agree, as must retry keys supplied in both locations.

Negotiation runs before handlers and idempotency reservations, regardless of whether an access token is valid, invalid, or missing. Failures are `invalid_profile_url` (REST 400), `profile_unreachable` (424), `profile_malformed` (422), and `version_unsupported` (422). MCP returns `-32001` with `error.data.code`. An incompatible operation capability returns REST 200 or an MCP result with `capabilities_incompatible`, without an effect. After negotiation, an OAuth actor's claimed profile must equal its grant's profile; mismatch returns REST 403 or MCP `-32000` with `profile_mismatch`. Disagreeing retry keys return `idempotency_key_mismatch`.

The shared negotiation/signature resolver uses HTTPS without redirects, validates every DNS address and pins the connection to a public address while retaining Host and SNI. It has a 5-second total deadline, a 128 KiB body limit, four concurrent resolutions and 60 fetch starts per rolling minute per process. Concurrent requests for one URL share resolution. Only valid profiles are persisted for 300 seconds; failures are not cached. Failure logs contain the kind and host, never the raw exception or full profile URL.

Two intentional Chase Sets extensions allow profile-less callers:

- Public, read-only catalog search and lookup work on REST and MCP. REST checkout and order operations still require a profile.
- `/ucp/mcp` is the buyer connector: profile-less checkout/order calls follow normal OAuth handling, with `authentication_required` and `mcp/www_authenticate` for unauthenticated callers. Authenticated buyers use the business capability set without fetching a profile. A supplied or malformed profile never falls back to this extension.

`pnpm run smoke:platform` checks profile-less REST checkout rejection and profile-less catalog success. Pre-merge proof belongs to exact-head hosted `Compose Boot Smoke`; the first post-merge staging smoke supplies deployed proof.

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

Verify the MCP protocol matrix. Both native `/mcp` and UCP `/ucp/mcp` support legacy `initialize` for `2025-06-18` and `2025-11-25`, plus handshakeless stateless requests for `2026-07-28`. Their request policies share `infrastructure/platform-runtime/mcp-protocol.ts`; native response contracts remain unchanged.

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
Invoke-RestMethod http://localhost:6362/ucp/mcp -Method Post -ContentType "application/json" -Headers $statelessHeaders -Body $statelessBody
```

Expected result: both endpoints' `initialize` returns the requested legacy revision for `2025-06-18` and `2025-11-25`. Stateless `2026-07-28` requests must not call `initialize`; each request includes `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for tool/resource targets. Native `/mcp` requires client info/capabilities in `_meta` or its supported client headers. Modern `/ucp/mcp` requires protocol version and client capabilities in `_meta`, ignores the capability header, and makes client info optional. Every modern UCP result includes `_meta["io.modelcontextprotocol/serverInfo"]`; `server/discover` returns `supportedVersions` (`2026-07-28`, `2025-11-25`, `2025-06-18`) and tools/resources capabilities. The platform must not require or return `Mcp-Session-Id`.

On `/ucp/mcp`, only per-request `_meta` protocol version selects modern semantics; a header alone never does. Header-only `2026-07-28` and unknown revisions keep the legacy HTTP 400 / `-32004` response, and legacy `initialize` naming `2026-07-28` still downgrades to `2025-06-18`. Keep legacy `initialize` for deployed ChatGPT and Claude connectors. **Re-open trigger:** drop it once #9459 and #9456 record that no target host uses it. The pinned MCP SDK is legacy evidence; test modern UCP with a scripted HTTP client using raw JSON-RPC.

Verify ChatGPT-compatible tool metadata:

```powershell
$tools = Invoke-RestMethod http://localhost:6362/ucp/mcp -Method Post -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}'
$tools.result.tools | Select-Object name,securitySchemes,annotations
```

MCP `2025-11-25` browser transport requirements are enforced on both MCP facades. Browser calls with a hostile `Origin` return HTTP 403; no-`Origin` server-to-server calls remain valid. Allowed Chase Sets browser origins receive explicit CORS headers for JSON-RPC, authorization, idempotency, signature, and MCP protocol/routing headers. Both endpoints accept the legacy revisions after initialization and `2026-07-28` with per-request metadata. Modern UCP decodes `=?base64?...?=` UTF-8 `Mcp-Name` values before comparing them with the tool name or resource URI; malformed encoding fails closed. Native `/mcp` retains its raw header comparison.

Native and UCP tool listings include MCP standard annotations. Read-only tools set `readOnlyHint`; destructive tools set `destructiveHint`; write tools protected by platform idempotency set `idempotentHint`. The richer Chase Sets guardrail metadata remains in `annotations` for operator review and packaging.

Verify a public catalog call returns `structuredContent`:

```powershell
Invoke-RestMethod http://localhost:6362/ucp/mcp -Method Post -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":"search","method":"tools/call","params":{"name":"search_catalog","arguments":{"query":"charizard","limit":3}}}'
```

JSON-RPC MCP transport status convention: legacy `/ucp/mcp` and native `/mcp` return HTTP 200 with an in-band JSON-RPC `error` object for application errors such as unknown methods, unknown tools/resources, missing idempotency keys, signature rejection, authorization denial, and idempotency conflicts. Modern `/ucp/mcp` returns HTTP 404 / `-32601` for unknown methods, HTTP 400 / `-32022` with `{supported, requested}` for unsupported metadata versions, HTTP 400 / `-32020` for missing or mismatched routing/protocol headers, and HTTP 400 / `-32602` for invalid per-request metadata. Native `2026-07-28` header mismatches retain `-32001`. Other application-error behavior, signed-write, OAuth, and idempotency checks are unchanged across UCP eras.

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

Account-scoped checkout and order calls require the OAuth access token issued by `/ucp/oauth/token`. If ChatGPT calls `complete_checkout` or `cancel_checkout` with OAuth but without UCP HTTP Message Signature headers, the runtime must return a trusted checkout handoff and must not create orders, payments, or spend authorizations.

## Signed Checkout Writes

Checkout write requests must include:

- `UCP-Agent`
- `Signature-Input`
- `Signature`
- `Content-Digest`
- `Idempotency-Key`

Current runtime verifies required headers, SHA-256 body digest, and replay/idempotency before invoking checkout write handlers. Production platform-api composition must bootstrap `platformUcpRuntimeSchemaSql` and wire the Postgres-backed UCP idempotency store and profile/key cache from the platform control database. Route creation fails outside the test runtime when a UCP REST or MCP mount omits the durable idempotency store. When configured with a UCP profile/key resolver, it also verifies RFC 9421 HTTP Message Signatures against the signer's public key.

## Business Signing Keys

Configure the business signing key to publish it in `/.well-known/ucp`:

- `UCP_BUSINESS_SIGNING_KEY_ID`: current business signing key id, for example `merchant-2026-q2`.
- `UCP_BUSINESS_SIGNING_ALG`: `ES256`, `ES384`, or `ES512`; prefer `ES256`.
- `UCP_BUSINESS_SIGNING_PRIVATE_JWK`: EC private JWK for the current signing key. Keep it in environment-scoped secrets.
- `UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS`: JSON array of previous public JWKs retained during rotation.

After restart, verify `/.well-known/ucp` includes top-level `keys[]` with public JWKs only. The runtime publishes the UCP `2026-08-25` key set and signs no UCP response with it. Re-open the retired `2026-04-08` profile only if an onboarding platform cannot negotiate `2026-08-25`.

Rotate by adding the current public key to `UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS`, installing the new private JWK and key id, deploying, then removing old public keys.

## Forward Readiness Posture

General UCP response signing is deferred for v1, and no UCP response, including checkout, is signed. Operators should not promise signed UCP responses; protected writes rely on signed requests, digest verification, OAuth scope, durable idempotency, and audit evidence.

Headless checkout completion uses only the stored-payment-method rail: a signed agent names a saved checkout instrument, and the agent grant spending mandate gates the charge. Agent-provided payment instruments, including Stripe shared payment tokens, are never submitted headlessly. OAuth ChatGPT calls and every other completion return trusted checkout handoff continuations instead of creating orders or payments.

Check OAuth metadata:

```powershell
Invoke-RestMethod http://localhost:7712/.well-known/oauth-authorization-server
```

OAuth identity linking requires Authorization Code with PKCE S256. Token refresh rotates the refresh token on every successful refresh.

Authorization GET must redirect to `/account/agents/consent` (or `/sign-in` with the authorize return path), never directly to a callback with a code. Consent displays the client-provided name, redirect origin, active account, and grouped scope labels. Approve or Deny submits a native same-origin POST; only Approve can issue a code. Deny preserves state and returns `access_denied`. A stale, used, foreign-session, or switched-account token must be rejected without a client redirect. Restart from the agent after the ten-minute expiry. Switching accounts restarts authorize and requires a new consent decision. Agent-bearer and guest-checkout actors must sign in interactively instead.

Do not retain raw consent tokens, callback codes, or full token-bearing URLs in diagnostic logs. Token, refresh, introspection, and revocation behavior is unchanged.

Token support endpoints:

- `/ucp/oauth/token`: `authorization_code` and `refresh_token`
- `/ucp/oauth/register`: RFC 7591 public-client registration for agent platforms
- `/ucp/oauth/introspect`: active token, account, scope, and client/profile diagnostics
- `/ucp/oauth/revoke`: access-token or refresh-token revocation
- `/ucp/oauth/authorizations` and its grant-management routes: interactive-session account list, detail, activity, webhook configuration/deliveries, consent revocation, and spending mandate. Agent bearer tokens and guest-checkout actors receive 401 `login_required` without management reads or writes. Token-holder revocation through `/ucp/oauth/revoke` remains available.

Order reads are available through the linked account when that account is the buyer or seller on the order:

```powershell
Invoke-RestMethod http://localhost:7712/ucp/v1/orders/<order-id> -Headers @{ Authorization = "Bearer <ucp-access-token>" }
```

## Incident Response

## UCP 2026-08-25 Response Shape And Cutover Drill

Successful REST and MCP responses use `ucp.status: "success"` and place the
resource at the response root. Error responses use `ucp.status: "error"` with
no resource and `messages[]` entries containing `type: "error"`, `code`,
`content`, `severity` (`recoverable`, `requires_buyer_input`,
`requires_buyer_review`, or `unrecoverable`), and an optional `path`.

After cutover, run the deploy smoke profile-less catalog success check, verify
both `/.well-known/ucp` and `/ucp/v1` profile routes, and compare representative
REST and MCP catalog and checkout bytes for parity. Re-open the retired
`2026-04-08` profile only when an onboarding platform cannot negotiate
`2026-08-25`.

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
- Payment-handler support is guarded: Payments declares trusted, Stripe shared-payment-token, and stored-payment-method handlers. Only the stored-payment-method handler completes headlessly; the others require trusted UI.
- A completion request without a saved checkout instrument returns trusted checkout handoff with no money-moving side effects.
- Stripe webhook configuration includes `shared_payment.granted_token.used` and `shared_payment.granted_token.deactivated` alongside PaymentIntent, Checkout Session, refund, dispute, Connect, and payout events.
- Staging smoke confirms `/.well-known/ucp`, `/.well-known/oauth-authorization-server`, PKCE/refresh metadata, `/ucp/v1`, `/ucp/mcp`, native `/mcp` discovery/authentication posture, and linked-account order reads on the marketplace host.

## Marketing Certification Gate

Do not market UCP or the Agent Payments Protocol as launch-ready, agent-commerce capable, autonomous-payment capable, or headless-checkout capable until a separate certification record is approved. The public launch posture is trusted checkout handoff: agents may prepare or inspect supported shopping flows, but account-scoped checkout completion must move through buyer UI review unless the agent completes with the buyer's saved payment method under the agent grant spending mandate.

The certification record must include:

- Signed-write rejection evidence for missing, expired, replayed, or untrusted signatures.
- Business signing key configuration, public-key discovery, and rotation rehearsal.
- Provider-backed Stripe Shared Payment Token PaymentIntent path, including token-use webhooks and replay-safe failure behavior.
- OAuth authorization-code plus PKCE evidence, refresh-token rotation, token introspection, revocation, and linked-platform consent removal.
- Trusted Checkout Handoff evidence showing unsupported or unsigned ChatGPT app calls do not create orders, payments, or spend authorizations.
- Incident-response evidence covering profile/client pause, token revocation, replay search, idempotency conflict review, and duplicate-effect checks.
- Support and Finance review for buyer consent, payment liability, refund/dispute handling, and agent-abuse escalation.

Until that record exists, Public Presence, launch notes, sales collateral, and promo-bar messages must avoid UCP, Agent Payments Protocol, autonomous payment, headless checkout, AI-agent checkout, Payment Handler, Shared Payment Token, and agent-commerce claims.
