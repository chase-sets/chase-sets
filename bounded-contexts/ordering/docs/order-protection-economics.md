# Order Protection Economics

Every order contributes 1% of item subtotal to Order Protection, rounded up to the nearest cent. The seller-funded fulfillment allowance is calculated from the locked Commercial Terms basis points and funds Order Protection first, then shipping. The buyer sees only the combined overflow as one `Shipping` line.

For a $4.50 shipping base, the ratified 5% allowance, and the standard 5% Marketplace Sales Fee capped at $25 per item:

| Item subtotal | Order Protection | Shipping allowance | Protection split (allowance / overage) | Buyer `Shipping` | Seller payout before label purchase |
| ---: | ---: | ---: | ---: | ---: | ---: |
| $10.00 | $0.10 | $0.40 | $0.10 / $0.00 | $4.10 | $13.50 |
| $50.00 | $0.50 | $2.00 | $0.50 / $0.00 | $2.50 | $49.50 |
| $125.00 | $1.25 | $4.50 | $1.25 / $0.00 | $0.00 | $117.50 |
| $500.00 | $5.00 | $4.50 | $5.00 / $0.00 | $0.00 | $470.00 |

Seller payout is `seller item net - allowance-funded protection + buyer-funded shipping overage`. Settlement retains both protection funding shares independently of Marketplace Sales Fees, so a 0% fee agreement never reduces the reserve contribution.

Refund reversals use the original immutable funding split. Cumulative proportional rounding determines each partial reversal; a full-order refund always converges byte-exactly to the original contribution.
