# Product Shipping Measures

## Intent

Products need reliable weight, dimensions, and mailpiece eligibility without requiring manual measurements on every product. The implementation should:

- Derive measurements from reusable Catalog-owned product measure profiles wherever product families are uniform.
- Require explicit item-level measurement only for real exceptions such as jumbo cards, metal cards, and irregular collection boxes.
- Let checkout and order creation quote shipping from the same deterministic packaging rules Fulfillment later executes.
- Preserve one fulfillment model for all accounts; seller/account-specific packaging differences are out of scope.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-product-shipping-measures`
- Branch: `codex/product-shipping-measures`
- Sandbox id: `34abebbf`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: passed; marketplace app at `http://localhost:8153`, platform API at `http://localhost:8162`
- Setup blockers: none

## Owning Contexts

- Catalog owns reusable product measurement facts because Catalog owns what a Product is, Product resolution, Blueprint structure, Fields, Reference Records, and product schema snapshots.
- Ordering owns the buyer-facing shipping charge committed on the order. Existing glossary already names `Shipping Quote Policy` as Ordering-owned.
- Fulfillment owns shipment execution, package preparation, shipping method execution, label purchase, and delivery state.
- Inventory continues to own ship-from location through storage location mapping. It must not own product measurement.
- Marketplace continues to own listing and offer workflows. It must not collect listing-level weights or dimensions for normal products.

## Repo Evidence

- `bounded-contexts/README.md` fixes Catalog as the canonical product model owner, Checkout as cart/session owner, Ordering as order owner, and Fulfillment as shipment owner.
- `bounded-contexts/catalog/README.md` says Catalog owns canonical item, dimensions, options, product resolution, and product schema snapshots.
- `bounded-contexts/catalog/docs/graded-card-data-model.md` already models raw versus graded cards through Catalog product options, while copy-specific slab certification details stay in Inventory and are projected to Marketplace only when needed.
- `bounded-contexts/ordering/GLOSSARY.md` already defines `Shipping Quote Policy` as the Ordering-owned rule for provisional shipping charges while checkout compares seller split plans.
- `bounded-contexts/ordering/features/orders/domain/policies.ts` currently quotes shipping only from shipping option, item subtotal, quantity, and listing count. That cannot handle letter eligibility, volume, slabs, booster boxes, or exceptions accurately.
- `bounded-contexts/fulfillment/features/shipments/api/route.ts` currently defaults USPS label package inputs to `7 x 5 x 1 in` and `4 oz` unless the seller submits package fields, which creates the manual-entry problem.
- `contracts/postage-labels/index.ts` already expects package length, width, height, and weight for label purchase.
- `docs/runbooks/postage-operations.md` confirms EasyPost creates shipments from sender/recipient plus package dimensions and weight.

## Resolved Decisions

### 1. Canonical Term: Product Measure Profile

Use `Product Measure Profile` for reusable physical facts that describe how one sellable Product unit measures before outbound packaging.

The profile contains:

- Unit dimensions: length, width, height/thickness in inches.
- Unit weight in ounces.
- Physical flags: rigid, bendable, metal, jumbo, sealed, raw-card, slab, irregular.
- Stack behavior: whether units stack, how thickness/weight accumulate, and any max safe units per mailpiece.
- Measurement source and confidence: profile default, provider supplied, operator measured, conservative estimate.
- Applicability rules: Blueprint, Category, Reference Record, Field values, and selected Product Options.

The term intentionally avoids `Shipping Profile` for the Catalog-owned fact. Shipping decisions are policy decisions; the profile is only product truth.

### 2. Catalog Adds Profile Inheritance Instead Of Per-Product Entry

Catalog gets a new `product-measures` slice with two authoring surfaces:

- `Product Measure Profile`: reusable profiles such as Pokemon standard raw single, PSA Pokemon slab, CGC Pokemon slab, Pokemon booster pack, Pokemon booster bundle, booster box, elite trainer box.
- `Product Measure Override`: an item/product-specific override for exceptions like metal cards, jumbo cards, unusual premium boxes, or collection boxes whose size varies by product.

Resolution priority:

1. Product-specific override for the resolved `product_id`.
2. Catalog Item override that applies to all products under that item.
3. Most-specific Product Measure Profile rule matching selected options and item facts.
4. Blueprint default profile.
5. Missing measurement state.

Missing measurement must be explicit. There should be no silent fallback to arbitrary package defaults.

### 3. Product Kind Should Be Structured Catalog Data

Sealed product measurement cannot safely rely only on title text. Add structured Catalog facts that can be populated by bootstrap, provider promotion, or admin review:

