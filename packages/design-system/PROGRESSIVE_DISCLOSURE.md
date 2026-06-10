# Progressive Disclosure

Progressive disclosure is the default design-system pattern for advanced, optional, risky, or low-frequency choices. Screens should lead with the facts and actions most users need, then reveal deeper controls only when they help a user complete a specific task.

Use `ProgressiveDisclosure` for one collapsible section and `ProgressiveDisclosureGroup` for several related sections. Prefer these components over raw `<details>`, local show/hide buttons, tooltip-only explanations, or app-owned disclosure styling.

## What Stays Visible

Do not hide required marketplace decision facts behind disclosure:

- item identity, condition, availability, and quantity
- price, fees, shipping, tax, discounts, wallet credit, and final total
- account identity, account trust, and order-protection cues
- fulfillment expectations and pickup or delivery commitments
- current status, blocking errors, and primary recovery actions
- the primary action for the current decision area

If hiding a fact would make the visible screen misleading, keep the fact visible and use disclosure only for supporting explanation.

## What Can Be Disclosed

Disclosure is appropriate for:

- optional filters that do not shape the primary result set, bulk actions, and saved-search controls
- listing constraints such as per-order, per-day, or per-customer limits
- extra policy explanation after the plain-language policy summary is visible
- optional form sections and secondary setup fields
- audit trails, support-safe provider detail, and historical events
- admin configuration that is rarely changed after setup

Disclosure is not appropriate for ranked search facets that directly shape the active result set; keep those facets visible with the primary filter controls.

## Reference Info Disclosure

Use `ReferenceInfoTrigger` and `ReferenceInfoDialog` when a visible label needs optional structured detail behind it. This is the canonical pattern for reference-data facts, source/status metadata, marketplace term explanations, payout calculation context, matching rules, registration timing, stale-state recovery, and non-blocking policy context.

Use [Reference Info Popup](./REFERENCE_INFO.md) for the complete admin and marketplace pattern contract, wrapper rule, and privacy guidance.

The pattern is intentionally more structured than a tooltip and less workflow-heavy than a standalone sheet or page:

- The parent UI keeps the required decision fact visible.
- The trigger is concise linked text or an equivalent inline control with a trailing `info` icon.
- The dialog title names the explained thing, not generic `More info`.
- Dialog content uses compact key/value facts, short plain-language body copy, and source/status metadata when useful.
- Use at most one visible reference-info trigger per workflow or action cluster; group related details inside the dialog.

Do not use reference-info disclosure for blocking errors, disabled-action recovery, validation feedback, destructive confirmations, or required commitment review. Use visible validation, inline recovery, `AlertDialog`, or a full review surface for those jobs.

## Component Defaults

- `ProgressiveDisclosure` renders a single Base UI accordion section with design-system motion, focus, spacing, and tone treatment.
- `ProgressiveDisclosureGroup` renders related sections in one frame and supports single-open or multi-open behavior.
- `ReferenceInfoTrigger` renders the linked-info affordance used by admin and marketplace reference detail.
- `ReferenceInfoDialog` renders structured reference detail with design-system dialog behavior and compact facts.
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

Adopt the pattern in code-backed slices first. Each slice stays in its owning bounded context; deployables only compose the routes.

1. Marketplace seller listing creation and listing management.
   - Owners: Marketplace routes for account listings and listing detail.
   - Keep visible: inventory identity, price, quantity cap, fee preview, listing status, and create/publish/pause/withdraw actions.
   - Disclose first: optional per-order/per-day/per-customer limits, fee-lock history, stale quote recovery detail, grading population detail, and certification extras when present.
   - Summary rule: if a disclosed limit changes buyer commitment or low-value card margin, show the active limit in the collapsed summary.
2. Discovery search and item detail.
   - Owners: Discovery search, mobile filter bottom sheet, facet rail, and item detail routes.
   - Keep visible: category and language filters, ranked dynamic facets, applied filter chips, result count, listing/offer comparison, buy/sell actions, and item identity.
   - Disclose first: optional specification depth, policy explanation, market-history detail, and saved-search recovery.
   - Summary rule: collapsed optional search controls must state whether none, some, or a named set of controls is active.
3. Checkout session and payment recovery.
   - Owners: Checkout for session review and fulfillment; Payments for payment fee quote, confirmation, provider events, and recovery.
   - Keep visible: ready/unavailable line counts, fulfillment estimate, final cost, wallet credit, selected shipping destination, payment method, secure payment cue, and the primary payment or recovery action.
   - Disclose first: address-book defaults, optional wallet custom amount detail, provider-safe security explanation, support details, raw provider event history, claim-token fallback, and recovery diagnostics.
   - Summary rule: payment disclosure summaries must never hide final total, processor state, blocking failure copy, or the next action.
4. Settlement payout readiness and payout requests.
   - Owners: Settlement payout readiness panel and payout request routes.
   - Keep visible: payout readiness status, available amount, payout amount policy, destination status, setup/preview/confirm actions, and blocking unavailable state.
   - Disclose first: grouped verification requirement details, provider capability detail, ledger context, unavailable reason detail, optional payout note, and provider-safe payout explanations.
   - Summary rule: if payouts are unavailable, the collapsed summary must name the highest-priority reason.
5. Catalog admin authoring and setup.
   - Owners: Catalog blueprint, catalog item, component, dimension, field, and category admin slices.
   - Keep visible: entity identity, status, lifecycle controls, current blueprint/category assignment, required field state, and publish action.
   - Disclose first: field rules, dimension rules, product-resolution rules, external product references, tag/image URL management, automation settings, and audit/history detail.
   - Summary rule: collapsed authoring depth must show whether identity-affecting or publish-blocking rules exist.

Pressure-test each migration against mobile scanning, stale read models, replayed events, failed/canceled actions, and low-value card economics. If a disclosed control affects price, margin, eligibility, or order commitment, show its current effect in the visible summary.

## First-Pass Implementation Notes

The first adoption pass validated that disclosure works best when the trigger owns the advanced-section label and nested controls avoid repeating the same heading. This matters most in mobile bottom sheets where both the collapsed trigger and expanded content remain mounted for accessibility.

When a disclosed section is expanded by default because it blocks progress, keep the warning summary specific enough to explain the block without requiring expansion.

Disclosure summaries are visible UI copy. Keep them localized and data-backed, even when the expanded content already uses localized field labels.
