# Marketplace Sales Fee Confirmation

Marketplace listing fees are account-confirmed Commercial Terms formula snapshots bound to Listing identity at creation. Price changes requote the locked formula; they never resolve a later schedule. Partial sales, pause, resume, and sold-out availability changes do not recalculate terms.

## Fee Ownership

Commercial Terms owns marketplace sales fee policy only. Marketplace checkout fees charged to the purchasing side are owned by Payments and documented in [Marketplace Checkout Fee Policy](../../payments/docs/marketplace-checkout-fee-policy.md).

Marketplace owns seller confirmation. Ordering consumes Marketplace snapshots and does not call Commercial Terms for normal listing purchases.

## Listing Flow

1. Draft creation resolves Commercial Terms and locks that formula for every unit in the initial quantity.
2. Publish is a lifecycle transition only; it preserves the creation-time lock.
3. Price edits requote each Fee-Lock Tranche locally from its locked percentage, fixed amount, and cap.
4. Quantity increases are restocks. The seller confirms a current quote, and only the added units receive a new Fee-Lock Tranche.
5. Quantity reductions retire the newest tranche units first. A later increase is a new restock at current terms.
6. Purchase-limit edits, Listing Evidence additions, pause, automated unlisting, resume, partial sales, and availability changes preserve the lock.
7. Withdrawal is terminal. Relist, delete-and-recreate, inventory-item substitution, Product substitution, and condition-selection substitution require a new Listing identity and current terms.

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

Publish the already fee-locked draft:

```http
POST /api/marketplace/account/listings/lst_123/publish
Content-Type: application/json

{}
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
