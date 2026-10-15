# Agent order-update webhooks

Auth stores an agent platform's callback URL and signing secret on its OAuth client registration. The initial dynamic client registration response returns the secret once. Reads return only a non-reversible preview.

## Account API

The connected-agents API addresses webhook configuration through an owned authorization (grant):

- `GET /ucp/oauth/authorizations/:id/webhook` returns `callback_url`, a secret preview, and its creation time.
- `PUT /ucp/oauth/authorizations/:id/webhook` accepts `{ "callback_url": "https://agent.example/hooks" }` to replace the endpoint and rotate the secret, or `{ "callback_url": null }` to disable it. A replacement response returns the new secret exactly once.
- `GET /ucp/oauth/authorizations/:id/webhook-deliveries` returns account-owned delivery summaries. Add `status=dead-letter` to limit the result to terminal failures.

Every management request requires an interactive session actor, then verifies that the grant belongs to the signed-in account. Agent bearer tokens and guest-checkout actors are refused with 401 `login_required` before any management read or write. A client registration is shared by its grants, so replacing a callback changes delivery for every active grant using that OAuth client.

## Revocation Support

The support release preserves dormant token and Account revocation, including the existing Account cleanup and detach behavior. Activation is an explicit deployment-pipeline action, not application startup. Its privileged Identity command requires fresh complete API/worker evidence and a membership admission fence through the atomic activation append. Existing dormant requests must settle; an unresolved request on a serving instance refuses activation. Revoked Grants are adopted for local recovery with their recorded time and reason, not assumed complete.

After activation, token and interactive Account requests share the Identity-owned [Agent Grant Revocation Operation](../../identity/GLOSSARY.md#agent-grant-revocation-operation). Auth resumes only missing effects. Payments removes agent-usable instruments and defaults locally and atomically publishes its affordance and completion marker. This owner path makes no provider call or deferred-detach promise; provider attachments can remain. Explicit Account removal and late-setup detach retain their separate behavior.

Enqueued webhooks retain their Account and causal Grant IDs. Each send checks those exact Grants under Identity's exported fence. Legacy rows without causal membership fail closed. A claimed send already started may settle once after revocation; it is not resent for a revoked Grant. Pre-POST failures and active-Grant transport failures retain capped retries, without abandoning other claimed deliveries. Recovery claims advance durably across poisoned operations and worker restarts.

The post-activation admission floor also applies to new pods and automatic rollback. The later same-issue removal release retires dormant routing, not the durable floor. Actor and spend-policy checks deny requests observed after terminal authority; they do not cancel an already-admitted downstream charge or make a cross-context transaction.

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

1. Register an OAuth client with `dev.ucp.shopping.order:read` and an HTTPS callback, then link it to a staging account.
2. Drive one order through created, shipped, delivered, cancelled, and refunded paths using the representative-commerce workflow.
3. Capture each request body and signature, verify each raw body with `verifyAgentWebhookSignature`, and record the delivery IDs.
4. Return HTTP 500 from the receiver and confirm exponential `next_attempt_at` values, then confirm a terminal `failed` row after `max_attempts`.

Do not use an unapproved public request-bin or commit staging credentials/evidence to the repository.

## Secret at rest & residual risks

- **Signing secret at rest (tracked follow-up).** `webhook_signing_secret` on `identity_ucp_oauth_clients` is
  stored as plaintext because the dispatcher needs the raw secret to compute an HMAC on every send. The read
  surface is already narrowed to a single resolver (`resolveAgentWebhookSigningSecret`) and the secret is never
  echoed to reads or logs. Column-level encryption / KMS envelope wrapping is a deliberate hardening follow-up
  rather than in-scope here: it needs a new at-rest crypto primitive (none exists in the repo today), a key
  source, and a backfill migration over a shared table. Because the access surface is a single resolver, that
  upgrade stays local when it lands.
- **Historical shipment → order resolution coupling.** Current `fulfillment.shipment.dispatched` events carry
  their order and buyer routing facts directly. Historical thin events still use `resolveShipmentOrderId`, which
  reads `ordering_fulfillment_cancellation_inputs`; if the historical shipment row has not projected there, the
  lookup resolves to `null` and the `shipped` delivery is skipped (it is not retried from the projector).
