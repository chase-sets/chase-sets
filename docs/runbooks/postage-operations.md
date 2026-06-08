# Postage Operations Runbook

This runbook covers postage label provider configuration and operational checks for Fulfillment.

## System Boundaries

- Fulfillment owns shipment state, package assembly, label references, tracking identifiers, and delivery outcomes.
- Ordering owns postage policy authoring, active policy resolution, package-plan evaluation, and immutable order snapshots.
- `@chase-sets/postage-labels` defines the provider-neutral postage label port.
- EasyPost is the first USPS-compatible provider adapter.
- Local development and tests use the sandbox adapter unless EasyPost configuration is supplied.
- Deployables compose the configured provider into Fulfillment through the `postageLabelProvider` host port.

## Admin Policy Changes

Use Admin Web > Postage Policies to create and revise draft policies. Review parcel-required options, letter thresholds, physical flags, and signature requirements before activation.

Activation affects new checkout and accepted-offer orders only. Existing orders and shipments keep their committed package-plan snapshot. Do not mutate existing orders to simulate a policy rollback.

To roll back an active policy, create or revise a draft that matches the previous policy version and activate it. Fulfillment must continue using the shipment snapshot it received from Ordering.

## EasyPost Configuration

Platform API settings:

- `EASYPOST_API_KEY`: server-side EasyPost key. Use a test key for sandbox label purchase flow testing.
- `EASYPOST_WEBHOOK_SECRET`: EasyPost webhook HMAC secret. Required in production whenever EasyPost postage is configured.
- `EASYPOST_MODE`: `test` or `production`; defaults to `test`.
- `EASYPOST_API_BASE_URL`: optional override for non-default environments.

EasyPost webhook destination:

- Production: `https://api.<environment-host>/api/fulfillment/provider/postage/webhooks`
- Local or staging: use the matching platform API origin with the same `/api/fulfillment/provider/postage/webhooks` path.

Fulfillment verifies EasyPost HMAC headers before normalizing provider payloads. The provider event id is idempotent in `fulfillment_postage_provider_events`; duplicates should return as duplicates without replaying shipment domain commands.

## Package Plan Defaults

Ordering commits a package plan when an order is created. Fulfillment projects that plan onto the shipment and uses it as the default source of package dimensions and weight for USPS label purchase.

Manual package fields are an override path. Operators should only use them when the physical package differs from the committed plan; normal seller fulfillment follows the shared marketplace packaging policy.

Letter mailpieces are not parcel labels. If an order is planned as a letter, Fulfillment should use the letter preparation path instead of buying a USPS parcel label.

Package plans created by new orders include `postagePolicySnapshot` with policy version, parcel-required result and reasons, and signature-required result and reasons. Legacy package plans without that metadata remain fulfillable only through the explicit compatibility behavior covered by the milestone cleanup checklist.

## Fulfillment Enforcement

Fulfillment label purchase reads `shipping_plan_snapshot.postagePolicySnapshot`. If `signatureRequired` is true, the provider-neutral postage label request uses signature delivery confirmation. EasyPost maps that to the provider shipment option for signature confirmation.

Address and package overrides remain operational overrides. They do not remove signature requirements committed by Ordering, and they must not convert a parcel-required shipment into a non-compliant letter flow.

Validation failures are recorded as failed postage label operations before any provider call. Provider capability failures and generic provider errors are also recorded as failed operations and reflected on the shipment label status. The support-facing shipment detail page exposes only bounded diagnostic facts: buyer shipping option, committed policy version, parcel/signature requirements, requested mailpiece class, requested service level, delivery confirmation, label status, provider outcome, and redacted provider event status. Raw provider payloads, sender addresses, and recipient addresses must not be copied from operation tables into support diagnostics.

## Label Flow

The EasyPost adapter creates shipments from sender and recipient addresses plus package dimensions and weight, returns USPS rates, buys the selected rate, and provides the tracking number and label document URL.

USPS label refunds are modeled as label void requests. A voided label moves the shipment back to awaiting a label while preserving provider refund metadata on the shipment read model.

