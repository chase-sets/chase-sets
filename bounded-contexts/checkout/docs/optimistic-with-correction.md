# Optimistic With Correction

Checkout uses the product-wide `optimistic-with-correction` strategy from [Post-Write Consistency Policy](../../../docs/architecture/post-write-consistency.md) for reversible account controls that need immediate feedback.

## Buy Cart Quantity

- Increase and Decrease apply the submitted quantity immediately in the visible row, subtotal, and cart count.
- The route submits an absolute target quantity with `optimisticStrategy=optimistic-with-correction` and `correctionSource=fresh-read:loader-revalidation`.
- Rapid repeated clicks are serialized per line group and coalesced to the latest target quantity.
- Fresh loader data reconciles the displayed quantity and clears the optimistic override.
- Rejected writes roll back to loader truth while the route-owned error banner explains the failure.
- Typed draft quantity edits stay local to the input until the buyer submits Update.

Do not use this strategy for Checkout writes that start sessions, payment, orders, fulfillment, inventory commitments, fee quotes, or any other side effect where optimism could hide a blocking domain failure.
