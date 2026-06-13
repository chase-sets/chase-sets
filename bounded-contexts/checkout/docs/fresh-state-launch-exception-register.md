# Fresh-State Launch Exception Register

Milestone #17 ships fresh-state checkout only. Customer-facing dense checkout routes, old checkout links, old session payload adapters, old sell execution or receipt compatibility, migration or backfill helpers, dual writes, hidden repair, stale fixtures or read models, and provider sandbox leftovers are not allowed to complete Buy Cart or Sell List checkout.

No customer-facing retained legacy checkout artifact is approved for launch.

## Retained Internal Artifacts

| Artifact | Owner | Customer reachable | Permission gate | Rationale | No-side-effect guarantee | Expiration/follow-up |
| --- | --- | --- | --- | --- | --- | --- |
| `checkout-session-deploy-safe-convergence` | Checkout | No | Not applicable; schema bootstrap only | Internal deploy-safe convergence in `features/sessions/read-model/schema.ts` keeps pre-launch environments able to rebuild the fresh `checkout_session_pages` shape while the product remains unlaunched. | Adds nullable or defaulted columns only; no route accepts old session payloads, starts payment, creates orders, creates labels, records payouts, sends notifications, or exposes customer recovery from this artifact. | Remove during final launch cleanup after long-lived environments rebuild from the fresh base schema. |

## Guard

`bounded-contexts/checkout/tests/fresh-schema-cleanup.test.ts` verifies the customer route composition, customer-facing checkout copy, current-flow route docs, and this register. Any new retained artifact must be internal-only, owned, and listed here before launch.