Rebuy after void must use the original Fulfillment shipment `shipping_plan_snapshot`; do not re-evaluate the active Ordering postage policy for the shipment. If the original snapshot required parcel or signature, the rebuy path must continue enforcing those requirements even after operators activate a newer Admin postage policy.

EasyPost can complete USPS refunds asynchronously after the void request. EasyPost's [shipping refund](https://docs.easypost.com/docs/shipments/shipping-refund) and [event](https://docs.easypost.com/docs/events) docs describe USPS refund processing as delayed and `refund.successful` as the Event created when a non-instantaneous refund completes. Fulfillment launch proof therefore needs both the synchronous void result and the later EasyPost refund lifecycle callback. The EasyPost adapter normalizes `refund.*` webhook events, including `refund.successful`, into `refund-status` rows in `fulfillment_postage_provider_events`; the launch gate is not satisfied by `label_refund_status` alone.

## Operational Checks

Before enabling a real postage provider in a shared environment:

1. Confirm the platform API starts with the intended provider mode.
2. Purchase a test label through a seller shipment workflow.
3. Confirm the shipment timeline stores provider-neutral references only.
4. Void the label and confirm the shipment returns to awaiting-label state.
5. Configure the EasyPost webhook destination with the matching `EASYPOST_WEBHOOK_SECRET`.
6. Confirm `tracker.updated` callbacks create `fulfillment_postage_provider_events` rows and advance Fulfillment shipment state only.
7. Confirm tracking updates do not mutate Ordering, Payments, or Settlement state directly.

When diagnosing a failed label purchase:

1. Open the seller shipment detail page and inspect Postage diagnostics.
2. Compare buyer shipping option with the committed policy version, parcel-required result, signature-required result, and policy reasons.
3. Check the latest postage label operation. A `postage_policy_validation_failed` shipment label error means Fulfillment rejected a non-compliant label request before the provider was called.
4. If the operation failed with `postage_provider_capability_failure`, confirm whether the provider mode supports the requested bounded capability, such as signature delivery confirmation.
5. If the operation failed with another provider error, use the provider-neutral shipment id, label id, tracking identifier, provider event id, and redacted provider status fields to investigate in the provider console.
6. Do not expose `request_json` address contents or `payload_json` provider payloads in tickets, logs, launch evidence, or GitHub issues. Redact provider account internals and private address data.

Use this query shape for support diagnostics when a database check is necessary:

```sql
SELECT operation_kind,
       provider_name,
       provider_mode,
       status,
       request_json #>> '{serviceLevel}' AS requested_service_level,
       request_json #>> '{deliveryConfirmation}' AS requested_delivery_confirmation,
       request_json #>> '{package,mailpieceClass}' AS requested_mailpiece_class,
       request_json #>> '{postagePolicySnapshot,policyVersion}' AS policy_version,
       request_json #>> '{postagePolicySnapshot,parcelRequired}' AS parcel_required,
       request_json #>> '{postagePolicySnapshot,signatureRequired}' AS signature_required,
       error_message,
       created_at,
       completed_at
FROM fulfillment_postage_label_operations
WHERE shipment_id = '<shipmentId>'
ORDER BY created_at DESC
LIMIT 25;
```

Provider event diagnostics should select bounded event columns only. Do not select `payload_json` for routine support work.

Before closing postage snapshot cleanup:

1. Confirm recent orders have `shipping_plan_snapshot.postagePolicySnapshot.policyVersion`.
2. Confirm checkout copy does not imply signature outside the evaluated policy result.
3. Confirm label operation requests include `deliveryConfirmation` only when the snapshot requires signature.
4. Confirm no production shipment awaiting label depends on missing policy metadata for a policy-required decision.
5. Confirm new label operation requests no longer persist sender or recipient address bodies in `request_json`; historical rows that predate this cleanup remain retained audit data and must not be exposed through support diagnostics.
6. Confirm temporary migration scripts and backfill flags are removed or documented as retained audit data.

