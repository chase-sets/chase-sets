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

Current runtime verifies required headers, SHA-256 body digest, and replay/idempotency before invoking checkout write handlers. When configured with a UCP profile/key resolver, it also verifies RFC 9421 HTTP Message Signatures against the signer's public key. Production enablement must provide durable key/profile caching, durable idempotency storage, response signing policy, and telemetry for signature failures.

## Incident Response

For suspected replay or agent abuse:

- Pause the platform/client in Identity once linked-platform authorization exists.
- Revoke OAuth tokens and refresh tokens.
- Search UCP audit records by agent profile, operation, account, and idempotency key.
- Compare `Content-Digest` values for duplicate or tampered requests.
- Confirm no duplicate Ordering or Payments facts were emitted.

## Production Readiness Gates

- UCP profile advertises only capabilities with wired bounded-context handlers.
- OAuth identity linking maps UCP scopes to Chase Sets permissions.
- Signature verification resolves agent keys from UCP profile/key discovery and is enabled in production runtime composition.
- Idempotency records are durable and survive process restarts.
- Staging smoke confirms `/.well-known/ucp`, `/ucp/v1`, and `/ucp/mcp` on the marketplace host; trusted checkout handoff stays covered by focused Checkout UCP tests until AP2 payment-handler handoff and order reads are implemented.
