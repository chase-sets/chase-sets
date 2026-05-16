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

## Signed Checkout Writes

Checkout write requests must include:

- `UCP-Agent`
- `Signature-Input`
- `Signature`
- `Content-Digest`
- `Idempotency-Key`

Current runtime verifies required headers, SHA-256 body digest, and replay/idempotency before invoking checkout write handlers. Production platform-api composition wires the Postgres-backed UCP idempotency store and profile/key cache from the platform control database. When configured with a UCP profile/key resolver, it also verifies RFC 9421 HTTP Message Signatures against the signer's public key.

## AP2 Merchant Authorization

Configure checkout-term signing before enabling AP2-capable external smoke:

- `UCP_BUSINESS_SIGNING_KEY_ID`: current merchant signing key id, for example `merchant-2026-q2`.
- `UCP_BUSINESS_SIGNING_ALG`: `ES256`, `ES384`, or `ES512`; prefer `ES256`.
- `UCP_BUSINESS_SIGNING_PRIVATE_JWK`: EC private JWK for the current signing key.
- `UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS`: JSON array of previous public JWKs retained during rotation.

After restart, verify `/.well-known/ucp` includes `signing_keys` and checkout responses include `checkout.ap2.merchant_authorization`.

Rotate by adding the current public key to `UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS`, installing the new private JWK and key id, deploying, then removing old public keys after all AP2 mandate retention windows have expired.

Check OAuth metadata:

```powershell
Invoke-RestMethod http://localhost:7712/.well-known/oauth-authorization-server
```

OAuth identity linking requires Authorization Code with PKCE S256. Token refresh rotates the refresh token on every successful refresh. Token support endpoints:

- `/ucp/oauth/token`: `authorization_code` and `refresh_token`
- `/ucp/oauth/introspect`: active token, account, scope, and client/profile diagnostics
- `/ucp/oauth/revoke`: access-token or refresh-token revocation
- `/ucp/oauth/authorizations`: signed-in account list and consent revocation

Order reads are available through the linked buyer or seller account:

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
- Staging smoke confirms `/.well-known/ucp`, `/.well-known/oauth-authorization-server`, PKCE/refresh metadata, `/ucp/v1`, `/ucp/mcp`, and linked-account order reads on the marketplace host.
