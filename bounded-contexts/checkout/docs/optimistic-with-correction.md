# Optimistic With Correction

Checkout uses the product-wide `optimistic-with-correction` strategy from [Post-Write Consistency Policy](../../../docs/architecture/post-write-consistency.md) for reversible account controls that need immediate feedback.

## Buy Cart Mutations

- Quantity Increase and Decrease apply the submitted quantity immediately in the visible row, subtotal, and cart count.
- Remove hides the row immediately and recomputes visible totals and count without waiting for the account cart loader.
- Lock preferred listing immediately projects the line as a locked listing so seller context, readiness, and totals use the selected listing while the write is pending.
- All cart-page account mutations submit through the cart-level optimistic mutation controller with `optimisticStrategy=optimistic-with-correction` and `correctionSource=fresh-read:loader-revalidation`.
- Quantity writes submit absolute target quantities; rapid repeated clicks are serialized per line group and coalesced to the latest target quantity.
- Fresh loader data reconciles visible cart state and clears the optimistic override. Stale loader data does not re-show removed rows or replace newer optimistic quantities.
- Rejected writes roll back to loader truth while the cart route error banner explains the failure.

Do not use this strategy for Checkout writes that start sessions, payment, orders, fulfillment, inventory commitments, fee quotes, or any other side effect where optimism could hide a blocking domain failure.
