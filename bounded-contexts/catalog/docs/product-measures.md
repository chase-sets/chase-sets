# Product Measures

Catalog owns the physical facts needed to ship a Product: unit length, width, height or thickness, unit weight, physical flags, stack behavior, source, and confidence.

## Product Measure Profiles

A `Product Measure Profile` is a reusable measurement rule for Products that are physically uniform. Examples include standard Pokemon raw singles, PSA Pokemon slabs, booster packs, booster boxes, elite trainer boxes, and booster bundles.

Profiles match Catalog Items and resolved Products by:

- Blueprint.
- Category.
- Selected Product Options.

The profile produces a `Resolved Product Measure` for each matching Product. Downstream contexts consume the resolved snapshot rather than reading Catalog profile tables.

## Publishing Resolved Product Measures

Catalog publishes one Product Measure Publication per Catalog Item: the Resolved Product Measure of every Product a profile matches. The `catalog-product-measure-resolution` reaction publishes it when a Catalog Item is published and when a Category is assigned to or removed from it. Nothing else triggers it: a Blueprint cannot change once it is active, and a profile change does not republish existing Catalog Items.

- Only an active Catalog Item with a Blueprint is resolved. An event for a draft, archived or removed item is handled without a publication.
- An active item that no profile matches gets one publication with no Products. A Category change that leaves no match replaces the previous set with an empty one.
- Equal measures are not published again: a publication is appended only when the resolved set differs from the latest complete one.
- The reaction retries an event until the Catalog Item projection has applied it, the item's Blueprint is projected and no longer draft, and at least one profile exists. While it waits, the event shows as a `transient` failure and as lag on the `catalog-product-measure-resolution` checkpoint, and later events wait behind it.
- Its first run starts from the first Catalog event, so it also publishes for the Catalog Items that were published before the reaction existed.

## Missing Measures

If no profile applies, Catalog records an explicit missing measurement state for that Product. Checkout and Ordering must treat missing measures as a blocker instead of falling back to arbitrary package defaults.

## Launch Supply Readiness

Before public marketplace promotion, Catalog must produce a launch-supply measurement sweep proving every active checkout-eligible launch listing has a resolved product measure snapshot. The sweep is referenced by `PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE` and approved with `PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED=true` only when:

- active launch listings are present;
- at least one active seller account is represented, and the evidence includes a redacted sample of concrete active launch listing IDs;
- active checkout-eligible listings missing resolved product measures equals `0`;
- resolved product measure coverage equals `100`;
- the canonical launch-supply measurement command output, production environment, query version, timestamp, operator, and projection freshness record are attached to the external evidence record.

Run `pnpm run ops marketplace:launch-supply-measurement --environment production` against production read models to produce the redacted measurement fields for the Catalog-owned approval record. The command fails closed unless the production sweep has non-empty launch supply, non-empty seller coverage, sampled concrete listing IDs, zero missing resolved measures, 100% coverage, a valid timestamp, an operator, a production query evidence reference, and a projection-freshness evidence reference. Catalog owns the measurement facts and proof; Ordering keeps the runtime checkout blocker when a stale or newly created listing still lacks a measurement snapshot.

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

Bootstrap seeds the reusable profiles before the seed publishes any Catalog Item, so a rerun after an interrupted seed never finds published items without a profile. Under the production data profiles it publishes no measures and does not run the reaction; the worker's reaction publishes them after deployment, existing Catalog Items included. A `scenario-seed` bootstrap also resolves every existing scenario Catalog Item, and the reaction's catch-up in that bootstrap publishes nothing further for them.
