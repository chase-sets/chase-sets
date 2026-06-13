# Checkout Copy Policy

Milestone #17 rebuilds Buy Cart and Sell List checkout as a Shopify-simple fresh-state flow. Copy must help customers finish the current decision without exposing marketplace implementation details, provider diagnostics, or old checkout concepts.

The executable contract lives in `bounded-contexts/checkout/features/sessions/api/checkout-copy-policy.ts`. Tests assert that every required surface has an owner, audience, capability state, disclosure posture, policy dependency, support-reference rule, no-side-effect requirement where needed, and acceptance note.

## Core Rules

- Cart/list review is separate from checkout.
- Items that are not ready stay in Buy Cart or Sell List readiness.
- Optional savings copy, including `Save $X`, appears before checkout and never asks customers to solve allocation or provider mechanics.
- Checkout may summarize accepted or declined readiness decisions, then route stale or changed facts back to cart/list readiness.
- Smart Match remains approved customer-facing language for Checkout-owned matching over product-level Buy Cart and Sell List lines.
- Main-path copy stays short enough for desktop two-column checkout, mobile single-column checkout, saved-info rows, collapsible summary, and sticky primary action.
- Required facts stay visible: item identity, quantity, price or payout preview, final total, delivery or ship-from status, payment or payout method, blocking errors, and the primary action.
- Progressive disclosure, reference info, policy links, and support runbooks carry detail only after the required decision fact is visible.
- Pending Checkout activity must not imply committed order, sale, label, payout, settlement, notification, fulfillment, or account-history facts before the owning context commits them.
- No payment, order, label, payout, settlement, notification, account-history, or support side effect starts when readiness, active-session, disabled-capability, provider-return, risk, or kill-switch copy rejects the flow before confirmation.

## Forbidden Customer Terms

Customer-facing copy must not use or imply these internal terms:

- allocation
- selected seller listing
- provider payload
- projection or projection repair
- stale read model
- session revalidation
- compatibility adapter
- migration or backfill
- manual database edit
- legacy checkout or old checkout
- dense checkout fallback
- hidden repair
- provider dashboard or provider diagnostics
- raw id
- full URL

Operator-owned records may reference technical concepts, but customer-facing recovery text must stay plain-language.

## Capability States

The copy inventory shares capability-state names with visual targets, observability, support, and performance budgets:

- `enabled`
- `disabled`
- `deferred`
- `retained-internal`
- `kill-switched`
- `stale`
- `pending`
- `committed`
- `failed`
- `recovered`
- `held`
- `reversed`
- `no-side-effect`

Disabled, deferred, retained-internal, kill-switched, held, reversed, and support-only states must include owned policy or runbook handling before launch.

## Surface Inventory

| Surface | Primary copy rule | Acceptance note |
| --- | --- | --- |
| Cart/list review | Keep Buy Cart and Sell List language concise and role-specific. | Review copy does not introduce checkout machinery before readiness. |
| Readiness item attention | Explain that some items need attention before checkout. | Unready buyer items resolve before checkout and record no payment started. |
| Readiness savings offer | Offer customer-level savings before checkout. | Accepted and declined savings decisions are recorded outside checkout. |
| Readiness blocked or unavailable | Route customers back to review with a clear next action. | Blocked readiness records no payment, label, or payout started. |
| Checkout review | Show contact, delivery, shipping, payment, and final total. | Shopify-simple checkout form keeps required facts visible. |
| Saved-info rows | Use concise masked rows with edit actions. | Signed-in rows remain editable and fail closed when saved facts become stale. |
| Checkout temporary recovery | Say checkout is still getting ready. | Temporary recovery is visible before platform failure and records no payment started. |
| Checkout permanent recovery | Say the checkout can no longer continue. | Permanent recovery routes to review without old checkout wording. |
| Active-session stale recovery | Say the cart or list changed after checkout started. | Active sessions that become stale route back with no downstream side effects. |
| Accelerated and saved-instrument fallback | Fall back to available payment or payout methods. | Convenience paths cannot bypass readiness, privacy, or side-effect rules. |
| Address correction | Ask for a deliverable or serviceable address. | Address recovery stays provider-safe and inline. |
| Discount, credit, fee, and promotion state | Show changed or deferred economics before confirmation. | Totals and payout changes are reviewed before commitment. |
| Provider or wallet return recovery | Ask customers to review checkout before trying again. | Provider returns fail closed through new-flow recovery. |
| Risk hold or block | Give a support-safe next step without sensitive signals. | Risk copy has privacy and support signoff. |
| Split package summary | Show package count and differing delivery windows. | Split summaries avoid seller-allocation mechanics. |
| Confirmation and next steps | Distinguish receipt, pending activity, and committed detail. | Confirmation does not imply downstream completion early. |
| Seller pending activity | Say seller activity was recorded and downstream details are pending. | Seller copy never says sale complete, label ready, payout ready, settlement complete, notification sent, or fulfillment complete early. |
| Account history handoff | Route to activity or committed detail based on owning facts. | Pending Checkout activity and committed downstream records use separate labels. |
| Support reference | Give a stable support-safe reference. | Support text avoids raw ids, emails, addresses, cookies, provider payloads, full URLs, card or bank details, and sensitive risk signals. |
| Notification expectation | Say updates will be sent when ready. | Notification copy does not promise a sent message before Notifications commits it. |
| Cancellation, refund, and reversal | Show current recovery status and next step. | Recovery copy distinguishes pending, recovered, failed, held, reversed, and deferred states. |
| Checkout unavailable | Say checkout is unavailable and return to review. | Kill switches do not restore old checkout paths or copy. |
| Policy footer | Use short policy link labels. | Footer links point to Chase Sets policies and stay out of the primary action. |

## Progressive Disclosure

Use visible copy for required decision facts. Use reference info, progressive disclosure, policy links, or support runbooks for optional explanation.

Keep visible:

- final total, payout estimate, fees, discounts, credits, shipping, tax, and wallet credit
- delivery or ship-from status
- blocking validation or recovery copy
- support-safe reference when support may be needed
- primary action for the current decision

Disclose:

- policy detail after the plain-language summary is visible
- support-safe recovery diagnostics
- package details beyond package count and different delivery windows
- payment or payout safety explanation
- refund, reversal, or adjustment detail after the status is visible

Never hide final total, blocking failure copy, payment or payout status, delivery/serviceability status, or the next action behind disclosure.

## Readiness Boundary

Checkout starts only after Buy Cart or Sell List readiness records a customer-safe outcome:

- already ready
- optimization accepted
- optimization declined while the current plan remains valid
- unresolved lines removed
- unresolved lines saved for later
- blocked recovery with no checkout session created

Checkout may display the accepted or declined outcome. If cart/list/source revision, availability, economics, address, serviceability, risk, provider posture, or account facts change after checkout starts, customer copy routes back to cart/list readiness.

## Support References

Support-safe references may expose:

- support-safe reference
- confirmation id
- readiness snapshot version
- reviewed line/action key
- downstream status class

Support and customer copy must not expose raw ids, email addresses, mailing addresses, cookies, session ids, provider payloads, full URLs, card or bank details, or sensitive risk signals.

## Acceptance Use

#1102 owns this contract as the customer-copy baseline. #1115 should cover launch-supported copy through focused route, E2E, visual, mobile, and accessibility checks. #1124 should review policy-sensitive surfaces, and #1122 should review support-reference and operator-recovery copy.
