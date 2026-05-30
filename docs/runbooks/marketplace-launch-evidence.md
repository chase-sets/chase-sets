# Marketplace Launch Evidence

Production stays landing/admin-support until a redacted Marketplace Launch Evidence packet passes verification and the production GitHub Environment is updated from that same packet. The packet is an operator-owned launch record summary; do not commit the live packet when it contains private provider references, buyer or seller data, screenshots, addresses, payment identifiers, or account identifiers.

## Verifier

Run the verifier from the repo root with a redacted packet:

```powershell
pnpm run marketplace:launch-evidence -- --file .\secure\redacted-marketplace-launch-evidence.json
```

The verifier fails closed when required approval gates are missing, references are placeholders, GitHub Environment values drift from the packet, Tax posture contradicts collection readiness, launch supply has any active eligible listing without a resolved product measure, or UCP/AP2 public claims are enabled without certification.

## Packet Shape

Use `schemaVersion: "marketplace-launch-evidence/v1"` and `environment: "production"`. Keep `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false` until the packet passes and the final launch review approves promotion.

Required `gates` keys:

- `marketplacePromotion`
- `marketplaceCheckoutFee`
- `stripeMoneyOperations`
- `supportOperations`
- `fulfillmentPostage`
- `transactionalEmail`
- `launchSupplyMeasurements`
- `taxReadiness`
- `ucpAp2Marketing`

Each approval gate carries `approved`, `reference`, `owner`, and `checkedAt`. References must point to real external launch records, not placeholders. `productionEnvironment` mirrors the GitHub Environment values that will be set for promotion.

```json
{
  "schemaVersion": "marketplace-launch-evidence/v1",
  "environment": "production",
  "productionEnvironment": {
    "PRODUCTION_MARKETPLACE_PUBLIC_ENABLED": "false",
    "PRODUCTION_MARKETPLACE_PROMOTION_APPROVED": "true",
    "PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE": "LAUNCH-REVIEW-2026-05-30",
    "PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED": "true",
    "PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE": "PAYMENTS-FEE-2026-05-30",
    "PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED": "true",
    "PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE": "STRIPE-MONEY-2026-05-30",
    "PRODUCTION_SUPPORT_OPERATIONS_APPROVED": "true",
    "PRODUCTION_SUPPORT_OPERATIONS_REFERENCE": "SUPPORT-OPS-2026-05-30",
    "PRODUCTION_FULFILLMENT_POSTAGE_APPROVED": "true",
    "PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE": "FULFILLMENT-POSTAGE-2026-05-30",
    "PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED": "true",
    "PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE": "NOTIFICATIONS-SES-2026-05-30",
    "PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED": "true",
    "PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE": "CATALOG-MEASURES-2026-05-30",
    "PRODUCTION_TAX_READINESS_APPROVED": "true",
    "PRODUCTION_TAX_READINESS_REFERENCE": "TAX-READINESS-2026-05-30",
    "TAX_PROVIDER_BACKED_QUOTES_REQUIRED": "false"
  },
  "gates": {
    "marketplacePromotion": {
      "approved": true,
      "reference": "LAUNCH-REVIEW-2026-05-30",
      "owner": "Platform",
      "checkedAt": "2026-05-30T11:00:00.000Z"
    },
    "marketplaceCheckoutFee": {
      "approved": true,
      "reference": "PAYMENTS-FEE-2026-05-30",
      "owner": "Payments",
      "checkedAt": "2026-05-30T11:00:00.000Z"
    },
    "stripeMoneyOperations": {
      "approved": true,
      "reference": "STRIPE-MONEY-2026-05-30",
      "owner": "Payments and Settlement",
      "checkedAt": "2026-05-30T11:00:00.000Z"
    },
    "supportOperations": {
      "approved": true,
      "reference": "SUPPORT-OPS-2026-05-30",
      "owner": "Support",
      "checkedAt": "2026-05-30T11:00:00.000Z"
    },
    "fulfillmentPostage": {
      "approved": true,
      "reference": "FULFILLMENT-POSTAGE-2026-05-30",
      "owner": "Fulfillment",
      "checkedAt": "2026-05-30T11:00:00.000Z"
    },
    "transactionalEmail": {
      "approved": true,
      "reference": "NOTIFICATIONS-SES-2026-05-30",
      "owner": "Notifications",
      "checkedAt": "2026-05-30T11:00:00.000Z"
    },
    "launchSupplyMeasurements": {
      "approved": true,
      "reference": "CATALOG-MEASURES-2026-05-30",
      "owner": "Catalog",
      "checkedAt": "2026-05-30T11:00:00.000Z",
      "activeLaunchListingCount": 42,
      "activeLaunchListingsMissingResolvedProductMeasures": 0,
      "resolvedProductMeasureCoveragePercent": 100,
      "queryReference": "launch-supply-measurement-query-2026-05-30"
    },
    "taxReadiness": {
      "approved": true,
      "reference": "TAX-READINESS-2026-05-30",
      "owner": "Tax",
      "checkedAt": "2026-05-30T11:00:00.000Z",
      "posture": "no_collection_required",
      "collectionRequiredJurisdictions": [],
      "taxProviderBackedQuotesRequired": false,
      "providerBackedResolverComposed": false
    },
    "ucpAp2Marketing": {
      "owner": "Checkout and Payments",
      "publicLaunchClaimsEnabled": false,
      "certificationApproved": false,
      "certificationReference": ""
    }
  }
}
```

## Launch Supply Measurement Sweep

Run this against the production marketplace read models after projections are caught up. Attach the redacted result, query version, timestamp, and operator identity to `PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE`.

```sql
SELECT
  COUNT(*)::integer AS active_launch_listing_count,
  COUNT(*) FILTER (WHERE listing.product_measure_snapshot IS NULL)::integer
    AS active_launch_listings_missing_resolved_product_measures,
  CASE
    WHEN COUNT(*) = 0 THEN 0
    ELSE ROUND(
      100.0
      * COUNT(*) FILTER (WHERE listing.product_measure_snapshot IS NOT NULL)
      / COUNT(*),
      2
    )
  END AS resolved_product_measure_coverage_percent
FROM marketplace_listing_pages AS listing
INNER JOIN marketplace_supply_items AS item
  ON item.item_id = listing.inventory_item_id
LEFT JOIN (
  SELECT item_id, SUM(quantity)::integer AS held_quantity
  FROM marketplace_supply_holds
  WHERE status = 'active'
  GROUP BY item_id
) AS active_holds
  ON active_holds.item_id = item.item_id
LEFT JOIN marketplace_seller_listing_availability_pages AS availability
  ON availability.account_id = listing.account_id
WHERE listing.status = 'active'
  AND COALESCE(availability.status, 'available') = 'available'
  AND LEAST(
    listing.quantity_cap,
    GREATEST(item.total_quantity - COALESCE(active_holds.held_quantity, 0), 0)
  ) > 0;
```

The packet passes only when the count is greater than zero, missing measurements are zero, and coverage is exactly `100`.

## Tax Posture

Use `posture: "no_collection_required"` only when Tax readiness evidence confirms state-by-state nexus tracking has no collection-required jurisdiction. In that posture, `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=false`.

Use `posture: "provider_backed_quotes_required"` when any jurisdiction is registered or collection-required. In that posture, list the jurisdictions, set `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true`, and prove a provider-backed `TaxQuoteResolver` is composed before order creation.

## Public Claims

Set `ucpAp2Marketing.publicLaunchClaimsEnabled=false` for the current public marketplace launch posture. Agent-commerce, autonomous-payment, AP2, or headless-checkout claims require a separate certification reference before they can appear in public launch marketing.
