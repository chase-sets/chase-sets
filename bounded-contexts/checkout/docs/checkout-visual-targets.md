# Checkout Visual Targets

Milestone #17 uses image-first visual targets for the Shopify-simple Buy Cart and Sell List checkout rebuild. These images are design references, not production UI or an executable checklist. Implementation should preserve the simple hierarchy and use product tests around the actual slice being shipped.

## Source References

The supplied Shopify/PokeBash screenshots remain the hierarchy reference set:

- `screencapture-pokebash-co-cart-2026-06-08-20_55_09.png`
- `screencapture-pokebash-co-checkouts-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-2026-06-08-20_51_29.png`
- `screencapture-pokebash-co-checkouts-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-2026-06-08-20_53_52.png`
- `screencapture-pokebash-co-checkouts-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-2026-06-08-20_54_20.png`
- `screencapture-shop-app-checkout-68792320022-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-shoppay-2026-06-08-20_50_58.png`
- `screencapture-shop-app-checkout-68792320022-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-shoppay-2026-06-08-20_52_52.png`
- `screencapture-shop-app-checkout-68792320022-cn-hWND7gfApDDIyRwIKmWZGplZ-en-us-shoppay-2026-06-08-20_53_19.png`

The Chase Sets targets adapt that hierarchy into the dark marketplace design-system theme: navy surfaces, restrained borders, marketplace-blue primary actions, teal trust cues, amber attention states, and red only for blocking states.

## Generated Image Targets

![Buy checkout visual targets](./visual-targets/checkout-visual-targets-buy-flow.png)

Repo path: `bounded-contexts/checkout/docs/visual-targets/checkout-visual-targets-buy-flow.png`

![Sell checkout visual targets](./visual-targets/checkout-visual-targets-sell-flow.png)

Repo path: `bounded-contexts/checkout/docs/visual-targets/checkout-visual-targets-sell-flow.png`

![Recovery visual targets](./visual-targets/checkout-visual-targets-recovery-states.png)

Repo path: `bounded-contexts/checkout/docs/visual-targets/checkout-visual-targets-recovery-states.png`

![Capability visual targets](./visual-targets/checkout-visual-targets-capability-states.png)

Repo path: `bounded-contexts/checkout/docs/visual-targets/checkout-visual-targets-capability-states.png`

## Design Rules

- Cart/list review is separate from checkout.
- Unassigned fulfillment stays in Buy Cart or Sell List readiness. Checkout can summarize a ready plan, but it must not ask customers to solve fulfillment assignment.
- Optional savings optimization, including `Save $X`, stays in cart/list readiness or a conditional pre-checkout step.
- Desktop checkout uses a focused two-column form plus summary.
- Mobile checkout uses a single column, collapsible summary, and sticky primary action/total behavior.
- Signed-in checkout compresses saved information into editable rows.
- Recovery states use customer-safe language and show no-side-effect facts when no payment, order, label, payout, settlement, notification, account-history, support, reconciliation, refund, void, or reversal work started.
- Confirmation and account/history visuals distinguish pending Checkout activity from committed downstream facts.
- Visual targets forbid dense checkout panels, allocation controls, provider diagnostics, old-route recovery, old payload wording, hidden repair, nested card stacks, migration/backfill wording, and fake downstream completion.

## Review Use

Use these images as the first visual target set for #1112. Future implementation PRs should preserve the intent even when exact content changes:

- simple hierarchy over marketplace detail;
- visible totals, payment/payout status, support-safe references, and primary action;
- readiness before checkout;
- no side effects before valid confirmation;
- pending Checkout activity separated from committed downstream facts;
- no old checkout fallback surfaces.

Attach focused screenshots to UI implementation PRs when a customer-visible checkout surface changes. Keep deltas local to the slice being shipped rather than creating a separate tracking matrix.
