# Product Measures

Catalog owns the physical facts needed to ship a Product: unit length, width, height or thickness, unit weight, physical flags, stack behavior, source, and confidence.

## Product Measure Profiles

A `Product Measure Profile` is a reusable measurement rule for Products that are physically uniform. Examples include standard Pokemon raw singles, PSA Pokemon slabs, booster packs, booster boxes, elite trainer boxes, and booster bundles.

Profiles match Catalog Items and resolved Products by:

- Blueprint.
- Category.
- Selected Product Options.

The profile produces a `Resolved Product Measure` for each matching Product. Downstream contexts consume the resolved snapshot rather than reading Catalog profile tables.

## Missing Measures

If no profile applies, Catalog records an explicit missing measurement state for that Product. Checkout and Ordering must treat missing measures as a blocker instead of falling back to arbitrary package defaults.

## Context Boundary

Catalog does not decide whether a package can ship as a letter, what shipping costs, or which carrier service should be used. Ordering owns quote policy and letter eligibility. Fulfillment owns shipment execution and label purchase.

## Initial Seed Profiles

The seeded profiles cover common Pokemon products:

- Standard raw single.
- PSA slab.
- Booster pack.
- Booster box.
- Elite trainer box.

Irregular products such as metal cards, jumbo cards, and collection boxes should receive a more specific profile or override before checkout is allowed.