Run the read-only cleanup evidence report against the target environment before closing the cleanup gate:

```powershell
pnpm run postage-policy:cleanup-evidence -- --environment=production --ordering-database-url=$env:ORDERING_DATABASE_URL --fulfillment-database-url=$env:FULFILLMENT_DATABASE_URL
```

The report must show `activeSnapshotCoverageComplete: true` before the cleanup gate is closed. Historical immutable snapshots remain retained audit data; the cleanup gate is about active rows, runtime decision paths, and temporary migration artifacts.

For production prelaunch proof, first deploy private proof mode with `PRODUCTION_MARKETPLACE_PROOF_ENABLED=true` and `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false`; DigitalOcean then routes `https://chasesets.com/api/fulfillment/provider/postage/webhooks` to `platform-api` while normal public/admin `/api/*` traffic remains on admin-support.

Run `pnpm run marketplace:production-proof-readiness` before EasyPost dashboard setup and use `operatorSetup.easyPostWebhookSetup` from its JSON output as the canonical production setup checklist. The checklist carries the exact production webhook destination, the required GitHub secret name, provider-event kinds expected in Fulfillment proof, and the launch evidence fields that must be backed by the resulting EasyPost records. Do not hand-enter alternate callback URLs.

## Production EasyPost Proof

Before production marketplace promotion, Fulfillment must approve production postage readiness with `PRODUCTION_FULFILLMENT_POSTAGE_APPROVED=true` and a non-empty `PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE` in the production GitHub Environment. The reference must point to the Fulfillment-owned rehearsal record. Keep approval unset while production remains landing/admin-support only or until every production-mode EasyPost proof below is complete.
The redacted [Marketplace Launch Evidence](./marketplace-launch-evidence.md) packet must carry the same approval and reference before operators set the production GitHub Environment values.

The rehearsal record must include:

1. EasyPost production mode is configured for production promotion with a live EasyPost key, `EASYPOST_MODE=production`, `EASYPOST_WEBHOOK_SECRET`, and no non-default `EASYPOST_API_BASE_URL` unless the provider has approved it.
2. A low-risk parcel label is purchased through the seller shipment workflow, using the Ordering-committed Package Plan as the default dimensions and weight.
3. The shipment timeline and read model store provider-neutral label references, tracking identifiers, selected rate, label document URL, and provider metadata without leaking EasyPost internals into Ordering, Payments, or Settlement.
4. The purchased label is voided through the Fulfillment workflow, provider refund metadata is retained, and the shipment returns to awaiting-label state.
5. The production EasyPost dashboard has an active webhook destination pointing at `/api/fulfillment/provider/postage/webhooks`.
6. Tracking, delivery, and label lifecycle provider callbacks are processed and reflected only as Fulfillment-owned tracking state and integration facts, with redacted `fulfillment_postage_provider_events` query output showing at least four production EasyPost event rows matched to controlled shipments, at least three `tracking-status` rows, and at least one `refund-status` row attached.
7. At least one delivery exception scenario is rehearsed or provider-simulated so downstream Support, Payments, and Settlement owners know which Fulfillment facts they will receive.
8. A Letter Mailpiece order is rehearsed through the non-parcel preparation path. Fulfillment must not purchase a USPS parcel label for a shipment that Ordering planned as a letter.
9. A signature-required parcel label is rehearsed through the policy snapshot path. Fulfillment must pass provider-neutral signature delivery confirmation and keep provider-specific option names out of Ordering events.
10. Operator rollback is documented: if EasyPost production proof fails after marketplace promotion, set `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false` and redeploy while preserving the Fulfillment evidence record and failed provider references for investigation.

Do not commit live EasyPost labels, addresses, API keys, tracking URLs with private account data, or provider account screenshots to the repository. Store the evidence in the approved launch record and reference it with `PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE`.

Before assembling or refreshing the Fulfillment postage proof record, run the read-only provider proof status report and attach its redacted Fulfillment section to the private evidence record:

```powershell
pnpm run marketplace:provider-proof-status -- --environment production --payments-database-url "$env:PAYMENTS_DATABASE_URL" --settlement-database-url "$env:SETTLEMENT_DATABASE_URL" --fulfillment-database-url "$env:FULFILLMENT_DATABASE_URL"
```

The report summarizes `fulfillment_postage_provider_events`, postage label operations, and shipment label status rows so operators can see whether tracking, refund, purchase, and void evidence exists before running the launch gate command. It is status evidence only and does not replace `pnpm run marketplace:fulfillment-postage-evidence`.

Build the redacted launch-packet gate from the production EasyPost proof record instead of hand-editing `gates.fulfillmentPostage`. The proof record must include `proofCompletedAt`; rerun the production postage proof when the proof is older than 30 days at launch review.

```powershell
pnpm run marketplace:fulfillment-postage-evidence -- --proof .\secure\fulfillment-postage-2026-05-30.json --reference FULFILLMENT-POSTAGE-2026-05-30
```

The command fails unless the proof record is production, uses EasyPost production mode, points at the HTTPS `/api/fulfillment/provider/postage/webhooks` destination on a production Chase Sets host, includes the controlled parcel shipment id, EasyPost `shp_` shipment id, EasyPost `pl_` label id, EasyPost `trk_` tracker id, tracking identifier, delivery-exception evidence kind, label void/refund provider object reference, Letter Mailpiece shipment id, at least four `fulfillment_postage_provider_events` `evt_` ids matched to shipments, at least three `tracking-status` `evt_` ids, one `refund-status` `evt_` id, and proves every required parcel label, void/refund, tracking, delivery exception, and Letter Mailpiece rehearsal.

Delivery exception evidence can use `deliveryExceptionEvidenceKind: "provider-event"` with a concrete EasyPost `deliveryExceptionProviderEventId`, or `deliveryExceptionEvidenceKind: "fulfillment-rehearsal"` with a concrete `deliveryExceptionRehearsalShipmentId` from the authenticated Fulfillment exception workflow. This exception-path choice does not replace the EasyPost production provider-event requirements for tracking and refund status rows.

### Refund Status Provider Event Evidence

When the controlled parcel label has already been voided, do not purchase another production label just to satisfy the missing `refund-status` row. First use the existing controlled shipment, EasyPost shipment id, label id, tracking code, and refund/provider object reference from the void response.

1. In the EasyPost production dashboard or API, find the refund associated with the controlled EasyPost shipment or tracking code.
2. If the refund is still submitted, wait for EasyPost to complete it. EasyPost documents USPS refund processing as at least 15 days and carrier-dependent processing as no greater than 30 days before `refund_status` moves to `refunded`.
3. When an EasyPost Event with description `refund.successful` is available, redeliver or replay that Event to `https://chasesets.com/api/fulfillment/provider/postage/webhooks` using the configured production webhook destination.
4. Confirm Fulfillment recorded the provider lifecycle fact before updating the launch proof record:

```sql
SELECT provider_event_id,
       event_kind,
       shipment_id,
       tracking_identifier,
       provider_object_reference,
       status,
       received_at
FROM fulfillment_postage_provider_events
WHERE event_kind = 'refund-status'
  AND (
    shipment_id = '<controlledParcelShipmentId>'
    OR tracking_identifier = '<trackingIdentifier>'
    OR provider_object_reference = '<refundOrProviderObjectReference>'
  )
ORDER BY received_at DESC;
```

Attach the redacted EasyPost Event id and query output to the proof record fields that back `providerEventQueryReference`, `labelVoidRefundReference`, and the `refund-status` provider event id. Only buy and void another low-risk production label if the existing refund is confirmed never to emit the required EasyPost Event and Fulfillment approval is explicit.

The proof record must include concrete private evidence references for the EasyPost account, webhook destination, provider event query, parcel label purchase, label void/refund, tracking event, delivery exception, and Letter Mailpiece rehearsal. Do not use a single generic approval document as a substitute for these workflow-specific references.