- Keep existing categories for browsing.
- Add a Catalog-owned field or reference value for `Product Kind` under sealed products, with natural values such as booster pack, booster bundle, elite trainer box, booster box, collection box, tin, binder collection, playmat collection.
- Keep `pack-count` as descriptive detail, not as the sole measurement classifier.

This lets booster packs, elite trainer boxes, booster bundles, and booster boxes inherit dimensions automatically, while collection boxes can be measured only when they actually vary.

### 4. Catalog Publishes Resolved Product Measure Facts

Catalog publishes stable facts rather than downstream contexts reading Catalog internals:

- `catalog.product-measure-profile.published`
- `catalog.product-measure-profile.revised`
- `catalog.product-measure-profile.retired`
- `catalog.catalog-item.product-measures-resolved`

The resolved event should carry per-product snapshots:

```ts
type ProductMeasureSnapshot = {
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  measureVersion: string;
  unitLengthInches: number;
  unitWidthInches: number;
  unitHeightInches: number;
  unitWeightOunces: number;
  physicalFlags: readonly string[];
  stackBehavior: "stackable-thickness" | "stackable-height" | "non-stackable";
  source: "profile" | "catalog-item-override" | "product-override";
  confidence: "measured" | "provider" | "conservative-estimate";
};
```

Downstream projections store the snapshot by `product_id` and never import Catalog aggregates directly.

### 5. Ordering Quotes From A Deterministic Package Plan

Replace the current quantity/listing-count-only quote policy with an Ordering-owned `Shipping Quote Policy` that uses:

- Seller origin from Inventory/Marketplace supply inputs.
- Destination address from Checkout.
- Product measure snapshots from Catalog.
- Item subtotal/value.
- Requested shipping option.
- A shared deterministic package planner library in contracts or infrastructure, with policy data injected by Ordering.

The package planner returns a quote-time package plan:

- Package count.
- Mailpiece class candidates and selected class.
- Package dimensions and billable weight.
- Letter eligibility result and reasons.
- Measurement profile versions used.

Ordering stores the committed `shipping_plan_snapshot` on `ordering.order.created` alongside existing shipping economics. This keeps the buyer charge auditable even if profiles or carrier policies change later.

### 6. Letter Eligibility Is Policy, Not Product Truth

Raw card products should inherit physical measures from Catalog. Letter eligibility should be decided by Ordering quote policy from configurable rules:

- Product facts: raw standard card, not rigid, not metal, not jumbo.
- Aggregate physical limits: total weight, total thickness, dimensions.
- Business limits: max units per letter and max declared/order value for untracked letter risk.
- Shipping option compatibility: standard can choose letter when eligible; expedited/priority should require trackable parcel unless policy explicitly says otherwise.

The value threshold must be configurable seed/policy data, not hard-coded into Catalog.

### 7. Fulfillment Executes The Committed Package Plan

Fulfillment consumes `shipping_plan_snapshot` from `ordering.order.created` through its existing Ordering source projection and stores it on the shipment.

Changes in Fulfillment:

- `CreateShipment` carries planned packages, mailpiece class, package dimensions, weight, and measurement versions.
- `PrepareShipmentPackage` confirms the planned packages instead of only `packageCount`.
- USPS label purchase defaults to the planned package. Manual package input becomes an audited operator override, not the normal path.
- Letter shipments use a Fulfillment-owned letter preparation path instead of forcing package label purchase. If tracking is unavailable, Fulfillment records that honestly as a mailpiece method without a tracking identifier.

### 8. Marketplace And Inventory Stay Thin

Marketplace should not add listing-level weight/dimension fields. It may project product measurement status only to warn sellers when a product cannot be checked out because Catalog has no resolved measurement.

Inventory should continue to publish ship-from information through storage location and listing supply. It should not collect product dimensions.

### 9. Admin Workflow

Catalog admin should include:

- Product Measure Profiles list/detail.
- Rule preview showing which Catalog Items and Products a profile covers.
- Missing measurement report grouped by Blueprint, Product Kind, and Category.
- Bulk assignment of a profile to selected items or product kinds.
- Explicit override form for irregular products.

This keeps the work scalable: most products inherit, exceptions are visible, and operators only measure products that actually vary.

## Case Coverage

