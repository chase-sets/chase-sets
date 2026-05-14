# Progressive Disclosure

Progressive disclosure is the default design-system pattern for advanced, optional, risky, or low-frequency choices. Screens should lead with the facts and actions most users need, then reveal deeper controls only when they help a user complete a specific task.

Use `ProgressiveDisclosure` for one collapsible section and `ProgressiveDisclosureGroup` for several related sections. Prefer these components over raw `<details>`, local show/hide buttons, tooltip-only explanations, or app-owned disclosure styling.

## What Stays Visible

Do not hide required marketplace decision facts behind disclosure:

- item identity, condition, availability, and quantity
- price, fees, shipping, tax, discounts, wallet credit, and final total
- seller identity, seller trust, and buyer-protection cues
- fulfillment expectations and pickup or delivery commitments
- current status, blocking errors, and primary recovery actions
- the primary action for the current decision area

If hiding a fact would make the visible screen misleading, keep the fact visible and use disclosure only for supporting explanation.

## What Can Be Disclosed

Disclosure is appropriate for:

- advanced filters, bulk actions, and saved-search controls
- listing constraints such as per-order, per-day, or per-customer limits
- extra policy explanation after the plain-language policy summary is visible
- optional form sections and secondary setup fields
- audit trails, support-safe provider detail, and historical events
- admin configuration that is rarely changed after setup

## Component Defaults

- `ProgressiveDisclosure` renders a single Base UI accordion section with design-system motion, focus, spacing, and tone treatment.
- `ProgressiveDisclosureGroup` renders related sections in one frame and supports single-open or multi-open behavior.
- `summary` should describe the current disclosed state in plain language, for example `No seller limits set` or `Manual review`.
- `description` explains why the section exists; it should not replace required labels or error text.
- `tone` can call attention to informational, warning, accent, or neutral sections without becoming the primary action.
- `defaultOpen` is reserved for a known advanced state that already needs attention, such as a failed verification step.

## Accessibility

- Every trigger must have a specific title.
- Never place the only explanation of required information in a tooltip.
- Keep focus order aligned with the visual order.
- Keep disclosed content mounted only when the component does so accessibly through the design-system primitive.
- Respect `ChaseRoot` reduced-motion policy; do not import motion directly from bounded-context UI.

## Recommended First Flows

1. Marketplace listing creation and listing management: move seller limits, grading population detail, certification extras, and publishing recovery detail into disclosure while keeping price, availability, fulfillment, and primary publish actions visible.
2. Discovery item detail and search: keep buy/sell comparison facts visible; disclose advanced filters, specification depth, policy explanation, and market-history detail.
3. Checkout and payment: keep final cost and payment action visible; disclose provider-safe security explanation, editable low-frequency sections, support detail, and recovery diagnostics.
4. Settlement payout readiness and payout requests: keep payout availability, amount, destination status, and primary actions visible; disclose verification reason detail, ledger context, and provider-safe explanations.
5. Catalog and admin setup flows: disclose blueprint rules, product-resolution rules, external references, automation settings, and audit history after the current state and primary action are visible.

Pressure-test each migration against mobile scanning, stale read models, replayed events, failed/canceled actions, and low-value card economics. If a disclosed control affects price, margin, eligibility, or order commitment, show its current effect in the visible summary.
