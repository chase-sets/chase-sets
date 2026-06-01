# Postage Operations Runbook

This runbook covers postage label provider configuration and operational checks for Fulfillment.

## System Boundaries

- Fulfillment owns shipment state, package assembly, label references, tracking identifiers, and delivery outcomes.
- `@chase-sets/postage-labels` defines the provider-neutral postage label port.
- EasyPost is the first USPS-compatible provider adapter.
- Local development and tests use the sandbox adapter unless EasyPost configuration is supplied.
- Deployables compose the configured provider into Fulfillment through the `postageLabelProvider` host port.

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

## Label Flow

The EasyPost adapter creates shipments from sender and recipient addresses plus package dimensions and weight, returns USPS rates, buys the selected rate, and provides the tracking number and label document URL.

USPS label refunds are modeled as label void requests. A voided label moves the shipment back to awaiting a label while preserving provider refund metadata on the shipment read model.

## Operational Checks

Before enabling a real postage provider in a shared environment:

1. Confirm the platform API starts with the intended provider mode.
2. Purchase a test label through a seller shipment workflow.
3. Confirm the shipment timeline stores provider-neutral references only.
4. Void the label and confirm the shipment returns to awaiting-label state.
5. Configure the EasyPost webhook destination with the matching `EASYPOST_WEBHOOK_SECRET`.
6. Confirm `tracker.updated` callbacks create `fulfillment_postage_provider_events` rows and advance Fulfillment shipment state only.
7. Confirm tracking updates do not mutate Ordering, Payments, or Settlement state directly.

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
9. Operator rollback is documented: if EasyPost production proof fails after marketplace promotion, set `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false` and redeploy while preserving the Fulfillment evidence record and failed provider references for investigation.

Do not commit live EasyPost labels, addresses, API keys, tracking URLs with private account data, or provider account screenshots to the repository. Store the evidence in the approved launch record and reference it with `PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE`.

Build the redacted launch-packet gate from the production EasyPost proof record instead of hand-editing `gates.fulfillmentPostage`. The proof record must include `proofCompletedAt`; rerun the production postage proof when the proof is older than 30 days at launch review.

```powershell
pnpm run marketplace:fulfillment-postage-evidence -- --proof .\secure\fulfillment-postage-2026-05-30.json --reference FULFILLMENT-POSTAGE-2026-05-30
```

The command fails unless the proof record is production, uses EasyPost production mode, points at the HTTPS `/api/fulfillment/provider/postage/webhooks` destination on a production Chase Sets host, includes the controlled parcel shipment id, EasyPost `shp_` shipment id, EasyPost `pl_` label id, EasyPost `trk_` tracker id, tracking identifier, delivery-exception evidence kind, label void/refund provider object reference, Letter Mailpiece shipment id, at least four `fulfillment_postage_provider_events` `evt_` ids matched to shipments, at least three `tracking-status` `evt_` ids, one `refund-status` `evt_` id, and proves every required parcel label, void/refund, tracking, delivery exception, and Letter Mailpiece rehearsal.

Delivery exception evidence can use `deliveryExceptionEvidenceKind: "provider-event"` with a concrete EasyPost `deliveryExceptionProviderEventId`, or `deliveryExceptionEvidenceKind: "fulfillment-rehearsal"` with a concrete `deliveryExceptionRehearsalShipmentId` from the authenticated Fulfillment exception workflow. This exception-path choice does not replace the EasyPost production provider-event requirements for tracking and refund status rows.

The proof record must include concrete private evidence references for the EasyPost account, webhook destination, provider event query, parcel label purchase, label void/refund, tracking event, delivery exception, and Letter Mailpiece rehearsal. Do not use a single generic approval document as a substitute for these workflow-specific references.