- Raw singles: Standard TCG raw-card profiles by product line and form apply automatically. Letter eligibility is computed at quote time from count, value, weight, thickness, and exception flags.
- Metal cards: Product or item override sets metal/rigid flags and heavier weight; letter eligibility fails with a reason.
- Jumbo cards: Product or item override sets larger dimensions; letter eligibility fails and package plan selects parcel packaging.
- Graded cards: Product profile matches Form = Graded plus Grading Company and product line. Slab measures are inherited by company; jumbo/metal exceptions override.
- Booster packs, booster bundles, elite trainer boxes, booster boxes: Product Kind and product line match reusable sealed-product profiles. No per-product entry is needed for ordinary products.
- Other collection boxes: Product Kind can default to missing measurement or a conservative collection-box profile. Specific dimensions are entered only for each irregular Catalog Item.
- Mixed carts: Ordering groups by seller/origin as today, then optimizes package plans per seller shipment using all line measurements.

## Implementation Checklist

1. Completed: add Catalog glossary/docs for `Product Measure Profile` and `Resolved Product Measure`.
2. Completed: add Catalog `product-measures` slice, context manifest entries, read models, resolved events, and seed profiles.
3. Partially completed: seed default profiles for Pokemon raw singles, PSA slabs, booster packs, booster boxes, and elite trainer boxes. A richer structured sealed `Product Kind` admin/reference workflow remains a follow-up.
4. Completed: publish resolved product measure events from Catalog and project them into Marketplace and Ordering supply tables; Fulfillment receives immutable package plans from Ordering.
5. Completed: replace Ordering shipping quote policy inputs with measured package planning and persist `shipping_plan_snapshot` on orders.
6. Not implemented in this slice: dedicated Checkout preview package/mailpiece response fields.
7. Partially completed: extend Fulfillment order source projection, shipment domain, read model, and USPS label purchase defaults from the committed package plan. A first-class letter preparation workflow remains a follow-up.
8. Completed: update Marketplace seller listing surfaces to show missing measurement warnings without owning measurement.
9. Completed: add focused tests for profile resolution, letter eligibility, missing measurement blocking through ordering fixtures, order/package snapshot flow, and fulfillment label defaults. More fixture coverage for irregular collection boxes can be added once override authoring is introduced.
10. Completed: promote durable docs to Catalog, Ordering, Fulfillment, runbook, and system glossary.

## Implemented Verification

- `pnpm --filter @chase-sets/product-measures run test`
- `pnpm --filter @chase-sets/catalog run test`
- `pnpm --filter @chase-sets/marketplace run test`
- `pnpm --filter @chase-sets/ordering run test`
- `pnpm --filter @chase-sets/fulfillment run test:fast`
- `pnpm run verify:typecheck`
- `pnpm run verify:static`
- `pnpm run verify:test`
- `pnpm run verify:test-db`
- `pnpm run verify:build`

## Documentation To Promote

- `bounded-contexts/catalog/GLOSSARY.md`: Product Measure Profile, Product Measure Override, Resolved Product Measure.
- `bounded-contexts/catalog/docs/product-measures.md`: authoring model, inheritance rules, resolution priority, examples.
- `bounded-contexts/ordering/GLOSSARY.md`: update Shipping Quote Policy to include measured package planning and immutable quote snapshots.
- `bounded-contexts/fulfillment/GLOSSARY.md`: Package Plan and Letter Mailpiece.
- `docs/architecture/bounded-context-structure.md`: no structure change expected unless a shared deterministic package-planner contract is added.
- `docs/runbooks/postage-operations.md`: package plan defaults, override audit, letter preparation, and label smoke checks.
- `docs/GLOSSARY.md`: cross-context index entries for Product Measure Profile, Package Plan, and Letter Mailpiece.

## Stress Test

- Normal flow: Catalog resolves measure snapshots; Ordering quotes and commits package plan; Fulfillment prepares and purchases label from the committed plan.
- Partial flow: If Catalog lacks a measure, Checkout preview marks the line unavailable for checkout and seller/admin surfaces show missing measurement.
- Stale data or replay: Ordering stores `measureVersion` and package plan snapshots on the order. Replays reproduce the committed economics even after profile revisions.
- Cross-context handoff: Catalog publishes resolved physical facts; Ordering owns quote economics; Fulfillment owns execution. No downstream context imports Catalog internals.
- Failure/cancellation: If package preparation has not started, cancellation behavior remains unchanged. If label purchase fails, Fulfillment records provider failure against the planned package.
- Low-value card economics: Standard raw singles can use letter mail only under configured count, weight/thickness, and value caps; high-value or thick/mixed orders move to trackable parcel automatically.

## Open Questions

None blocking for architecture. Exact numeric thresholds for letter value cap, max raw-card count per letter, envelope weight, and envelope thickness should be configured as policy seed data during implementation and can be tuned without changing Catalog product truth.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
