# Checkout Support Operations

This runbook covers the support workflows for the Shopify-simple Buy Cart and
Sell List checkout: stuck checkout, payment dispute, missing or failed
downstream handoff, and refund request scenarios.

Use this together with:

- [Checkout Fresh-State Release](./checkout-fresh-state-release.md)
- [Money Operations](./money-operations.md)
- [Support Operations Readiness](../../bounded-contexts/platform-operations/docs/support-operations-readiness.md)

## Ownership Boundaries

- Checkout owns pre-confirmation readiness, optimization, checkout session,
  confirmation, pending downstream handoff, and support-safe checkout reference
  state.
- Platform Operations owns structured support requests, the support operations
  queue, evidence, responses, escalation, resolution, close, and cancel
  lifecycle.
- Payments owns payment status, payment failure classification, refund effects,
  refund ids, payment disputes, and provider callback reconciliation.
- Settlement owns seller proceeds holds, hold release, payout hold/reversal, and
  wallet-ledger consequences.
- Ordering and Fulfillment own committed order, shipment, label, and fulfillment
  facts. Support may reference those facts, but must not create them or mark
  pending handoff as committed.
- Notifications owns customer communication delivery. Support may require
  notification evidence, but notification failure does not make Support the
  delivery source of truth.

Do not open a fake order or sale support request for a checkout that has not
confirmed. If no order source exists yet, treat the case as Checkout-owned
recovery or launch incident triage using the support-safe checkout reference.

## Safety Rules

- Use only support-safe references in tickets, screenshots, GitHub comments, and
  support notes. Do not paste raw checkout session ids, account ids, emails,
  addresses, provider payloads, card or bank details, full URLs, cookies,
  after-write receipts, or sensitive risk signals.
- Never route a customer to the dense legacy checkout, old checkout links, old
  session payloads, migration/backfill helpers, hidden repair, or dual-write
  behavior.
- Items without fulfillment assignment stay in cart, Sell List, or the
  conditional pre-checkout readiness step. Support must not ask Checkout to
  assign fulfillment inside the payment form.
- Optional fulfillment savings optimization is pre-checkout only. If the
  customer accepted or declined optimization, support records that decision as a
  readiness fact and does not reopen optimization inside checkout.
- Support records pending downstream handoff as pending. It must not tell a
  buyer or seller that order, sale, label, payout, settlement, notification, or
  account-history completion happened until the owning context commits it.

## Required Operator Access

- Admin actor with `support.manage`.
- Support operations page: `/support/requests`.
- Support API routes mounted under `/api/marketplace/support-requests`.
- Checkout support lookup API:
  `/api/marketplace/support/checkout-references/:supportReference`.

## Scenario Triage Matrix

| Scenario | First owner | Support flow when an order source exists | Required evidence |
| --- | --- | --- | --- |
| Stuck checkout before confirmation | Checkout | Do not open an order support request; record launch incident or support note against the support-safe checkout reference. | Checkout recovery state, readiness snapshot status, release-health or dashboard link, no-side-effect evidence. |
| Stuck checkout after confirmation but before downstream commit | Checkout plus downstream owner | Use `payment-problem`, `seller-cannot-fulfill`, or `shipping-label-or-tracking` only when the committed order source exists. | Confirmation id/reference, pending handoff status, owning-context status, support-safe reference. |
| Payment failure, dispute, or duplicate charge concern | Payments | `payment-problem` for active payment issue; `refund-status` for existing refund follow-up. | Payment-owned status, support-safe provider category, refund/dispute reference when available, no raw provider payload. |
| Missing or failed order/sale/account-history handoff | Checkout plus Ordering or Settlement | Open the narrow flow that matches the committed order issue; otherwise keep pending handoff as a Checkout support-safe lookup. | Confirmation id, Marketplace handoff id, downstream pending/failed/recovered status, no synthesized completed fact. |
| Seller cannot fulfill after order creation | Fulfillment plus Support | `seller-cannot-fulfill`. | Seller attestation, order source, fulfillment status, settlement hold evidence. |
| Label, tracking, or carrier problem | Fulfillment plus Support | `shipping-label-or-tracking`. | Tracking or label problem summary, carrier status if available, no raw provider payload. |
| Buyer asks for refund | Payments plus Support | `refund-status` for status; product issue flow for new evidence; refund-producing resolution only after support review. | Buyer `sup_` request id, Payments `sre_` refund effect id, Payments `rfd_` refund id, Settlement `hold_` id and hold-release evidence. |

## Stuck Checkout Procedure

1. Ask for the support-safe checkout reference, not a URL or raw session id.
2. Look up the reference in the Checkout support lookup API and check whether
   the customer reached confirmation.
3. If not confirmed:
   - verify the checkout-visible state is review, preparing, stale recovery,
     disabled, or permanent recovery;
   - verify no payment, order, label, payout, settlement, notification,
     account-history, Marketplace handoff, refund, void, or reversal side
     effect was attempted;
   - route the customer back to Buy Cart, Sell List, or readiness recovery when
     the state is stale, blocked, or unresolved;
   - capture dashboard evidence if the state indicates a service incident.
4. If confirmed but downstream handoff is pending:
   - keep the customer-facing status pending;
   - inspect the Checkout confirmation/handoff evidence first;
   - escalate to Ordering, Fulfillment, Settlement, Payments, or Notifications
     only for the specific downstream status that is failed or delayed.
5. Do not open an order support request until an order source exists. If an
   order source exists, choose the narrow support flow from the triage matrix.

## Payment Dispute Or Failure Procedure

1. Confirm there is a committed payment or payment attempt owned by Payments.
2. Open `payment-problem` when the customer needs active payment investigation.
3. Open `refund-status` only when a refund already exists or support is
   tracking a refund-producing resolution.
4. Attach support-safe payment status and provider category. Store Stripe
   object ids, dashboard screenshots, and raw provider details only in the
   private evidence workspace.
5. If support resolves with a refund-producing resolution, verify the Payments
   support-refund effect row and Settlement hold/hold-release evidence before
   closing the request.

## Missing Or Failed Downstream Handoff Procedure

1. Start from Checkout confirmation/handoff evidence:
   - confirmation reference;
   - readiness snapshot/version;
   - reviewed line/action keys;
   - Marketplace handoff id;
   - downstream status fields.
2. Classify the state as pending, committed, failed, recovered, held, reversed,
   or deferred.
3. For pending state, keep support copy pending and do not open a completed
   order/sale/label/payout support claim.
4. For failed state, route to the owning context:
   - Ordering for committed order/history failures;
   - Fulfillment for label, tracking, carrier, or package failures;
   - Settlement for payout, hold, or wallet failures;
   - Payments for payment, refund, dispute, or duplicate-charge failures;
   - Notifications for missing or duplicate customer communication.
5. Record the support-safe reference and owning-context evidence. Do not repair
   by creating a dense checkout fallback, old receipt row, hidden migration, or
   manual dual write.

## Refund Request Procedure

1. Confirm the order source exists and the requester is the buyer, seller, or
   support actor allowed by the support flow.
2. Use the product issue flow when the refund request needs buyer/seller
   evidence, such as not received, not as described, damaged, wrong product, or
   missing products.
3. Use `refund-status` when the refund already exists and the customer needs
   status.
4. For a refund-producing support resolution, capture:
   - buyer `sup_` support request id;
   - Payments `sre_` refund effect id;
   - Payments `rfd_` refund id;
   - Settlement `hold_` id;
   - separate Settlement hold and hold-release evidence references;
   - support notification evidence.
5. Keep the support request open until Payments and Settlement evidence is
   attached or an approved deferral path is recorded.
