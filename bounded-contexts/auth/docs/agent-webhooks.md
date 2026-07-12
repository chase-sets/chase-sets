# Agent order-update webhooks

Auth stores an agent platform's callback URL and signing secret on its OAuth client registration. The initial dynamic client registration response returns the secret once. Reads return only a non-reversible preview.

## Account API

The connected-agents API addresses webhook configuration through an owned authorization (grant):

- `GET /ucp/oauth/authorizations/:id/webhook` returns `callback_url`, a secret preview, and its creation time.
- `PUT /ucp/oauth/authorizations/:id/webhook` accepts `{ "callback_url": "https://agent.example/hooks" }` to replace the endpoint and rotate the secret, or `{ "callback_url": null }` to disable it. A replacement response returns the new secret exactly once.
- `GET /ucp/oauth/authorizations/:id/webhook-deliveries` returns account-owned delivery summaries. Add `status=dead-letter` to limit the result to terminal failures.

Every management request first verifies that the grant belongs to the signed-in account. A client registration is shared by its grants, so replacing a callback changes delivery for every active grant using that OAuth client.

## Signature verification

The sender posts the exact JSON body with these headers:

```text
Agent-Webhook-Signature: t=<unix-seconds>,v1=<lowercase-hex-hmac-sha256>
Agent-Webhook-Id: <delivery-id>
Agent-Webhook-Event-Type: <source-event-type>
```

Compute HMAC-SHA256 over `${timestampSeconds}.${rawBody}` with the registered secret. Reject timestamps outside a five-minute window, parse the raw request body without re-serialization, and compare the digest in constant time. `verifyAgentWebhookSignature` in the Auth export is the reference implementation.

## Operator staging proof

The local in-process lifecycle test covers projection, signing, callback verification, and the full five-state lifecycle; the adjacent dispatcher fixtures cover retry and dead-letter transitions. The literal staging proof requires operator-owned staging credentials and an approved receiver:

1. Register an OAuth client with `order:read` and an HTTPS callback, then link it to a staging account.
2. Drive one order through created, shipped, delivered, cancelled, and refunded paths using the representative-commerce workflow.
3. Capture each request body and signature, verify each raw body with `verifyAgentWebhookSignature`, and record the delivery IDs.
4. Return HTTP 500 from the receiver and confirm exponential `next_attempt_at` values, then confirm a terminal `failed` row after `max_attempts`.

Do not use an unapproved public request-bin or commit staging credentials/evidence to the repository.
