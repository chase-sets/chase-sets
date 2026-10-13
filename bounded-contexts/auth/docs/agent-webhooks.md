# Agent order-update webhooks

Auth stores an agent platform's callback URL and signing secret on its OAuth client registration. The initial dynamic client registration response returns the secret once. Reads return only a non-reversible preview.

## Account API

The connected-agents API addresses webhook configuration through an owned authorization (grant):

- `GET /ucp/oauth/authorizations/:id/webhook` returns `callback_url`, a secret preview, and its creation time.
- `PUT /ucp/oauth/authorizations/:id/webhook` accepts `{ "callback_url": "https://agent.example/hooks" }` to replace the endpoint and rotate the secret, or `{ "callback_url": null }` to disable it. A replacement response returns the new secret exactly once.
- `GET /ucp/oauth/authorizations/:id/webhook-deliveries` returns account-owned delivery summaries. Add `status=dead-letter` to limit the result to terminal failures.

Every management request requires an interactive session actor, then verifies that the grant belongs to the signed-in account. Agent bearer tokens and guest-checkout actors are refused with 401 `login_required` before any management read or write. A client registration is shared by its grants, so replacing a callback changes delivery for every active grant using that OAuth client.

## Revocation Authority

Identity owns one retained Agent Grant Revocation Operation per Account and Grant. Auth coordinates Identity terminal authority, Payments local instrument removal/audit/affordance publication, webhook exclusion, and completion. Token and Account revokes resume the same owner operation, including a known expired or revoked token. Unknown or malformed present tokens return 200 with no writes; missing tokens retain 400. An unavailable effect never produces a completion receipt.

Account callers may send one UUID in both `Idempotency-Key` and `attempt_id`; the values must agree. Old clients without an attempt UUID receive a stable server-derived binding. `GET /ucp/oauth/authorizations/:id/revocation/:attemptId` performs a read only, after interactive session and Account ownership admission. The detail route retains its attempt, reads once after a lost response, and never automatically submits a second write.

The outbox freezes eligible Grant IDs during enqueue under Identity's owner fence. Replay cannot add later Grants. Claim and send do not infer authority from the Auth projection or the current Client membership. Legacy rows have no causal Grant membership proof and fail closed, including tied or skewed timestamps. Pending revoked rows terminalize; an already-entered send settles only its original delivery. A lost response or stranded `sending` claim becomes `delivery_outcome_unknown`, never another POST. Explicit callback failures still use bounded retries while a bound Grant remains active.

Grant cleanup makes zero provider calls. Provider attachments may remain; there is no deferred-detach promise. Account instrument removal and late setup-result cleanup retain their existing detach behavior. Mandate and callback configuration remain their existing contracts; only their revoked-Grant commit admission is fenced here.

## Support Then Activation

The additive Identity support indexes and Auth `grant_ids` migration install dormant support. Installing support or restarting does not create the Identity activation event. Before activation, known-token and Account revoke requests return a safe temporary failure and the new revoke UI is unavailable. After activation, old token/Account payloads still work without a new client field.

The host with cluster access must capture **every serving platform-api and platform-worker replica**, with the actual commit and image digest, after support deployment and immediately before the activation deploy. It passes that complete inventory to `agentGrantRevocations.activate` through its trusted deployment composition; the internal method is not a user API. The capture must be no more than five minutes old, include both roles, and contain only support-version-1 replicas. Synthetic tests validate the admission shape only; they are not a captured host proof.

After any operation is used, rollback is limited to binaries retaining support version 1, exact Identity authority, provider-free cleanup, immutable outbox Grant membership and the recovery runner. The host must refuse a pre-support binary; the old binary cannot enforce a contract it never contained. No SQL cleanup or manually fabricated completion is a recovery path. Restarted workers read the retained owner phases and run only missing effects. The required real pre-activation host capture is not supplied by this implementation lane.

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
