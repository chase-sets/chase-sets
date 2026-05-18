# Marketplace Sales Fee Confirmation

Marketplace listing fees are account-confirmed, per-unit sales fee snapshots. A listing keeps the fee snapshot that was confirmed when it was first published. Partial sales, pause, resume, and sold-out availability changes do not recalculate fees.

## Fee Ownership

Commercial Terms owns marketplace sales fee policy only. Marketplace checkout fees charged to the purchasing side are owned by Payments and documented in [Marketplace Checkout Fee Policy](../../payments/docs/marketplace-checkout-fee-policy.md).

Marketplace owns seller confirmation. Ordering consumes Marketplace snapshots and does not call Commercial Terms for normal listing purchases.

## Listing Flow

1. Draft creation stores the latest non-binding marketplace sales fee quote.
2. Publish requires the listing account to submit the current `feeQuoteFingerprint`.
3. If the fingerprint is missing or stale, Marketplace returns `409 fee_quote_stale` with `currentQuote`.
4. First publish locks the quote as the listing's per-unit marketplace sales fee snapshot.
5. Active price edits and quantity-cap edits require the same confirmed quote flow and replace the locked snapshot.
6. Partial sales and availability changes do not refresh the snapshot.

## Offer Flow

Accepted offers use current Commercial Terms at offer acceptance time, but Marketplace still owns sales fee confirmation. The accepted-offer event carries the confirmed per-unit marketplace sales fee and seller net for Ordering.

## API Examples

Preview listing terms:

```http
POST /api/marketplace/account/listings/preview
Content-Type: application/json

{
  "priceAmount": "10.00"
}
```

Publish with the confirmed quote:

```http
POST /api/marketplace/account/listings/lst_123/publish
Content-Type: application/json

{
  "feeQuoteFingerprint": "10.00|0.50|9.50|sch_standard|"
}
```

Stale quote response:

```json
{
  "error": {
    "code": "fee_quote_stale",
    "message": "Fee quote is stale. Refresh the fee preview before continuing.",
    "currentQuote": {
      "basis_amount": "10.00",
      "marketplace_sales_fee_unit_amount": "0.50",
      "seller_net_unit_amount": "9.50",
      "schedule_id": "sch_standard",
      "agreement_id": null,
      "resolved_at": "2026-05-03T18:00:00.000Z",
      "fee_quote_fingerprint": "10.00|0.50|9.50|sch_standard|"
    }
  }
}
```

Preview accepted-offer terms:

```http
GET /api/marketplace/account/offers/matches/off_123/terms-preview
```

Accept with the confirmed offer quote:

```http
POST /api/marketplace/account/offers/matches/off_123/accept
Content-Type: application/json

{
  "feeQuoteFingerprint": "44.00|2.20|41.80|sch_standard|"
}
```

Review listing fee history:

```http
GET /api/marketplace/account/listings/lst_123/fee-history
```

Each history entry includes the event type, stream version, price, quantity cap when applicable, per-unit marketplace sales fee, per-unit seller net, schedule/agreement source, terms timestamp, quote fingerprint, recorded time, and actor id.
