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
- `EASYPOST_MODE`: `test` or `production`; defaults to `test`.
- `EASYPOST_API_BASE_URL`: optional override for non-default environments.

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
5. Confirm tracking updates do not mutate Ordering, Payments, or Settlement state directly.
